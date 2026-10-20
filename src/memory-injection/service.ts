import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { mainMemoryFile } from "../agent/memory-paths.js";
import { parseMemoryEntries, renderMemoryEntry } from "../agent/extra-memory.js";
import { atomic, emptyUsage, hash, knowledgeLock, readJson, safePath, SyncError, type Usage } from "../knowledge-sync/core.js";
import type { MemoryPlanner, Operation, Proposal } from "./planner.js";

const MAX_BYTES = 2 * 1024 * 1024;
type Change = {action: Operation["action"]; id: string; reason: string; before: string; after: string};
type Status = "planning" | "ready" | "needs_clarification" | "committing" | "committed" | "failed" | "conflict";
type Job = {id: string; created: string; expires: number; status: Status; prompt: string; model: string; usage: Usage; summary: string; questions: string[]; changes: Change[]; before: string; next: string; revision: string; nextRevision: string; error?: string; backup?: string; committed?: string};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

export class MemoryInjectionService {
  private readonly directory: string;
  private active?: Promise<void>;
  private activeId?: string;
  private controller?: AbortController;
  private busy = false;
  private closed = false;
  constructor(private options: {dataDir: string; planner: () => MemoryPlanner; modelId: () => string; redact: (error: unknown) => string}) {
    this.directory = path.join(options.dataDir, "memory-injection");
  }
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SyncError("Invalid memory preview ID.");
    return path.join(this.directory, `${id}.json`);
  }
  private save(job: Job) { return atomic(this.file(job.id), JSON.stringify(job)); }
  private async load(id: string) {
    const job = await readJson<Job | null>(this.file(id), null);
    if (!job) throw new SyncError("Memory preview not found.", 404);
    return job;
  }
  private public(job: Job) {
    const {before, next, revision, nextRevision, ...result} = job;
    return result;
  }
  async get(id: string) {
    let job = await this.load(id);
    if (this.activeId === id && !["planning", "committing"].includes(job.status)) {
      await this.active?.catch(() => {});
      job = await this.load(id);
    }
    return this.public(job);
  }
  private async snapshot() {
    const file = await safePath(this.options.dataDir, path.relative(this.options.dataDir, mainMemoryFile(this.options.dataDir)));
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new SyncError("Main memory must be an ordinary, non-linked UTF-8 file of at most 2 MiB.");
      const bytes = await handle.readFile();
      if (bytes.length > MAX_BYTES) throw new SyncError("Main memory exceeds 2 MiB.");
      const memory = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
      if (!memory.trim()) throw new SyncError("Main memory is empty. Restore it before injecting changes.");
      parseMemoryEntries(memory, "Main memory");
      return {memory, revision: hash(memory)};
    } finally { await handle.close(); }
  }
  async init() {
    await safePath(this.directory);
    const files = await fs.readdir(this.directory).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const job = await this.load(file.slice(0, -5));
      if (job.status === "planning") {job.status = "failed"; job.error = "Preview interrupted by a service restart. Generate a new preview."; await this.save(job);}
      if (job.status === "committing") {
        const current = await this.snapshot();
        if (current.revision === job.nextRevision) {job.status = "committed"; job.committed ??= new Date().toISOString();}
        else if (current.revision === job.revision) {job.status = "ready"; job.error = "Confirmation was interrupted before publication. Review and confirm again.";}
        else {job.status = "conflict"; job.error = "Main memory changed during recovery. Generate a new preview.";}
        await this.save(job);
      }
    }
  }
  private reserve() {
    if (this.closed) throw new SyncError("Service is shutting down.", 503);
    if (this.busy) throw new SyncError("A memory operation is already running. Please wait.", 409);
    this.busy = true;
  }
  private run(job: Job, task: (signal: AbortSignal) => Promise<void>) {
    this.activeId = job.id;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)]);
    this.active = task(signal).catch(async error => {
      // The file replacement may have succeeded before writing the receipt failed.
      const published = job.nextRevision && ["committing", "committed"].includes(job.status) &&
        (await this.snapshot().catch(() => undefined))?.revision === job.nextRevision;
      if (published) {job.status = "committed"; job.committed ??= new Date().toISOString();}
      else {job.status = "failed"; job.error = this.options.redact(error);}
      await this.save(job);
    }).finally(() => { this.busy = false; this.active = undefined; this.activeId = undefined; this.controller = undefined; });
    // Persist failures without an unhandled rejection if storage itself becomes unavailable.
    void this.active.catch(() => {});
  }
  async preview(prompt: unknown) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) throw new SyncError("Enter a memory request of at most 16000 characters.");
    this.reserve();
    try {
      const snapshot = await this.snapshot();
      const planner = this.options.planner();
      const job: Job = {id: randomUUID(), created: new Date().toISOString(), expires: Date.now() + 30 * 60000, status: "planning", prompt, model: this.options.modelId(), usage: emptyUsage(), summary: "", questions: [], changes: [], before: snapshot.memory, next: "", revision: snapshot.revision, nextRevision: ""};
      await this.save(job);
      this.run(job, async signal => {
        const proposal = await planner({prompt, memory: snapshot.memory, signal, usage: job.usage});
        signal.throwIfAborted();
        this.prepare(job, proposal);
        await this.save(job);
      });
      return this.public(job);
    } catch (error) { this.busy = false; throw error; }
  }
  private prepare(job: Job, proposal: Proposal) {
    if (!object(proposal) || Object.keys(proposal).some(k => !["summary", "questions", "operations"].includes(k)) || !text(proposal.summary, 8000) || !Array.isArray(proposal.questions) || proposal.questions.length > 20 || proposal.questions.some(q => !text(q, 2000)) || !Array.isArray(proposal.operations) || proposal.operations.length > 30) throw new SyncError("Invalid memory proposal. No file was changed.");
    job.summary = proposal.summary;
    job.questions = proposal.questions;
    if (proposal.questions.length) {
      if (proposal.operations.length) throw new SyncError("An ambiguous proposal must not contain changes. Generate a new preview.");
      job.status = "needs_clarification"; return;
    }
    if (!proposal.operations.length) {job.questions = ["没有明确的记忆变更，请补充要新增、修改或删除的信息。 "]; job.status = "needs_clarification"; return;}
    const entries = parseMemoryEntries(job.before, "Main memory");
    const used = new Set<string>();
    const replacements: {start: number; end: number; value: string}[] = [];
    const additions: string[] = [];
    for (const op of proposal.operations) {
      if (!object(op) || Object.keys(op).some(k => !["action", "id", "content", "kind", "reason"].includes(k)) || !["add", "update", "delete"].includes(op.action) || !text(op.reason, 2000)) throw new SyncError("Invalid memory operation.");
      if (op.action === "add" && op.id !== undefined) throw new SyncError("New memory IDs are assigned by the backend.");
      const previous = op.action === "add" ? undefined : entries.find(e => e.id === op.id);
      if (op.action !== "add" && !previous) throw new SyncError("Memory target is missing or ambiguous. Generate a new preview.");
      if (previous && used.has(previous.id)) throw new SyncError("A memory entry cannot be changed twice in one preview.");
      if (previous) used.add(previous.id);
      if (op.action === "delete" && (op.content !== undefined || op.kind !== undefined)) throw new SyncError("Deletion must only identify an existing entry.");
      if (op.action !== "delete" && (typeof op.content !== "string" || !op.content.trim() || op.content.length > 64000 || /^## Memory\b/m.test(op.content) || op.content.includes("\0") || op.kind !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(op.kind))) throw new SyncError("Invalid memory body or kind.");
      const id = previous?.id ?? `mem_${randomBytes(8).toString("hex")}`;
      const time = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updated) + 1 : 0) + 8 * 3600000).toISOString().replace("Z", "+08:00");
      const after = op.action === "delete" ? "" : renderMemoryEntry({id, kind: op.kind ?? previous?.kind ?? "fact", email: previous?.email ?? "unknown@email.com", created: previous?.created ?? time, updated: time, content: op.content!.trim()});
      const before = previous ? job.before.slice(previous.start, previous.end) : "";
      job.changes.push({action: op.action, id, reason: op.reason, before, after});
      if (previous) replacements.push({start: previous.start, end: previous.end, value: after});
      else additions.push(after);
    }
    let next = job.before;
    for (const change of replacements.sort((a, b) => b.start - a.start)) next = next.slice(0, change.start) + change.value + next.slice(change.end);
    if (additions.length) next += `${next.endsWith("\n\n") ? "" : "\n\n"}${additions.join("")}`;
    if (Buffer.byteLength(next) > MAX_BYTES) throw new SyncError("Proposed memory exceeds 2 MiB.");
    parseMemoryEntries(next, "Main memory");
    job.next = next; job.nextRevision = hash(next); job.status = "ready";
  }
  async confirm(id: string) {
    this.reserve();
    try {
      const job = await this.load(id);
      if (job.status === "committed") {this.busy = false; return this.public(job);}
      if (job.status !== "ready") throw new SyncError("Only a ready preview can be confirmed.", 409);
      if (Date.now() > job.expires) throw new SyncError("Memory preview expired. Generate a new preview.", 409);
      job.status = "committing"; delete job.error;
      await this.save(job);
      this.run(job, async signal => {
        const release = await knowledgeLock(path.join(this.options.dataDir, "urovo-product-expert")).write(signal);
        try {
          const current = await this.snapshot();
          if (current.revision !== job.revision) {job.status = "conflict"; job.error = "Main memory changed after preview. Generate a new preview."; await this.save(job); return;}
          const backup = await safePath(this.options.dataDir, `maintenance-backups/main-memory/${job.id}.md`);
          // A retry must never replace the original backup with a later version.
          const existing = await fs.readFile(backup, "utf8").catch(e => {if (e.code === "ENOENT") return undefined; throw e;});
          if (existing !== undefined && existing !== job.before) throw new SyncError("Memory backup does not match the preview.");
          if (existing === undefined) await atomic(backup, job.before);
          job.backup = backup;
          await this.save(job);
          signal.throwIfAborted();
          if ((await this.snapshot()).revision !== job.revision) throw new SyncError("Main memory changed before publication. Generate a new preview.", 409);
          await atomic(mainMemoryFile(this.options.dataDir), job.next);
          job.status = "committed"; job.committed = new Date().toISOString();
          await this.save(job);
        } finally { release(); }
      });
      return this.public(job);
    } catch (error) {this.busy = false; throw error;}
  }
  async close() {this.closed = true; this.controller?.abort(); await this.active?.catch(() => {});}
}
