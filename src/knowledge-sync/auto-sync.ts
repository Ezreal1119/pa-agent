import { randomUUID } from "node:crypto";
import { CompletionJournal } from "../sync-notifications/journal.js";
import path from "node:path";
import { atomic, readJson, safePath, SyncError } from "./core.js";
import type { Incoming, SyncService } from "./service.js";

export type AutoSyncRun = {
  id?: string;
  started: string;
  finished?: string;
  status: "running" | "completed" | "interrupted" | "stopped" | "failed" | "skipped_busy" | "skipped_empty" | "skipped_handled";
  selected: number;
  held: number;
  invalid: number;
  jobIds: string[];
  batchResults?: { jobId: string; scope?: string; items: { name: string; status: string; summary?: string }[] }[];
  counts: Record<string, number>;
  error?: string;
};

/** A timer submits one snapshot to the existing, single-process Sync service.
 * Never create a second SyncService or replay failed/review reports. */
export class AutoSync {
  private active?: Promise<void>;
  private running = false;
  private closed = false;
  private last: AutoSyncRun | null = null;
  private readonly file: string;
  constructor(private sync: SyncService, private configured: () => boolean,
    private redact: (error: unknown) => string) {
    this.file = path.join(sync.directory, "auto-sync-last.json");
  }
  async init() {
    this.last = await readJson<AutoSyncRun | null>(await safePath(this.sync.directory, "auto-sync-last.json"), null);
    if (this.last?.status === "running") {
      this.last.status = "interrupted";
      this.last.finished = new Date().toISOString();
      this.last.error = "Service restarted. Existing reports require manual handling; no task was replayed.";
      await this.save(this.last);
    }
  }
  status() { return { running: this.running, lastRun: this.last ? structuredClone(this.last) : null }; }
  private async save(run: AutoSyncRun) {
    await safePath(this.sync.directory, "auto-sync-last.json");
    await atomic(this.file, JSON.stringify(run));
    await this.recordCompletion(run).catch(() => console.error("Auto-sync completion notification deferred; report retained."));
    this.last = structuredClone(run);
  }
  async recordCompletion(run = this.last) {
    if (!run?.id || !run.finished || run.selected === 0 || run.status === "running") return;
    const snapshots = [...(run.batchResults ?? [])];
    for (const jobId of run.jobIds) if (!snapshots.some(batch => batch.jobId === jobId)) {
      const report = this.sync.summary(jobId);
      if (report.execution?.autoRunId === run.id) snapshots.push({ jobId, scope: report.execution.id, items: report.items.map(item => ({ name: item.name, status: item.status, summary: item.summary?.slice(0,400) })) });
    }
    const items = snapshots.flatMap(batch => batch.items);
    await new CompletionJournal(this.sync.options.dataDir).record({ version: 1, id: run.id, origin: "auto", started: run.started, finished: run.finished, status: run.status,
      total: run.selected, counts: items.reduce((out, item) => { out[item.status] = (out[item.status] ?? 0) + 1; return out; }, {} as Record<string, number>), items, scopes: snapshots.flatMap(batch => batch.scope ? [batch.scope] : []), jobIds: run.jobIds });
  }
  async trigger() {
    if (this.closed) throw new SyncError("Auto-sync is shutting down.", 503);
    // A duplicate trigger does not overwrite the active run's durable status.
    if (this.running) return { status: "skipped_busy" as const };
    this.running = true;
    const run: AutoSyncRun = { id: randomUUID(), started: new Date().toISOString(), status: "running", selected: 0, held: 0, invalid: 0, jobIds: [], counts: {} };
    try {
      if (this.sync.busy) run.status = "skipped_busy";
      else {
        if (!this.configured()) throw new SyncError("Configure the model and administrator before enabling Auto-sync.", 503);
        const incoming = await this.sync.incoming();
        const snapshot = incoming.filter(file => {
          if (file.error) { run.invalid++; return false; }
          if (this.sync.wasAttempted(file)) { run.held++; return false; }
          return true;
        });
        run.selected = snapshot.length;
        if (snapshot.length) {
          await this.save(run);
          // Reserve the first ordinary Sync before acknowledging timer dispatch.
          const first = await this.startBatch(snapshot.slice(0, 50), run.id);
          run.jobIds.push(first.id);
          await this.save(run);
          this.active = this.execute(run, snapshot, first.id).catch(async error => {
            run.status = "failed"; run.error = this.redact(error);
            run.finished = new Date().toISOString();
            await this.save(run);
          }).catch(error => console.error("Auto-sync state:", this.redact(error)))
            .finally(() => { this.running = false; });
          return structuredClone(run);
        }
        run.status = incoming.length ? "skipped_handled" : "skipped_empty";
      }
      run.finished = new Date().toISOString();
      await this.save(run);
      return structuredClone(run);
    } catch (error) {
      run.status = error instanceof SyncError && error.status === 409 ? "skipped_busy" : "failed";
      run.error = this.redact(error); run.finished = new Date().toISOString();
      await this.save(run);
      throw error;
    } finally {
      if (!this.active || run.status !== "running") this.running = false;
    }
  }
  private startBatch(files: Incoming[], runId?: string) {
    if (this.closed) throw new SyncError("Auto-sync is shutting down.", 503);
    return this.sync.start(files.map(file => file.id), new Map(files.map(file => [file.id, file.sourceHash])), runId);
  }
  private async execute(run: AutoSyncRun, snapshot: Incoming[], firstId: string) {
    let jobId = firstId;
    for (let offset = 0; offset < snapshot.length; offset += 50) {
      await this.sync.waitFor(jobId);
      const job = this.sync.summary(jobId);
      (run.batchResults ??= []).push({ jobId, scope: job.execution?.id, items: job.items.map(item => ({ name: item.name, status: item.status, summary: item.summary?.slice(0,400) })) });
      for (const item of job.items) run.counts[item.status] = (run.counts[item.status] ?? 0) + 1;
      await this.save(run);
      if (this.closed || ["stopped", "stopping", "interrupted"].includes(job.status)) {
        run.status = this.closed ? "interrupted" : "stopped";
        break;
      }
      if (offset + 50 < snapshot.length) {
        if (this.sync.busy) { run.status = "stopped"; run.error = "Another maintenance task started; remaining snapshot files were not queued."; break; }
        const next = await this.startBatch(snapshot.slice(offset + 50, offset + 100), run.id);
        jobId = next.id; run.jobIds.push(jobId);
        await this.save(run);
      }
    }
    if (run.status === "running") run.status = "completed";
    run.finished = new Date().toISOString();
    await this.save(run);
  }
  async close() {
    // SyncService.close() cancels the currently executing ordinary job. Do not
    // hold shutdown while waiting for its completion or launch another batch.
    this.closed = true;
  }
  async wait() { await this.active; }
}
