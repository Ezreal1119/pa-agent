import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomic, readJson } from "../knowledge-sync/core.js";
import { UsageLedger, type CostSummary } from "../usage/ledger.js";
import { CompletionJournal, type SyncCompletion } from "./journal.js";

export type Destination = { botId: string; recipient: string };
const identifier = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(v);
export const destinationKey = (d: Destination) => createHash("sha256").update(JSON.stringify([d.botId, d.recipient])).digest("hex");
export function syncDestination(env: NodeJS.ProcessEnv): Destination | undefined {
  try {
    const botId = env.WECOM_BOTS ? JSON.parse(env.WECOM_BOTS)[0]?.botId : env.WECOM_BOT_ID;
    const recipient = env.WECOM_NOTIFY_USER_ID?.trim();
    if (env.WECOM_ENABLED === "true" && identifier(botId) && identifier(recipient)) return { botId, recipient };
  } catch { /* Bridge configuration errors never redirect a notification. */ }
}
type Notice = { id: string; text: string; destination: string; claim?: string; until?: number; sent?: boolean };
type State = { version: 1; destination: string; boundary: string; seen: string[]; notices: Notice[] };
const beijing = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium", hour12: false }).format(new Date(value));
const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f<>\[\]*_`@]/g, " ").slice(0, 240);
const labels: Record<string, string> = { published: "已入库", duplicate: "重复/跳过", needs_review: "待人工处理", awaiting_confirmation: "待确认", failed: "失败", stopped: "已停止", interrupted: "已中断", completed: "已结束" };
export function costText(cost?: CostSummary) {
  if (!cost) return "费用记录暂不可用，不能视为零消费。";
  const incomplete = cost.unpriced || cost.missingUsage || cost.pending || cost.historyMissing;
  const lines = [`${incomplete ? "已记录部分" : "合计"}：约 ¥${cost.cny.toFixed(6)}（CNY，按请求价格估算）`, `已计价 ${cost.priced}/${cost.requests} 次；缺价格 ${cost.unpriced} 次，缺用量 ${cost.missingUsage} 次。`];
  if (cost.pending) lines.push(`另有 ${cost.pending} 次请求未结算，完成后归入后续区间。`);
  if (cost.historyMissing) lines.push("区间含启用费用记录之前的时间，历史消费不完整。");
  return lines.join("\n");
}
export function formatSyncNotice(event: SyncCompletion, from: string, interval?: CostSummary, own?: CostSummary) {
  const counts = event.counts;
  const success = counts.published ?? 0, review = (counts.needs_review ?? 0) + (counts.awaiting_confirmation ?? 0);
  const failed = (counts.failed ?? 0) + (counts.interrupted ?? 0) + (counts.stopped ?? 0);
  const unprocessed = Math.max(0, event.total - event.items.length);
  const rows = event.items.slice(0, 8).map(item => `· ${plain(item.name)}：${labels[item.status] ?? plain(item.status)}${item.summary ? "；" + plain(item.summary) : ""}`);
  return [`Sync ${event.origin === "auto" ? "自动同步" : "同步"}结果`, `结束时间（北京时间）：${beijing(event.finished)}`, `状态：${labels[event.status] ?? plain(event.status)}`, `文件 ${event.total} 个：已入库 ${success}，失败/中断 ${failed}，待处理 ${review}，重复/跳过 ${counts.duplicate ?? 0}，未处理 ${unprocessed}。`, ...rows,
    ...(event.items.length > rows.length ? [`其余 ${event.items.length - rows.length} 个文件请查看 Sync reports。`] : []),
    "", `消费区间（北京时间）：${beijing(from)} → ${beijing(event.finished)}`, "区间模型总消费：", costText(interval), "", "本次 Sync 模型消费：", costText(own),
    "", "仅统计本系统记录的模型推理；估算金额以服务商账单为准，外部搜索/抓取收费不在此项。", `报告：${event.jobIds.join("、") || event.id}`].join("\n");
}

/** Completion events and boundaries are durable independently of WeCom availability. */
export class SyncNotifications {
  private state!: State;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly file: string;
  constructor(private options: { dataDir: string; destination?: Destination; latest: () => string | undefined; reconcile: () => Promise<void>; now?: () => number }) {
    this.file = path.join(options.dataDir, "sync-notifications", "state.json");
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
    const key = destinationKey(destination);
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
        const ledger = new UsageLedger(this.options.dataDir);
        const total = await ledger.summary(from, event.finished).catch(() => undefined);
        const own = await ledger.summary(new Date(Date.parse(event.started) - 1).toISOString(), event.finished, event.scopes).catch(() => undefined);
        const notice = { id: event.id, destination: this.state.destination, text: formatSyncNotice(event, from, total, own) };
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
