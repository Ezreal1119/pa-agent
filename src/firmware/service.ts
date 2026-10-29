import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { extractedQuery, type FirmwareQuery } from "./query.js";
import type { FirmwareExtractor } from "./matcher.js";
import { FIRMWARE_MAINTENANCE, validateSearch, type Candidate, type FirmwareClient, type LocalJob } from "./client.js";

export const PROGRESS_MINUTES = [1, 2, 3, 5, 7, 10, 15, 20, 30];
const INPUT_TTL = 5 * 60000;
type Owner = { botId: string; userId: string; chatType: "single" | "group"; target: string };
export type Command = Owner & { msgid: string; text: string; command: boolean };
export type Reply = { text: string; awaiting: boolean; flowId?: string; expiresAt?: number };
type Phase = "filename" | "matching" | "choose" | "confirm" | "starting" | "running" | "cancelling";
type Flow = { id: string; owner: Owner; phase: Phase; expiresAt: number; query?: string; criteria?: FirmwareQuery; matchVersion?: number; candidates: Candidate[]; selected?: Candidate; code?: string; confirmedAt?: number; jobId?: string; snapshot?: LocalJob; notified: number[]; offline?: boolean; invalidResult?: boolean };
export type Notice = { id: string; flowId: string; botId: string; userId: string; chatType: "single" | "group"; target: string; text: string; created: number; prompt?: boolean; expiresAt?: number; claim?: string; claimUntil?: number; sent?: number };
type Database = { version: 1; active?: Flow; replies: Record<string, { owner: string; at: number; value: Reply }>; notices: Notice[] };
export interface FirmwareServiceOptions { dataDir: string; client: FirmwareClient; extractor: FirmwareExtractor; enabled: () => boolean; publicBase: string; now?: () => number; pollMs?: number; }
const ownerKey = (o: Owner) => JSON.stringify([o.botId, o.chatType, o.target, o.userId]);
const safe = (text: string) => text.replace(/[<>\[\]`]/g, "").slice(0, 1500);
function identity(input: unknown): Command {
  const value = input as Command;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["botId", "userId", "chatType", "target", "msgid", "text", "command"].includes(k)) || !["single", "group"].includes(value.chatType) || [value.botId, value.userId, value.target, value.msgid].some(v => typeof v !== "string" || !v || v.length > 256 || /[\s\u0000-\u001f]/u.test(v)) || value.chatType === "single" && value.target !== value.userId || typeof value.text !== "string" || value.text.length > 500 || /[\u0000\r\n]/u.test(value.text) || typeof value.command !== "boolean") throw new Error("Invalid firmware command identity or text.");
  return value;
}
export class FirmwareService {
  private readonly directory: string;
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private matching?: Promise<void>;
  private controllers = new Set<AbortController>();
  private closing = false;
  readonly now: () => number;
  constructor(private readonly options: FirmwareServiceOptions) {
    this.directory = path.join(options.dataDir, "firmware"); this.file = path.join(this.directory, "state.json"); this.now = options.now ?? Date.now;
  }
  async start() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error("Firmware state directory must not be a symlink.");
    await this.change(db => this.expire(db));
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.options.pollMs ?? 5000); this.timer.unref();
    void this.tick().catch(() => {});
  }
  private async read(): Promise<Database> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("Invalid firmware state file.");
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as Database;
      if (value.version !== 1 || !value.replies || !Array.isArray(value.notices) || value.active && (!/^[a-f0-9]{32}$/.test(value.active.id) || !["filename", "matching", "choose", "confirm", "starting", "running", "cancelling"].includes(value.active.phase))) throw new Error("Invalid firmware state; existing tasks were not reset.");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, replies: {}, notices: [] }; throw error; }
  }
  private change<T>(fn: (db: Database) => T): Promise<T> {
    const work = this.tail.then(async () => {
      const release = await lockfile.lock(this.directory, { realpath: false, stale: 30000, update: 5000, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } });
      try {
        const db = await this.read(); const result = fn(db);
        const serialized = JSON.stringify(db); if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error("Firmware state capacity exceeded.");
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try { const handle = await fs.open(temporary, "wx", 0o600); try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); } await fs.rename(temporary, this.file); }
        finally { await fs.rm(temporary, { force: true }); }
        return result;
      } finally { await release(); }
    });
    this.tail = work.catch(() => {}); return work;
  }
  private notice(db: Database, flow: Flow, text: string, prompt = false) {
    db.notices.push({ id: randomUUID(), flowId: flow.id, ...flow.owner, text, created: this.now(), ...(prompt ? { prompt: true, expiresAt: flow.expiresAt } : {}) });
  }
  private clearPrompts(db: Database, id: string) { db.notices = db.notices.filter(n => n.flowId !== id || !n.prompt || n.sent); }
  private expire(db: Database) {
    db.replies = Object.fromEntries(Object.entries(db.replies).filter(([, r]) => r.at > this.now() - 86400000).slice(-500));
    db.notices = db.notices.filter(n => !n.sent || n.sent > this.now() - 86400000);
    const flow = db.active;
    if (flow && !["starting", "running", "cancelling"].includes(flow.phase) && flow.matchVersion !== 2) {
      this.clearPrompts(db, flow.id); this.notice(db, flow, "固件查询规则已更新，旧的未确认流程已结束，请重新发送 /firmware。"); delete db.active; return;
    }
    if (flow && !["starting", "running", "cancelling"].includes(flow.phase) && flow.expiresAt <= this.now()) {
      this.clearPrompts(db, flow.id); this.notice(db, flow, "固件流程已超时退出，请重新发送 /firmware。"); delete db.active;
    }
  }
  private preview(flow: Flow): Reply {
    if (flow.phase === "filename") return { text: "请输入 OS 固件需求，例如“帮我下载 SQ68MB 的 260422_01 固件”，也可以发送完整文件名。需包含 SQ 型号、六位日期和两位 index；输入“取消”退出，5 分钟内有效。", awaiting: true, flowId: flow.id, expiresAt: flow.expiresAt };
    if (flow.phase === "matching") return { text: "正在由 AI 提取型号、日期和 index，并查询 FTP 精确匹配，请稍候。", awaiting: true, flowId: flow.id, expiresAt: flow.expiresAt };
    if (flow.phase === "confirm") {
      const c = flow.selected!;
      return { text: `是否下载并上传以下 OS 包？\n\n${c.filename}\nFTP 路径：${safe(c.path)}\n大小：${(c.size / 1024 / 1024).toFixed(1)} MiB\n${c.differences.length ? "与输入的差异：" + c.differences.map(safe).join("；") : "型号、日期和 index 全部匹配"}\n\n回复“确认 ${flow.code}”开始，输入“取消”退出。5 分钟内有效。`, awaiting: true, flowId: flow.id, expiresAt: flow.expiresAt };
    }
    return { text: this.progress(flow), awaiting: false, flowId: flow.id };
  }
  private select(flow: Flow, c: Candidate) { flow.selected = c; flow.phase = "confirm"; flow.code = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase(); flow.expiresAt = this.now() + INPUT_TTL; }
  async command(input: unknown): Promise<Reply> {
    const cmd = identity(input);
    const unavailable = { text: FIRMWARE_MAINTENANCE, awaiting: false };
    // No command may acquire/confirm a new transfer while disabled or offline.
    if (!this.options.enabled() || !await this.options.client.ready()) return unavailable;
    const key = createHash("sha256").update(JSON.stringify([cmd.botId, cmd.msgid])).digest("hex");
    const reply = await this.change(db => {
      this.expire(db);
      if (!this.options.enabled()) return unavailable;
      const prior = db.replies[key];
      if (prior) { if (prior.owner !== ownerKey(cmd)) throw new Error("Message identity mismatch."); return prior.value; }
      let flow = db.active;
      let answer: Reply;
      const text = cmd.text.trim();
      if (flow && ownerKey(flow.owner) !== ownerKey(cmd)) answer = { text: "当前有固件任务处理中，请稍后再试。", awaiting: false };
      else {
        if (!flow) {
          if (!cmd.command) answer = { text: "固件流程已结束或超时，请重新发送 /firmware。", awaiting: false };
          else {
            flow = { id: randomUUID().replaceAll("-", ""), owner: { botId: cmd.botId, userId: cmd.userId, target: cmd.target, chatType: cmd.chatType }, phase: "filename", matchVersion: 2, expiresAt: this.now() + INPUT_TTL, candidates: [], notified: [] };
            db.active = flow;
          }
        }
        if (flow) {
          if (/^(取消|cancel)$/i.test(text)) {
            this.clearPrompts(db, flow.id);
            if (["starting", "running", "cancelling"].includes(flow.phase)) { flow.phase = "cancelling"; answer = { text: "已请求取消，正在确认本机任务停止。", awaiting: false, flowId: flow.id }; }
            else { delete db.active; answer = { text: "已取消固件流程。", awaiting: false }; }
          } else if (!text || text === "状态" || ["matching", "starting", "running", "cancelling"].includes(flow.phase)) answer = this.preview(flow);
          else if (flow.phase === "confirm") {
            if (text.match(/^确认\s+([A-F0-9]{6})$/i)?.[1]?.toUpperCase() === flow.code) {
              this.clearPrompts(db, flow.id); flow.phase = "starting"; flow.confirmedAt = this.now();
              answer = { text: `已确认 ${flow.selected!.filename}，正在提交本机下载与 R2 上传任务。完成后返回下载链接。`, awaiting: false, flowId: flow.id };
            } else answer = { ...this.preview(flow), text: "尚未开始，请使用本次确认码。\n\n" + this.preview(flow).text };
          } else {
            flow.query = text; flow.phase = "matching"; flow.expiresAt = this.now() + 120000; answer = this.preview(flow);
          }
        }
      }
      const value = answer!; db.replies[key] = { owner: ownerKey(cmd), at: this.now(), value }; return value;
    });
    void this.tick().catch(() => {});
    return reply;
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.ticking ??= this.poll().finally(() => { this.ticking = undefined; });
  }
  private async poll() {
    const flow = await this.change(db => { this.expire(db); return db.active ? structuredClone(db.active) : undefined; });
    if (!flow) return;
    if (flow.phase === "matching") {
      if (!this.matching) this.matching = this.match(flow).catch(() => {}).finally(() => { this.matching = undefined; });
      return;
    }
    if (!["starting", "running", "cancelling"].includes(flow.phase)) return;
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      let job = flow.jobId ? await this.options.client.job(flow.jobId, controller.signal) : await this.options.client.lookup(`firmware:${flow.id}`, controller.signal);
      if (!job) {
        if (flow.phase === "cancelling" || !this.options.enabled()) {
          await this.change(db => { if (db.active?.id === flow.id) { this.notice(db, db.active, "固件任务尚未创建，已取消本次请求。"); delete db.active; } }); return;
        }
        if (!await this.options.client.ready(controller.signal)) throw new Error("offline");
        const allowed = await this.change(db => db.active?.id === flow.id && db.active.phase === "starting" && this.options.enabled());
        if (!allowed) return;
        job = await this.options.client.submit(flow.selected!.id, `firmware:${flow.id}`, controller.signal);
      }
      if (job.candidate.path !== flow.selected?.path || job.candidate.filename !== flow.selected?.filename || job.candidate.size !== flow.selected?.size || job.candidate.modified !== flow.selected?.modified) throw new Error("Local task does not match the confirmed candidate.");
      if (flow.phase === "cancelling" && !["cancelled", "failed", "succeeded"].includes(job.state)) job = await this.options.client.cancel(job.id, controller.signal);
      await this.change(db => {
        const current = db.active; if (!current || current.id !== flow.id) return;
        current.jobId = job.id; current.snapshot = job;
        if (current.offline) { current.offline = false; this.notice(db, current, "本机固件服务已恢复，继续跟踪原任务。\n" + this.progress(current)); }
        if (["succeeded", "failed", "cancelled"].includes(job.state)) {
          let text: string;
          if (job.state === "succeeded") {
            const result = job.result;
            const encodedName = encodeURIComponent(current.selected!.filename).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
            const expected = this.options.publicBase.replace(/\/$/, "") + "/" + encodedName;
            if (!result?.uploaded || result.filename !== current.selected!.filename || result.size !== current.selected!.size || result.download_url !== expected) { if (!current.invalidResult) { current.invalidResult = true; this.notice(db, current, "固件结果校验未通过，任务仍保留，未返回下载链接。请管理员检查。"); } return; }
            text = `OS 包下载并上传完成：\n${result.filename}\n\n下载链接：\n${result.download_url}`;
          } else text = job.state === "cancelled" ? "固件任务已取消。" : "固件下载或上传失败，未生成下载链接。请重新发送 /firmware 重试。";
          this.notice(db, current, text); delete db.active; return;
        }
        if (current.phase !== "cancelling") current.phase = "running";
        const minutes = (this.now() - current.confirmedAt!) / 60000;
        const due = PROGRESS_MINUTES.filter(m => m <= minutes && !current.notified.includes(m));
        const after30 = minutes >= 30 ? Math.floor((minutes - 30) / 10) * 10 + 30 : 0;
        if (after30 > 30 && !current.notified.includes(after30)) due.push(after30);
        if (due.length) { current.notified.push(...due); this.notice(db, current, this.progress(current)); }
      });
    } catch {
      if (!this.closing) await this.change(db => { const current = db.active; if (current?.id === flow.id && !current.offline) { current.offline = true; this.notice(db, current, "固件功能维护中，当前任务已保留；本机服务恢复后继续反馈。"); } });
    } finally { this.controllers.delete(controller); }
  }
  private async match(flow: Flow) {
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
    try {
      if (!this.options.enabled()) throw new Error("disabled");
      const extracted = await this.options.extractor(flow.query!, signal);
      const criteria = extracted === null ? null : extractedQuery(extracted, flow.query!);
      if (!criteria) {
        await this.change(db => { const current = db.active; if (current?.id === flow.id && current.phase === "matching") { this.clearPrompts(db, current.id); this.notice(db, current, "无法确定唯一的 SQ 型号、六位日期和两位 index。请补齐或澄清条件后重新发送 /firmware。本次任务已结束，未开始下载。"); delete db.active; } });
        return;
      }
      // Recheck ownership/state after the model request, before opening FTP.
      if (!await this.change(db => db.active?.id === flow.id && db.active.phase === "matching" && this.options.enabled())) return;
      const result = validateSearch(await this.options.client.search(criteria, signal), criteria);
      const candidates = result.candidates;
      await this.change(db => {
        const current = db.active; if (current?.id !== flow.id || current.phase !== "matching") return;
        if (!this.options.enabled()) { this.notice(db, current, FIRMWARE_MAINTENANCE); delete db.active; return; }
        this.clearPrompts(db, current.id);
        if (!result.complete) { this.notice(db, current, "FTP 目录或文件信息查询不完整，无法确定匹配数量。本次任务已结束，未下载，请稍后重新发送 /firmware。"); delete db.active; return; }
        const summary = `${criteria.model} / ${criteria.date}_${criteria.index}`;
        if (!result.total) { this.notice(db, current, `未找到同时匹配 ${summary} 的 OS 包。本次任务已结束，未开始下载。`); delete db.active; return; }
        if (result.total > 1) {
          const list = candidates.map((c, i) => `${i + 1}. ${c.filename}\nFTP 路径：${safe(c.path)}`).join("\n\n");
          this.notice(db, current, `找到 ${result.total} 个同时匹配 ${summary} 的 OS 包：\n\n${list}${result.truncated ? "\n\n仅展示前 12 个匹配项。" : ""}\n\n无法唯一确定固件，本次任务已结束，未开始下载。`); delete db.active; return;
        }
        current.criteria = criteria; current.candidates = candidates; this.select(current, candidates[0]!);
        this.notice(db, current, this.preview(current).text, true);
      });
    } catch {
      if (!this.closing) await this.change(db => { if (db.active?.id === flow.id && db.active.phase === "matching") { this.notice(db, db.active, "固件条件提取或 FTP 查询未完成，本次任务已结束，未开始下载。请重新发送 /firmware 重试。"); delete db.active; } });
    } finally { this.controllers.delete(controller); }
  }
  private progress(flow: Flow) {
    const job = flow.snapshot;
    const stages: Record<string, string> = { queued: "排队中", finding: "查找文件", downloading: "从 FTP 下载到本机", verifying: "校验下载文件", uploading: "上传到 R2", verifying_upload: "校验 R2 对象", retry_wait: "等待自动重试", interrupted: "等待恢复", failed: "失败" };
    const total = job?.total_bytes ?? flow.selected?.size ?? 0, bytes = job?.bytes ?? 0;
    const percent = total ? Math.max(0, Math.min(100, bytes / total * 100)).toFixed(1) + "%" : "未知";
    return `固件任务：${flow.selected?.filename ?? flow.query ?? "等待文件名"}\n阶段：${flow.phase === "cancelling" ? "正在取消" : stages[job?.stage ?? ""] ?? "正在提交任务"}\n当前阶段进度：${percent}（${(bytes / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB）${job?.speed_bytes_per_second ? `\n速度：${(job.speed_bytes_per_second / 1024 / 1024).toFixed(2)} MiB/s` : ""}`;
  }
  async claim(input: unknown) {
    const { botIds, consumer } = input as {botIds: string[]; consumer: string};
    if (!Array.isArray(botIds) || botIds.length > 20 || botIds.some(b => typeof b !== "string" || !b || b.length > 256) || typeof consumer !== "string" || !/^[a-f0-9-]{36}$/.test(consumer)) throw new Error("Invalid firmware notice claim.");
    return this.change(db => {
      this.expire(db);
      const notice = db.notices.find(n => !n.sent && botIds.includes(n.botId) && (!n.claimUntil || n.claimUntil <= this.now()));
      if (!notice) return { notice: null };
      notice.claim = randomUUID(); notice.claimUntil = this.now() + 60000;
      return { notice: { ...notice } };
    });
  }
  async ack(input: unknown) {
    const { id, claim } = input as {id: string; claim: string};
    return this.change(db => { const notice = db.notices.find(n => n.id === id); if (!notice || notice.claim !== claim) return { ok: false }; notice.sent ??= this.now(); return { ok: true }; });
  }
  async close() { this.closing = true; clearInterval(this.timer); for (const c of this.controllers) c.abort(); await Promise.allSettled([this.ticking, this.matching]); await this.tail; }
}
