import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { safeDirectory } from "../file-tools/store.js";
import type { TokenUsage } from "../web/wecom-contacts.js";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface McpTask {
  id: string; conversationId: string; sessionId: string; questionHash: string; requestId?: string;
  status: TaskStatus; created: number; updated: number; modelId?: string; started?: number; finished?: number;
  usage: TokenUsage; toolCalls: number; elapsedMs: number | null;
}
export interface TaskAnswer { answer: string; error?: string; truncated?: boolean; }
interface Totals { submitted: number; started: number; completed: number; failed: number; cancelled: number; interrupted: number; inputTokens: number; outputTokens: number; requests: number; reportedRequests: number; }
interface Database { version: 1; since: number; tasks: Record<string, McpTask>; conversations: Record<string, { sessionId: string; updated: number; submitted?: number; usage?: TokenUsage }>; totals: Totals; }
export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, requests: 0, reportedRequests: 0 });
const totals = (): Totals => ({ submitted: 0, started: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, inputTokens: 0, outputTokens: 0, requests: 0, reportedRequests: 0 });
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const terminal = (status: TaskStatus) => !["queued", "running"].includes(status);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const month = 30 * 86400000;

/** Atomic metadata + cumulative accounting. Answers are separate, bounded files. */
export class McpStore {
  private data: Database = { version: 1, since: Date.now(), tasks: {}, conversations: {}, totals: totals() };
  private queue = Promise.resolve();
  private directory: string;
  constructor(dataDir: string, private readonly limit = 5000) {
    const root = path.resolve(dataDir); let ancestor = root;
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    this.directory = path.join(realpathSync(ancestor), path.relative(ancestor, root), "mcp");
  }
  get file() { return path.join(this.directory, "state.json"); }
  private async read(file: string, limit: number) {
    await safeDirectory(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("MCP data must be a bounded regular file.");
    return JSON.parse(await fs.readFile(file, "utf8"));
  }
  async load() {
    // safeDirectory rejects linked ancestors, including the data root.
    const exists = await fs.lstat(this.directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!exists) return;
    await safeDirectory(this.directory);
    let data: Database;
    try { data = await this.read(this.file, 16 * 1024 * 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!data || data.version !== 1 || !count(data.since) || !data.tasks || !data.conversations || Object.keys(data.tasks).length > this.limit || Object.keys(data.conversations).length > this.limit || !data.totals || Object.keys(totals()).some(key => !count(data.totals[key as keyof Totals]))) throw new Error("Invalid MCP task/accounting data; existing data will not be reset.");
    for (const [id, task] of Object.entries(data.tasks)) {
      if (!uuid(id) || task.id !== id || !uuid(task.conversationId) || !uuid(task.sessionId) || !/^[a-f0-9]{64}$/.test(task.questionHash) || task.requestId !== undefined && !uuid(task.requestId) || !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(task.status) || !count(task.created) || !count(task.updated) || !task.usage || !Object.values(task.usage).every(count) || ![task.usage.input, task.usage.output, task.usage.requests, task.usage.reportedRequests, task.toolCalls].every(count) || task.usage.reportedRequests > task.usage.requests) throw new Error("Invalid MCP task metadata.");
    }
    for (const [id, entry] of Object.entries(data.conversations)) if (!uuid(id) || !uuid(entry.sessionId) || !count(entry.updated) || entry.submitted !== undefined && !count(entry.submitted) || entry.usage && ![entry.usage.input, entry.usage.output, entry.usage.requests, entry.usage.reportedRequests].every(count)) throw new Error("Invalid MCP conversation metadata.");
    if (data.totals.reportedRequests > data.totals.requests) throw new Error("Invalid MCP request accounting.");
    this.data = data;
  }
  private async write(file: string, data: unknown, limit: number) {
    await safeDirectory(path.dirname(file));
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > limit) throw new Error("MCP data exceeds the storage limit.");
    const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("MCP data must be a regular file.");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, serialized + "\n", { mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  private work<T>(fn: (data: Database) => Promise<T> | T): Promise<T> {
    const task = this.queue.then(async () => {
      const next = structuredClone(this.data); const result = await fn(next);
      await this.write(this.file, next, 16 * 1024 * 1024); this.data = next; return result;
    });
    this.queue = task.then(() => {}, () => {}); return task;
  }
  async submit(questionHash: string, conversationId?: string, requestId?: string, pendingLimit = 10) {
    return this.work(async data => {
      if (requestId) {
        const previous = Object.values(data.tasks).find(task => task.requestId === requestId);
        if (previous) {
          if (previous.questionHash !== questionHash || conversationId && previous.conversationId !== conversationId) throw new Error("request_id was already used for a different question or conversation.");
          return { task: structuredClone(previous), duplicate: true };
        }
      }
      if (Object.values(data.tasks).filter(task => !terminal(task.status)).length >= pendingLimit) throw new Error("The MCP task queue is full. Try again later.");
      if (Object.keys(data.tasks).length >= this.limit) throw new Error("MCP retained-task capacity reached. Clean up expired tasks before submitting more.");
      const conversation = conversationId && data.conversations[conversationId];
      if (conversationId && (!conversation || conversation.updated < Date.now() - month)) throw new Error("MCP conversation not found or expired. Omit conversation_id to start a new one.");
      if (conversationId && Object.values(data.tasks).some(task => task.conversationId === conversationId && !terminal(task.status))) throw new Error("This MCP conversation already has a pending task.");
      if (!conversation && Object.keys(data.conversations).length >= this.limit) throw new Error("MCP conversation capacity reached.");
      const id = randomUUID(); const handle = conversationId ?? randomUUID(); const sessionId = conversation ? conversation.sessionId : randomUUID(); const now = Date.now();
      const task: McpTask = { id, conversationId: handle, sessionId, questionHash, ...(requestId ? { requestId } : {}), status: "queued", created: now, updated: now, usage: emptyUsage(), toolCalls: 0, elapsedMs: null };
      data.conversations[handle] = { ...conversation, sessionId, updated: now, submitted: (conversation ? conversation.submitted ?? 0 : 0) + 1, usage: conversation ? conversation.usage ?? emptyUsage() : emptyUsage() }; data.tasks[id] = task; data.totals.submitted++;
      return { task: structuredClone(task), duplicate: false };
    });
  }
  async update(id: string, changes: Partial<Pick<McpTask, "status" | "usage" | "toolCalls" | "elapsedMs" | "modelId" | "started" | "finished">>, answer?: TaskAnswer) {
    return this.work(async data => {
      const old = data.tasks[id]; if (!old) throw new Error("MCP task not found.");
      const next = { ...old, ...structuredClone(changes), updated: Date.now() };
      if (terminal(old.status) && !terminal(next.status)) throw new Error("A completed MCP task cannot be restarted.");
      if (Object.keys(emptyUsage()).some(key => !count(next.usage[key as keyof TokenUsage]) || next.usage[key as keyof TokenUsage] < old.usage[key as keyof TokenUsage]) || next.usage.reportedRequests > next.usage.requests) throw new Error("MCP usage snapshots must be monotonic.");
      const t = data.totals;
      t.inputTokens += next.usage.input - old.usage.input; t.outputTokens += next.usage.output - old.usage.output;
      t.requests += next.usage.requests - old.usage.requests; t.reportedRequests += next.usage.reportedRequests - old.usage.reportedRequests;
      t.started += Number(next.started !== undefined) - Number(old.started !== undefined);
      for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) t[status] += Number(next.status === status) - Number(old.status === status);
      if (!Object.values(t).every(count)) throw new Error("MCP cumulative usage exceeds safe integer limits.");
      // Response first; startup recovery can reconcile it if the following state rename is interrupted.
      if (answer) await this.write(this.answerPath(id), { ...answer, snapshot: next }, 2 * 1024 * 1024);
      data.tasks[id] = next;
      const conversation = data.conversations[next.conversationId];
      if (conversation) {
        conversation.updated = next.updated; const usage = conversation.usage ??= emptyUsage();
        for (const key of Object.keys(emptyUsage()) as (keyof TokenUsage)[]) usage[key] += next.usage[key] - old.usage[key];
      }
      return structuredClone(next);
    });
  }
  private answerPath(id: string) { if (!uuid(id)) throw new Error("Invalid task_id."); return path.join(this.directory, "answers", `${id}.json`); }
  async answer(id: string): Promise<(TaskAnswer & { snapshot?: McpTask }) | undefined> {
    try {
      const answer = await this.read(this.answerPath(id), 2 * 1024 * 1024);
      if (typeof answer.answer !== "string" || answer.answer.length > 256000 || answer.error !== undefined && typeof answer.error !== "string") throw new Error("Invalid MCP answer data.");
      return answer;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  async get(id: string) { await this.queue; const task = this.data.tasks[id]; if (!task) throw new Error("MCP task not found or expired."); return structuredClone(task); }
  tasks() { return Object.values(structuredClone(this.data.tasks)); }
  hasSession(sessionId: string) { return Object.values(this.data.conversations).some(entry => entry.sessionId === sessionId); }
  async summary() {
    await this.queue;
    const conversations = Object.entries(this.data.conversations).map(([id, c]) => {
      const tasks = Object.values(this.data.tasks).filter(t => t.conversationId === id); return { conversation_id: id, updated_at: new Date(c.updated).toISOString(), retained_tasks: tasks.length, submitted_tasks: c.submitted ?? tasks.length, input_tokens: c.usage?.input ?? tasks.reduce((n, t) => n + t.usage.input, 0), output_tokens: c.usage?.output ?? tasks.reduce((n, t) => n + t.usage.output, 0) };
    });
    return { since: new Date(this.data.since).toISOString(), totals: { ...this.data.totals, totalTokens: this.data.totals.inputTokens + this.data.totals.outputTokens, missingRequests: this.data.totals.requests - this.data.totals.reportedRequests }, retainedTasks: Object.keys(this.data.tasks).length, recentTasks: Object.values(this.data.tasks).sort((a, b) => b.created - a.created).slice(0, 50).map(task => ({ task_id: task.id, conversation_id: task.conversationId, status: task.status, model: task.modelId ?? null, created_at: new Date(task.created).toISOString(), input_tokens: task.usage.input, output_tokens: task.usage.output, model_requests: task.usage.requests, reported_requests: task.usage.reportedRequests })), conversations };
  }
  async cleanup(sessionId?: string, now = Date.now()) {
    const expired = Object.values(this.data.tasks).filter(task => task.sessionId === sessionId || terminal(task.status) && task.updated < now - month);
    if (!expired.length && !sessionId) { await this.sweepAnswers(); return; }
    await this.work(data => {
      for (const task of expired) delete data.tasks[task.id];
      for (const [id, conv] of Object.entries(data.conversations)) if (conv.sessionId === sessionId || conv.updated < now - month && !Object.values(data.tasks).some(t => t.conversationId === id)) delete data.conversations[id];
    });
    // Keep cumulative totals; expired response bodies and task cursors are removed together.
    for (const task of expired) await fs.rm(this.answerPath(task.id), { force: true });
    await this.sweepAnswers();
  }
  private async sweepAnswers() {
    // A crash after committing deletion can leave bodies behind. Serialize the sweep
    // with answer publication so a response awaiting its state rename is never removed.
    const sweep = this.queue.then(async () => {
      const directory = path.join(this.directory, "answers");
      if (!await fs.lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) return;
      await safeDirectory(directory);
      for (const name of await fs.readdir(directory)) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!uuid(id) || this.data.tasks[id]) continue;
        const file = path.join(directory, name); const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("MCP answers must be regular files.");
        await fs.rm(file);
      }
    });
    this.queue = sweep.then(() => {}, () => {}); await sweep;
  }
}
