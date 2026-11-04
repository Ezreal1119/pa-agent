import fs from "node:fs/promises";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { ModelConfig } from "../config.js";
import { ReviewStore, read, write } from "./store.js";
import { ReviewSocket } from "./transport.js";
import { nextDue, previousDayRange } from "./schedule.js";
import { digest } from "./privacy.js";
import { defaults, settingsSchema, runInput, emptyCoverage, ReviewError, publicRun, categoryLabels, type ReviewRun, type ReviewSettings, type PublicRun } from "./types.js";

type State = { version: 1; settings: ReviewSettings; nextDueAt?: string };
type RequestMap = Record<string, { id: string; fingerprint: string }>;
export interface ReviewServiceOptions { dataDir: string; resourcesDir: string; model: () => ModelConfig; pricing?: () => string | undefined; now?: () => number; workerFile?: string; }
export class QuestionReviewService {
  readonly store: ReviewStore;
  private state: State = { version: 1, settings: { ...defaults } };
  private problem?: string;
  private closed = false;
  private requests: RequestMap = Object.create(null);
  private active?: { id: string; child: ChildProcess; done: Promise<void>; stop?: "cancelled" | "interrupted" | "partial" };
  private timer?: ReturnType<typeof setInterval>;
  private socket?: ReviewSocket;
  private unlock?: () => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private options: ReviewServiceOptions) { this.store = new ReviewStore(options.dataDir); }
  private now() { return this.options.now?.() ?? Date.now(); }
  private serial<T>(f: () => Promise<T>) { const result = this.tail.then(f); this.tail = result.catch(() => {}); return result; }
  private available() { if (this.closed || this.problem) throw new ReviewError(503, "Question review is unavailable; existing data retained"); }
  async init() {
    try {
      await this.store.init();
      this.unlock = await lockfile.lock(this.store.root, { realpath: false, retries: 0, stale: 10000, lockfilePath: path.join(this.store.root, ".service.lock"), onCompromised: () => { this.problem = "Review ownership lost"; void this.stopChild("interrupted"); } });
      this.state = await read<State>(path.join(this.store.root, "settings.json"), this.state);
      if (this.state.version !== 1) throw new Error("Invalid review settings");
      this.state.settings = settingsSchema.parse(this.state.settings);
      if (this.state.nextDueAt && !Number.isFinite(Date.parse(this.state.nextDueAt))) throw new Error("Invalid schedule checkpoint");
      const requests = await read<RequestMap>(path.join(this.store.root, "requests.json"), {});
      if (!requests || typeof requests !== "object" || Array.isArray(requests)) throw new Error("Invalid review requests");
      this.requests = Object.assign(Object.create(null), requests);
      if (!this.requests || typeof this.requests !== "object" || Array.isArray(this.requests) || Object.entries(this.requests).some(([id, value]) => !/^[a-zA-Z0-9_-]{8,128}$/.test(id) || !/^[a-f0-9-]{36}$/.test(value?.id) || !/^[a-f0-9]{64}$/.test(value?.fingerprint))) throw new Error("Invalid review requests");
      for (const run of await this.store.all()) if (["queued", "running"].includes(run.status)) { run.status = "interrupted"; run.reason = "服务重启，保留完成批次，需手动重试。"; run.finishedAt = new Date(this.now()).toISOString(); await this.store.save(run); }
      // Reconcile a crash between writing the run and the idempotency index.
      for (const run of await this.store.all()) this.requests[run.requestId] ??= { id: run.id, fingerprint: run.requestFingerprint ?? digest(JSON.stringify([run.from, run.to, null])) };
      await fs.rm(path.join(this.store.root, "runtime"), { recursive: true, force: true });
      if (this.state.settings.enabled && !this.state.nextDueAt) this.state.nextDueAt = nextDue(this.state.settings, this.now());
      this.socket = new ReviewSocket(path.join(this.store.root, "control.sock"), input => this.dispatch(input)); await this.socket.listen();
      this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30000); this.timer.unref();
    } catch {
      this.problem = "Review initialization unavailable; checkpoints retained";
      await this.socket?.close().catch(() => {}); await this.unlock?.().catch(() => {}); this.unlock = undefined;
    }
  }
  status() { return { available: !this.problem && !this.closed, settings: structuredClone(this.state.settings), nextDueAt: this.state.nextDueAt ?? null, activeRunId: this.active?.id ?? null, ...(this.problem ? { error: this.problem } : {}) }; }
  async configure(input: unknown) {
    return this.serial(async () => {
      this.available(); const parsed = settingsSchema.safeParse(input); if (!parsed.success) throw new ReviewError(400, "Invalid review settings");
      const state: State = { version: 1, settings: parsed.data, nextDueAt: nextDue(parsed.data, this.now()) };
      await write(path.join(this.store.root, "settings.json"), state); this.state = state; return this.status();
    });
  }
  async start(input: unknown) { return this.serial(() => this.create(input)); }
  private async create(input: unknown, scheduleDate?: string) {
    this.available(); const parsed = runInput.safeParse(input); if (!parsed.success) throw new ReviewError(400, "Invalid review range or request ID");
    const body = parsed.data, from = new Date(body.from).toISOString(), to = new Date(body.to).toISOString();
    if (Date.parse(to) > this.now() + 1000) throw new ReviewError(400, "Review range cannot include the future");
    const fingerprint = digest(JSON.stringify([from, to, body.retryRunId ?? null])), prior = this.requests[body.requestId];
    if (prior) { if (prior.fingerprint !== fingerprint) throw new ReviewError(409, "Request ID already used for a different review"); return publicRun(await this.store.get(prior.id)); }
    if (this.active) throw new ReviewError(409, "Another question review is running");
    const model = { ...this.options.model() };
    if (!model.apiKey || !model.baseUrl || !model.modelId || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 16000 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new ReviewError(503, "Configure the existing question-answering model first");
    let run: ReviewRun;
    if (body.retryRunId) {
      run = await this.store.get(body.retryRunId);
      if (!["partial", "interrupted", "cancelled", "failed"].includes(run.status) || run.from !== from || run.to !== to) throw new ReviewError(409, "Only an unfinished review of the same range can be retried");
      run = { ...run, requestId: body.requestId, settings: structuredClone(this.state.settings), modelId: model.modelId, status: "queued", finishedAt: undefined, reason: undefined };
    } else run = { version: 1, id: randomUUID(), requestId: body.requestId, from, to, createdAt: new Date(this.now()).toISOString(), status: "queued", settings: structuredClone(this.state.settings), modelId: model.modelId, modelRequests: 0, coverage: emptyCoverage(), questions: [], processed: [], scheduleDate };
    run.requestFingerprint = fingerprint;
    await this.store.save(run); this.requests[body.requestId] = { id: run.id, fingerprint };
    await write(path.join(this.store.root, "requests.json"), this.requests);
    run.status = "running"; await this.store.save(run);
    this.launch(run, model); return publicRun(run);
  }
  private launch(run: ReviewRun, model: ModelConfig) {
    const worker = this.options.workerFile ?? new URL("./worker.js", import.meta.url);
    const child = fork(worker, [], { execArgv: ["--max-old-space-size=256"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let resolve!: () => void;
    const active = { id: run.id, child, done: new Promise<void>(r => { resolve = r; }), stop: undefined as "cancelled" | "interrupted" | "partial" | undefined };
    this.active = active;
    const watchdog = setTimeout(() => { active.stop = "partial"; child.send({ operation: "timeout" }, () => {}); }, run.settings.maxDurationMs + 1000);
    const kill = setTimeout(() => child.kill("SIGKILL"), run.settings.maxDurationMs + 16000);
    let finished = false;
    const exited = async () => {
      if (finished) return; finished = true; clearTimeout(watchdog); clearTimeout(kill);
      try {
        const latest = await this.store.get(run.id);
        if (["running", "queued"].includes(latest.status)) { latest.status = active.stop ?? "failed"; latest.reason = "评审进程退出，已保存批次保留；未完成部分需重试。"; latest.finishedAt = new Date().toISOString(); await this.store.save(latest); }
      } catch { this.problem = "Review checkpoint unavailable; original retained"; }
      finally {
        await fs.rm(path.join(this.store.root, "runtime"), { recursive: true, force: true }).catch(() => {});
        if (this.active === active) this.active = undefined; resolve();
      }
    };
    child.once("error", () => { void exited(); }); child.once("exit", () => { void exited(); });
    child.send({ operation: "run", dataDir: this.options.dataDir, resourcesDir: this.options.resourcesDir, model, pricing: this.options.pricing?.(), runId: run.id }, () => {});
  }
  async stopChild(reason: "cancelled" | "interrupted") {
    const active = this.active; if (!active) return;
    active.stop = reason;
    if (reason === "cancelled") active.child.send({ operation: "cancel" }, () => {}); else active.child.kill("SIGTERM");
    const kill = setTimeout(() => active.child.kill("SIGKILL"), 5000);
    try { await active.done; } finally { clearTimeout(kill); }
  }
  async cancel(id: string) { this.available(); await this.store.get(id); if (this.active?.id === id) await this.stopChild("cancelled"); return publicRun(await this.store.get(id)); }
  async get(id: string) { this.available(); return publicRun(await this.store.get(id)); }
  async list() { this.available(); return (await this.store.list()).map(({ questions, ...run }) => ({ ...run, questionCount: questions.length })); }
  async tick() {
    return this.serial(async () => {
      this.available(); const due = this.state.nextDueAt && Date.parse(this.state.nextDueAt), now = this.now();
      if (!this.state.settings.enabled || !due || due > now) return;
      this.state.nextDueAt = nextDue(this.state.settings, now); await write(path.join(this.store.root, "settings.json"), this.state);
      // No history backfill or retry storm after downtime; dispatch the due day only.
      if (now - due > 120000 || this.active) return;
      const window = previousDayRange(due, this.state.settings.timeZone);
      await this.create({ from: window.from, to: window.to, requestId: "schedule_" + digest(this.state.settings.timeZone + window.date).slice(0, 40) }, window.date);
    });
  }
  async export(id: string, format: "json" | "markdown") { const run = await this.get(id); return format === "json" ? JSON.stringify(run, null, 2) : markdown(run); }
  async dispatch(value: unknown): Promise<unknown> {
    const base = z.object({ op: z.enum(["settings.get", "settings.put", "runs.start", "runs.list", "runs.get", "runs.cancel", "runs.export"]), input: z.unknown().optional(), id: z.string().uuid().optional(), format: z.enum(["json", "markdown"]).optional() }).strict().safeParse(value);
    if (!base.success) throw new ReviewError(400, "Invalid review operation");
    const v = base.data;
    if (v.op === "settings.get") return this.status();
    if (v.op === "settings.put") return this.configure(v.input);
    if (v.op === "runs.start") return this.start(v.input);
    if (v.op === "runs.list") return this.list();
    if (!v.id) throw new ReviewError(400, "Review ID required");
    if (v.op === "runs.get") return this.get(v.id);
    if (v.op === "runs.cancel") return this.cancel(v.id);
    return this.export(v.id, v.format ?? "markdown");
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await this.tail; await this.socket?.close().catch(() => {}); await this.stopChild("interrupted"); await this.unlock?.().catch(() => {}); this.unlock = undefined;
  }
}
export function markdown(run: PublicRun) {
  const c = run.coverage;
  return [`# 通用待核实问题列表`, `评审范围：${run.from} → ${run.to}`, `状态：${run.status}`, `扫描 ${c.scanned}；符合评审条件 ${c.eligible}；已评审 ${c.reviewed}；未完成 ${c.remaining}；隐私暂缓 ${c.privacyHeld}。`,
    `未完成问答 ${c.unfinished}；损坏记录 ${c.corrupt}；不可用 ${c.unavailable}；超限 ${c.oversized}；依据不完整 ${c.evidenceLimited}。`, run.reason ?? "",
    ...run.questions.map((q, i) => [`## ${i + 1}. ${q.question}`, `类型：${categoryLabels[q.category]}｜状态：待核实｜本次出现：${q.occurrences}`, `涉及型号/版本（待核实）：${[...q.products, ...q.versions].join("、") || "通用产品问题"}`, `疑点或缺口：${q.explanation}`, `评审依据与局限：${q.evidence}`, `问题 ID：${q.id}`].join("\n\n")),
    ...(run.questions.length ? [] : [run.status === "completed" ? "本次未形成通过隐私校验的待核实问题。" : "当前列表为空，不代表全部问答均无问题。"]),
  ].filter(Boolean).join("\n\n");
}
