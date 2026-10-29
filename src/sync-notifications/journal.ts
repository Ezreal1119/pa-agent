import fs from "node:fs/promises";
import path from "node:path";
import { atomic, readJson, safePath, type Job } from "../knowledge-sync/core.js";

export interface SyncCompletion {
  version: 1; id: string; origin: "manual" | "auto"; started: string; finished: string;
  status: string; total: number; counts: Record<string, number>; scopes: string[]; jobIds: string[];
  items: { name: string; status: string; summary?: string }[];
}
export class CompletionJournal {
  readonly directory: string;
  private recorded = new Set<string>();
  constructor(dataDir: string) { this.directory = path.join(dataDir, "sync-notifications", "events"); }
  async record(value: SyncCompletion) {
    if (this.recorded.has(value.id)) return;
    await safePath(this.directory); await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await safePath(this.directory, value.id + ".json");
    if (await readJson(file, null)) { this.recorded.add(value.id); return; } // Immutable snapshots survive later Re-Sync/publication.
    await atomic(file, JSON.stringify(value)); this.recorded.add(value.id);
  }
  async job(job: Job) {
    if (job.kind !== "sync" || !job.execution || job.execution.autoRunId || !job.finished || !["completed", "failed", "stopped", "interrupted", "awaiting_confirmation"].includes(job.status)) return;
    const items = job.items.filter(item => job.execution!.itemIds.includes(item.id));
    if (!items.length) return;
    await this.record({ version: 1, id: job.execution.id, origin: "manual", started: job.execution.started, finished: job.finished, status: job.status,
      total: items.length, counts: items.reduce((out, item) => { out[item.status] = (out[item.status] ?? 0) + 1; return out; }, {} as Record<string, number>),
      scopes: [job.execution.id], jobIds: [job.id], items: items.map(item => ({ name: item.name, status: item.status, summary: item.summary?.slice(0,400) })) });
  }
  async list(exclude = new Set<string>()) {
    await safePath(this.directory);
    const names = await fs.readdir(this.directory).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    const events: SyncCompletion[] = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name) || exclude.has(name.slice(0, -5))) continue;
      const value = await readJson<SyncCompletion | null>(await safePath(this.directory, name), null);
      if (!value || value.version !== 1 || value.id + ".json" !== name || !Number.isFinite(Date.parse(value.started)) || !Number.isFinite(Date.parse(value.finished)) || !Array.isArray(value.items) || !Array.isArray(value.scopes) || !value.counts) throw new Error("Invalid Sync completion event.");
      events.push(value);
    }
    return events.sort((a, b) => a.finished.localeCompare(b.finished) || a.id.localeCompare(b.id));
  }
}
