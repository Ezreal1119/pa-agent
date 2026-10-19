import { createHash } from "node:crypto";
import { McpStore, terminal, uuid, type McpTask, type TaskAnswer } from "./store.js";
import type { mcpConfig } from "./config.js";
import type { RunMetric } from "../web/run-metrics.js";
export interface AskArguments { question: string; conversation_id?: string; request_id?: string; }
export interface McpHost {
  run(task: McpTask, question: string, signal: AbortSignal, update: (metric: RunMetric) => Promise<void>): Promise<TaskAnswer & { status?: McpTask["status"] }>;
  recover(task: McpTask, needsAnswer: boolean): Promise<{ metric?: RunMetric; answer?: TaskAnswer }>;
  redact(error: unknown): string;
}
export class McpService {
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopping = false;
  private sweep?: NodeJS.Timeout;
  constructor(readonly store: McpStore, readonly config: ReturnType<typeof mcpConfig>, private host: McpHost) {}
  async start() {
    await this.store.load();
    for (const task of this.store.tasks().sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
      // JSONL usage snapshots are authoritative if a crash preceded metadata persistence.
      const cached = await this.store.answer(task.id);
      const recovered = await this.host.recover(task, !cached);
      if (recovered.metric) await this.record(task.id, recovered.metric, true);
      const current = await this.store.get(task.id);
      if (!terminal(current.status)) {
        const snapshot = cached?.snapshot;
        if (snapshot && terminal(snapshot.status)) await this.store.update(task.id, { status: snapshot.status, usage: current.usage, toolCalls: Math.max(current.toolCalls, snapshot.toolCalls), finished: snapshot.finished, elapsedMs: snapshot.elapsedMs });
        else await this.store.update(task.id, { status: recovered.metric && recovered.metric.status !== "running" ? recovered.metric.status === "stopped" ? "cancelled" : recovered.metric.status : "interrupted", finished: Date.now() }, recovered.answer ?? { answer: "", error: "The service restarted before this task finished. It was not automatically replayed; recorded token usage is preserved." });
      } else if (!cached && recovered.answer) await this.store.update(task.id, {}, recovered.answer);
    }
    await this.store.cleanup();
    this.sweep = setInterval(() => void this.store.cleanup().catch(error => console.error("MCP cleanup:", this.host.redact(error))), 3600000); this.sweep.unref();
  }
  private async record(id: string, metric: RunMetric, recovering = false) {
    const old = await this.store.get(id); const usage = metric.usage;
    if (!usage || usage.requests < old.usage.requests || usage.input < old.usage.input || usage.output < old.usage.output || usage.reportedRequests < old.usage.reportedRequests) return;
    const status = metric.status === "running" ? "running" : metric.status === "stopped" ? "cancelled" : metric.status;
    // getRunMetrics treats unfinished logs as interrupted after restart, even if an answer was atomically saved.
    const changes = { usage, modelId: metric.modelId, started: Date.parse(metric.startedAt), toolCalls: Math.max(old.toolCalls, metric.toolCalls?.length ?? 0), elapsedMs: recovering && terminal(old.status) ? old.elapsedMs : metric.elapsedMs, ...(metric.finishedAt && !(recovering && terminal(old.status)) ? { finished: Date.parse(metric.finishedAt) } : {}), ...(!terminal(old.status) && status === "running" ? { status: "running" as const } : {}) };
    if (Object.entries(changes).every(([key, value]) => JSON.stringify(old[key as keyof McpTask]) === JSON.stringify(value))) return;
    await this.store.update(id, changes);
  }
  async ask(args: AskArguments) {
    if (this.stopping) throw new Error("The MCP service is shutting down.");
    if (typeof args.question !== "string" || !args.question.trim() || args.question.length > 12000) throw new Error("Provide a non-empty text question of at most 12000 characters.");
    if (args.conversation_id !== undefined && !uuid(args.conversation_id) || args.request_id !== undefined && !uuid(args.request_id)) throw new Error("conversation_id and request_id must be server-issued or random UUIDs.");
    const submitted = await this.store.submit(createHash("sha256").update(args.question).digest("hex"), args.conversation_id, args.request_id, this.config.pendingLimit);
    const task = submitted.task;
    if (!submitted.duplicate) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("MCP task time limit reached.")), this.config.taskTimeoutMs); timer.unref();
      const done = (async () => {
        try {
          const result = await this.host.run(task, args.question, controller.signal, metric => this.record(task.id, metric));
          const current = await this.store.get(task.id);
          const state = controller.signal.aborted ? "cancelled" : result.status ?? (terminal(current.status) ? current.status : "completed");
          const answer = result.answer.slice(0, 256000);
          await this.store.update(task.id, { status: state, finished: Date.now() }, { ...result, answer, ...(result.answer.length > answer.length ? { truncated: true } : {}) });
        } catch (error) {
          const current = await this.store.get(task.id);
          await this.store.update(task.id, { status: controller.signal.aborted ? "cancelled" : terminal(current.status) ? current.status : "failed", finished: Date.now() }, { answer: "", error: this.host.redact(controller.signal.aborted ? controller.signal.reason ?? error : error) });
        } finally { clearTimeout(timer); this.active.delete(task.id); }
      })().catch(error => console.error("MCP task persistence:", this.host.redact(error)));
      this.active.set(task.id, { controller, done });
    }
    const pending = this.active.get(task.id)?.done;
    if (pending && this.config.waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, this.config.waitMs); })]); }
      finally { clearTimeout(timer); }
    }
    return this.result(task.id);
  }
  async result(id: string) {
    if (!uuid(id)) throw new Error("Invalid task_id.");
    const task = await this.store.get(id); const answer = terminal(task.status) ? await this.store.answer(id) : undefined;
    const u = task.usage;
    return {
      task_id: task.id, conversation_id: task.conversationId, status: task.status,
      answer: answer?.answer ?? null, ...(answer?.error ? { error: answer.error } : {}), ...(answer?.truncated ? { truncated: true } : {}),
      model: task.modelId ?? null, created_at: new Date(task.created).toISOString(), finished_at: task.finished ? new Date(task.finished).toISOString() : null,
      elapsed_ms: task.elapsedMs, tool_calls: task.toolCalls,
      usage: { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output, model_requests: u.requests, reported_requests: u.reportedRequests, missing_requests: u.requests - u.reportedRequests, coverage: !u.requests ? "not_started" : !u.reportedRequests ? "unavailable" : u.requests === u.reportedRequests ? "complete" : "partial" },
      ...(!terminal(task.status) ? { poll_after_ms: 2000 } : {}),
    };
  }
  async cancel(id: string) {
    if (!uuid(id)) throw new Error("Invalid task_id.");
    await this.store.get(id);
    this.active.get(id)?.controller.abort(new Error("MCP task cancelled by the caller."));
    // Cancellation is cooperative: a running request may still be finalizing its usage snapshot.
    return { ...await this.result(id), cancellation_requested: this.active.has(id) };
  }
  hasSession(id: string) { return this.store.hasSession(id); }
  async removeSession(id: string) { for (const task of this.store.tasks()) if (task.sessionId === id && this.active.has(task.id)) throw new Error("This MCP conversation has an active task."); await this.store.cleanup(id); }
  async close() {
    this.stopping = true; clearInterval(this.sweep);
    for (const task of this.active.values()) task.controller.abort(new Error("The MCP service is shutting down."));
    await Promise.allSettled([...this.active.values()].map(task => task.done));
  }
}
