import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomic, readJson } from "../knowledge-sync/core.js";
import { UsageLedger, type CostSummary } from "../usage/ledger.js";
import { CompletionJournal, type SyncCompletion } from "./journal.js";

export type Destination = { botId: string; recipient: string };
const identifier = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(v);
export const destinationKey = (d: Destination, group = false) => createHash("sha256").update(JSON.stringify(group ? ["group", d.botId, d.recipient] : [d.botId, d.recipient])).digest("hex");
export function syncDestination(env: NodeJS.ProcessEnv): Destination | undefined {
  try {
    const botId = env.WECOM_BOTS ? JSON.parse(env.WECOM_BOTS)[0]?.botId : env.WECOM_BOT_ID;
    const recipient = env.WECOM_NOTIFY_USER_ID?.trim();
    if (env.WECOM_ENABLED === "true" && identifier(botId) && identifier(recipient)) return { botId, recipient };
  } catch { /* Bridge configuration errors never redirect a notification. */ }
}
export function syncGroupDestination(env: NodeJS.ProcessEnv): Destination | undefined {
  try {
    const bots = env.WECOM_BOTS ? JSON.parse(env.WECOM_BOTS) : [{ botId: env.WECOM_BOT_ID }];
    const botId = env.WECOM_SYNC_GROUP_BOT_ID?.trim() || bots[0]?.botId;
    const recipient = env.WECOM_SYNC_GROUP_CHAT_ID?.trim();
    if (env.WECOM_ENABLED === "true" && identifier(botId) && identifier(recipient) && bots.some((b: any) => b.botId === botId)) return { botId, recipient };
  } catch { /* Invalid group configuration cannot redirect a private notice. */ }
}
type Notice = { id: string; text: string; destination: string; claim?: string; until?: number; sent?: boolean };
type State = { version: 1; destination: string; boundary: string; seen: string[]; notices: Notice[] };
const beijing = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value));
const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f<>\[\]*`@]/g, " ").replace(/\s+/g, " ").trim().slice(0, 255);
const labels: Record<string, string> = { published: "已入库", duplicate: "重复/跳过", needs_review: "待人工处理", awaiting_confirmation: "待确认", failed: "失败", stopped: "已停止", interrupted: "已中断", completed: "已结束" };
function briefSummary(value?: string) {
  if (!value) return [];
  // Keep only short readable clauses. Internal paths/keys are not rewritten into
  // invented business facts; the full original remains in the web report.
  const technical = /(?:https?:\/\/|[A-Za-z]:\\|(?:^|\s)[./~]*[\p{L}\p{N}_.-]+[/\\]|[\p{L}\p{N}_.-]+[/\\][\p{L}\p{N}_.-]+|(?:^|\s)\/[\p{L}\p{N}_.-]+|[\w.-]+[ _-]\d{8,14}\b|\b(?:index|SKILL|SYNC_PROMPT)\.md\b|\.(?:jsonl?|md)\b|Current Source Coverage|source[_ ]?(?:Rows?|Key)|oldPaths?|newPath|manifest|路径|节点|覆盖表|索引键|行改为键|\bshared\b)/iu;
  const clauses = value
    .replace(/[（(][^（）()\n]*(?:暂存|后端校验|staged|pending publication)[^（）()\n]*[）)]/gi, "")
    .replace(/[①-⑳]/g, "；")
    .split(/[。；;\n]+|[，,]\s*/)
    .filter(part => !technical.test(part.replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/g, "")))
    .map(part => plain(part).replace(/\bHub\b/gi, "相关资料").replace(/相关资料\s+(?=更新)/g, "相关资料").replace(/^(?:并且|以及|同时|并)\s*/, "").replace(/[：:、\s]+$/, ""))
    .filter(part => part.length >= 4 && !/^(?:SQ[A-Z0-9]+|[A-Z]{1,3}\d[A-Z0-9]*)[\sA-Z0-9._+-]*$/.test(part));
  return [...new Set(clauses)].slice(0, 2).map(part => {
    const chars = [...part]; return chars.length > 72 ? chars.slice(0, 71).join("") + "…" : part;
  });
}
export function costText(cost?: CostSummary) {
  if (!cost) return "费用记录暂不可用，不能视为零消费。";
  const incomplete = cost.unpriced || cost.missingUsage || cost.pending || cost.historyMissing;
  const lines = [`${incomplete ? "已记录部分" : "合计"}：约 ¥${cost.cny.toFixed(6)}（CNY，按请求价格估算）`, `已计价 ${cost.priced}/${cost.requests} 次；缺价格 ${cost.unpriced} 次，缺用量 ${cost.missingUsage} 次。`];
  if (cost.pending) lines.push(`另有 ${cost.pending} 次请求未结算，完成后归入后续区间。`);
  if (cost.historyMissing) lines.push("区间含启用费用记录之前的时间，历史消费不完整。");
  return lines.join("\n");
}
export function formatSyncSummary(event: SyncCompletion) {
  const counts = event.counts;
  const success = counts.published ?? 0, review = (counts.needs_review ?? 0) + (counts.awaiting_confirmation ?? 0);
  const failed = (counts.failed ?? 0) + (counts.interrupted ?? 0) + (counts.stopped ?? 0);
  const unprocessed = Math.max(0, event.total - event.items.length);
  const kind = event.origin === "auto" ? "自动同步" : "同步";
  const title = event.status === "completed" ? `${failed || review || unprocessed ? "⚠️" : "✅"} **${kind}完成${failed || review || unprocessed ? "，部分文件需处理" : ""}**`
    : `${event.status === "failed" ? "❌" : "⚠️"} **${kind}${labels[event.status] ?? "结果"}**`;
  const overview = [`共 ${event.total} 个文件`, `已入库 ${success}`];
  if (failed) overview.push(`失败/中断 ${failed}`);
  if (review) overview.push(`待处理 ${review}`);
  if (counts.duplicate) overview.push(`重复/跳过 ${counts.duplicate}`);
  if (unprocessed) overview.push(`未处理 ${unprocessed}`);
  if (event.status === "completed" && !failed && !review && !unprocessed) overview.push("无失败");
  const rows = event.items.slice(0, 8).map(item => {
    const summary = briefSummary(item.summary);
    return [`📄 **${plain(item.name)}**`, `状态：${labels[item.status] ?? "请查看报告"}`,
      ...(summary.length ? ["", "更新摘要：", ...summary.map(line => `- ${line}`)] : [])].join("\n");
  });
  return [[title, `${beijing(event.finished).replace(/:\d{2}$/, "")}（北京时间）`].join("\n"), `📊 ${overview.join("，")}。`, ...rows,
    `${event.items.length > rows.length ? `其余 ${event.items.length - rows.length} 个文件及` : ""}完整内容请查看网页 Sync reports。`].join("\n\n");
}
export function formatSyncNotice(event: SyncCompletion, from: string, interval?: CostSummary, own?: CostSummary) {
  return [formatSyncSummary(event),
    "", "💰 **模型消费**", "", "消费区间（北京时间）：", `${beijing(from)} →`, beijing(event.finished), "", "**区间模型总消费**", costText(interval), "", "**本次 Sync 模型消费**", costText(own),
    "", "仅统计本系统记录的模型推理；估算金额以服务商账单为准，外部搜索/抓取收费不在此项。", `报告：${event.jobIds.join("、") || event.id}`].join("\n");
}

/** Completion events and boundaries are durable independently of WeCom availability. */
export class SyncNotifications {
  private state!: State;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly file: string;
  constructor(private options: { dataDir: string; destination?: Destination; summaryOnly?: boolean; latest: () => string | undefined; reconcile: () => Promise<void>; now?: () => number }) {
    this.file = path.join(options.dataDir, "sync-notifications", options.summaryOnly ? "group-state.json" : "state.json");
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private serial<T>(fn: () => Promise<T>) { const run = this.tail.then(fn); this.tail = run.catch(() => {}); return run; }
  private save() { return atomic(this.file, JSON.stringify(this.state)); }
  async init() {
    let previous: State | null;
    try {
      previous = await readJson<State | null>(this.file, null);
      if (previous && (previous.version !== 1 || !/^[a-f0-9]{64}$/.test(previous.destination) || !Number.isFinite(Date.parse(previous.boundary)) || !Array.isArray(previous.seen) || previous.seen.some(id => !/^[a-f0-9-]{36}$/.test(id)) || !Array.isArray(previous.notices) || previous.notices.some(n => !n || !/^[a-f0-9-]{36}$/.test(n.id) || n.destination !== previous!.destination || typeof n.text !== "string" || Buffer.byteLength(n.text) > 32768 || n.claim !== undefined && !/^[a-f0-9-]{36}$/.test(n.claim) || n.until !== undefined && !Number.isFinite(n.until)))) throw new Error("Invalid checkpoint.");
    } catch {
      console.warn("Sync notifications paused: invalid checkpoint retained; chat and Sync remain available."); return;
    }
    const destination = this.options.destination;
    if (!destination) return;
    const key = destinationKey(destination, this.options.summaryOnly);
    if (!previous || previous.destination !== key) {
      const existing = await new CompletionJournal(this.options.dataDir).list();
      this.state = { version: 1, destination: key, boundary: this.options.latest() ?? new Date(this.now()).toISOString(), seen: existing.map(e => e.id), notices: [] };
      await this.save();
    } else this.state = previous;
    this.timer = setInterval(() => { void this.refresh().catch(() => console.warn("Sync notification refresh deferred; reports retained.")); }, 5000); this.timer.unref();
    await this.refresh();
  }
  refresh() {
    return this.serial(async () => {
      if (this.closed || !this.state) return;
      await this.options.reconcile();
      const events = await new CompletionJournal(this.options.dataDir).list(new Set(this.state.seen));
      for (const event of events) {
        const from = this.state.boundary <= event.finished ? this.state.boundary : event.finished;
        let text: string;
        if (this.options.summaryOnly) text = formatSyncSummary(event);
        else {
          const ledger = new UsageLedger(this.options.dataDir);
          const total = await ledger.summary(from, event.finished).catch(() => undefined);
          const own = await ledger.summary(new Date(Date.parse(event.started) - 1).toISOString(), event.finished, event.scopes).catch(() => undefined);
          text = formatSyncNotice(event, from, total, own);
        }
        const notice = { id: event.id, destination: this.state.destination, text };
        // Snapshot money and boundary together, before delivering anything.
        const before = structuredClone(this.state);
        this.state.seen.push(event.id); this.state.notices.push(notice);
        if (event.finished > this.state.boundary) this.state.boundary = event.finished;
        try { await this.save(); } catch (error) { this.state = before; throw error; }
      }
    });
  }
  async claim(input: any) {
    const d = this.options.destination;
    if (!d || !this.state || input?.botId !== d.botId || input?.recipient !== d.recipient || !/^[a-f0-9-]{36}$/.test(input?.consumer)) return { notice: null };
    await this.refresh();
    return this.serial(async () => {
      const notice = this.state.notices.find(n => !n.sent && (!n.until || n.until <= this.now()));
      if (!notice) return { notice: null };
      const prior = { ...notice }; notice.claim = randomUUID(); notice.until = this.now() + 60000;
      try { await this.save(); } catch (error) { delete notice.claim; delete notice.until; Object.assign(notice, prior); throw error; }
      return { notice: structuredClone(notice) };
    });
  }
  ack(input: any) {
    return this.serial(async () => {
      const notice = this.state?.notices.find(n => n.id === input?.id && n.claim === input?.claim);
      if (!notice) return { ok: false };
      const prior = notice.sent; notice.sent = true;
      try { await this.save(); } catch (error) { notice.sent = prior; throw error; }
      return { ok: true };
    });
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.tail; }
}
