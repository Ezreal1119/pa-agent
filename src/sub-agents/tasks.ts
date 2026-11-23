import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RunGate } from "../web/run-gate.js";
import type { TokenUsage } from "../web/wecom-contacts.js";

export interface ParentBinding { round: number; toolCallId: string }
export interface TaskReceipt {
  taskId: string;
  status: string;
  elapsedMs: number;
  toolCalls: number;
  usage: TokenUsage;
}
export interface TaskContext {
  parentId: string;
  binding?: ParentBinding;
  signal: AbortSignal;
  receipt: TaskReceipt;
  elapsed(): number;
  deleted(): boolean;
  closing(): boolean;
  enter(beforeGlobal?: () => Promise<void>): Promise<void>;
}
export const validUsage = (value: unknown): value is TokenUsage => {
  const usage = value as TokenUsage | undefined;
  return Boolean(usage && [usage.input, usage.output, usage.requests, usage.reportedRequests].every(n => Number.isSafeInteger(n) && n >= 0) && usage.reportedRequests <= usage.requests);
};
export const validParentId = (id: string) => /^[a-zA-Z0-9-]{8,80}$/.test(id);
interface Parent {
  gate: RunGate;
  controllers: Set<AbortController>;
  pending: Set<Promise<unknown>>;
  deleted: boolean;
}
export class SubAgentTasks {
  private parents = new Map<string, Parent>();
  private gate: RunGate;
  private closing = false;
  constructor(private limits: {concurrency: number; queueLimit: number; timeoutMs: number}) {
    this.gate = new RunGate(limits.concurrency, limits.queueLimit);
  }
  private parent(id: string) {
    if (!validParentId(id)) throw new Error("Invalid parent session.");
    let parent = this.parents.get(id);
    if (!parent) {
      parent = {gate: new RunGate(1, this.limits.queueLimit), controllers: new Set(), pending: new Set(), deleted: false};
      this.parents.set(id, parent);
    }
    return parent;
  }
  busy(id: string) { return Boolean(this.parents.get(id)?.pending.size); }
  run<T>(parentId: string, binding: ParentBinding | undefined, caller: AbortSignal | undefined, work: (task: TaskContext) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("Sub-agent service is closed.");
    const parent = this.parent(parentId);
    if (parent.deleted) throw new Error("This parent conversation was deleted.");
    const controller = new AbortController();
    parent.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.limits.timeoutMs), ...(caller ? [caller] : [])]);
    const started = performance.now();
    const receipt: TaskReceipt = {taskId: randomUUID(), status: "failed", elapsedMs: 0, toolCalls: 0, usage: {input: 0, output: 0, requests: 0, reportedRequests: 0}};
    let releaseParent: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    const task: TaskContext = {
      parentId, binding, signal, receipt,
      elapsed: () => Math.round(performance.now() - started),
      deleted: () => parent.deleted, closing: () => this.closing,
      enter: async beforeGlobal => {
        releaseParent = await parent.gate.acquire(signal);
        signal.throwIfAborted();
        await beforeGlobal?.();
        releaseGlobal = await this.gate.acquire(signal);
        signal.throwIfAborted();
      },
    };
    const pending = Promise.resolve().then(() => work(task)).finally(() => {
      receipt.elapsedMs = Math.round(performance.now() - started);
      releaseGlobal?.();
      releaseParent?.();
      parent.controllers.delete(controller);
      parent.pending.delete(pending);
      if (!parent.deleted && !parent.pending.size) this.parents.delete(parentId);
    });
    parent.pending.add(pending);
    return pending;
  }
  async deleteParent(id: string) {
    const parent = this.parent(id);
    parent.deleted = true;
    for (const controller of parent.controllers) controller.abort();
    await Promise.allSettled(parent.pending);
  }
  dispose() {
    this.closing = true;
    for (const parent of this.parents.values()) for (const controller of parent.controllers) controller.abort();
  }
  async close() {
    this.dispose();
    await Promise.allSettled([...this.parents.values()].flatMap(parent => [...parent.pending]));
  }
}
