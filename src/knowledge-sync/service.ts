import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  atomic,
  catalog,
  emptyUsage,
  hash,
  knowledgeLock,
  readJson,
  relative,
  protectedName,
  safePath,
  SyncError,
  timestamp,
  terminal,
  type Conversion,
  type Job,
  type Item,
  type Plan,
} from "./core.js";
import { Publisher } from "./publication.js";
import { buildPlan, primeIndex } from "./validation.js";
import type { Converter } from "./converter.js";
import type { Planner } from "./agent.js";
const extensions = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".txt",
  ".md",
]);
export type Incoming = {
  id: string;
  name: string;
  bytes: number;
  sourceHash: string;
  error?: string;
};
export interface SyncOptions {
  dataDir: string;
  maxBytes: number;
  timeoutMs: number;
  maxBatchMarkdownBytes?: number;
  modelId: () => string;
  planner: () => Planner;
  converter: () => Converter;
  redact: (error: unknown) => string;
}
export class SyncService {
  readonly root: string;
  readonly inbox: string;
  readonly directory: string;
  readonly publisher: Publisher;
  private knowledge = new Map<string, string>();
  private jobs = new Map<string, Job>();
  private archived = new Set<string>();
  private inputHashes = new Map<string, { signature: string; hash: string }>();
  private saveTail: Promise<unknown> = Promise.resolve();
  private active?: Promise<void>;
  private controller?: AbortController;
  private reserved = false;
  private closed = false;
  private activeId?: string;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private pruning?: Promise<void>;
  constructor(readonly options: SyncOptions) {
    this.root = path.join(options.dataDir, "urovo-product-expert");
    this.inbox = path.join(this.root, "newly_added");
    this.directory = path.join(options.dataDir, "knowledge-sync");
    this.publisher = new Publisher(this.root, this.directory);
  }
  async init() {
    await safePath(this.directory);
    await fs.mkdir(path.join(this.directory, "jobs"), {
      recursive: true,
      mode: 0o700,
    });
    const release = await knowledgeLock(this.root).write();
    try {
      await this.publisher.recover();
      this.knowledge = await catalog(this.root);
      primeIndex(this.knowledge);
    } finally {
      release();
    }
    for (const name of await fs.readdir(path.join(this.directory, "jobs"))) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const job = await readJson<Job | null>(
        await safePath(this.directory, `jobs/${name}`),
        null,
      );
      if (!job) continue;
      for (const item of job.items) {
        if (await this.publisher.committed(item.id)) {
          item.status = job.kind === "delete" ? "deleted" : "published";
          item.stage = "Published";
          if (job.kind === "delete") job.confirmed = true;
          else if (!item.sourceDeleted)
            item.cleanupError = "Publication recovered. Retry input cleanup.";
        } else if (!terminal(item.status)) {
          item.status = "interrupted";
          item.reason = "Service restarted. Re-Sync to continue.";
        }
      }
      if (!terminal(job.status)) {
        job.status = "interrupted";
      }
      this.jobs.set(job.id, job);
      await this.save(job);
      this.archive(job);
    }
    this.pruneTimer = setInterval(() => {
      this.pruning = this.publisher
        .prune()
        .catch((e) =>
          console.error("Sync backup cleanup:", this.options.redact(e)),
        );
    }, 86400000);
    this.pruneTimer.unref();
  }
  private archive(job: Job) {
    const small = {
      ...job,
      items: job.items.map((i) => ({
        ...i,
        coverage: undefined,
        plan: i.plan ? { ...i.plan, changes: [] } : undefined,
      })),
    };
    this.jobs.set(job.id, small);
    this.archived.add(job.id);
  }
  async save(job: Job) {
    for (const item of job.items)
      if (item.plan?.changes.length) {
        const source = item.plan.changes.find(
          (c) => c.path === item.plan!.decision.newPath,
        );
        if (source?.after !== null && source?.after !== undefined)
          item.publishedHash = hash(source.after);
        if (job.kind === "delete")
          item.deletedSources = item.plan.changes
            .filter((c) => c.after === null && c.before !== null)
            .map((c) => ({
              path: c.path,
              hash: hash(c.before!),
              preview: c.before!.slice(0, 4000),
            }));
      }
    const text = JSON.stringify(job);
    const task = this.saveTail.then(() =>
      atomic(path.join(this.directory, "jobs", `${job.id}.json`), text),
    );
    this.saveTail = task.catch(() => {});
    await task;
  }
  private async event(job: Job, item: Item) {
    await this.save(job);
    await fs.appendFile(
      await safePath(this.directory, "events.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        jobId: job.id,
        itemId: item.id,
        status: item.status,
        stage: item.stage,
      }) + "\n",
      { mode: 0o600 },
    );
  }
  async incoming(): Promise<Incoming[]> {
    await safePath(this.inbox);
    await fs.mkdir(this.inbox, { recursive: true, mode: 0o700 });
    const list: Incoming[] = [];
    const hashes = this.inputHashes;
    async function scan(root: string, dir: string, max: number) {
      for (const entry of await fs.readdir(await safePath(root, dir), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".")) continue;
        const name = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          list.push({
            id: hash(name),
            name,
            bytes: 0,
            sourceHash: "",
            error: "Symbolic links are not allowed.",
          });
          continue;
        }
        if (entry.isDirectory()) {
          await scan(root, name, max);
          continue;
        }
        if (!entry.isFile()) continue;
        const file = await safePath(root, name);
        const stat = await fs.stat(file);
        const error = protectedName(name)
          ? "Protected filename; not eligible for synchronization."
          : stat.size > max
            ? "File exceeds upload limit."
            : !extensions.has(path.extname(name).toLowerCase())
              ? "Unsupported file format."
              : undefined;
        const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const cached = hashes.get(name);
        const sourceHash = error
          ? ""
          : cached?.signature === signature
            ? cached.hash
            : hash(await fs.readFile(file));
        if (!error) hashes.set(name, { signature, hash: sourceHash });
        list.push({
          id: hash(name),
          name,
          bytes: stat.size,
          sourceHash,
          ...(error ? { error } : {}),
        });
      }
    }
    await scan(this.inbox, "", this.options.maxBytes);
    const names = new Set(list.map((f) => f.name));
    for (const name of hashes.keys()) if (!names.has(name)) hashes.delete(name);
    return list;
  }
  async upload(
    name: string,
    stream: IncomingMessage | AsyncIterable<Uint8Array>,
  ) {
    if (this.closed) throw new SyncError("Service is shutting down.", 503);
    if (
      name !== path.basename(name) ||
      name.startsWith(".") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.length > 200 ||
      !extensions.has(path.extname(name).toLowerCase()) ||
      /^(?:SKILL|MEMORY|SYNC|SYNC_PROMPT)\.md$/i.test(name)
    )
      throw new SyncError("Invalid or unsupported filename.");
    await safePath(this.inbox);
    await fs.mkdir(this.inbox, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const temp = await safePath(this.inbox, `.upload-${id}`);
    const handle = await fs.open(temp, "wx", 0o600);
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > this.options.maxBytes)
          throw new SyncError("File exceeds 30 MB upload limit.", 413);
        await handle.writeFile(chunk);
      }
      if (!bytes) throw new SyncError("Empty file.");
      await handle.sync();
    } catch (e) {
      await handle.close();
      await fs.rm(temp, { force: true });
      throw e;
    }
    await handle.close();
    let target = name;
    if (await fs.lstat(path.join(this.inbox, target)).catch(() => undefined))
      target = `${path.basename(name, path.extname(name))}-${id.slice(0, 8)}${path.extname(name)}`;
    try {
      await fs.copyFile(
        temp,
        await safePath(this.inbox, target),
        fs.constants.COPYFILE_EXCL,
      );
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { name: target, bytes, id: hash(target) };
  }
  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.created.localeCompare(a.created))
      .map((j) => ({
        id: j.id,
        kind: j.kind,
        created: j.created,
        status: this.reserved && this.activeId === j.id ? "running" : j.status,
        count: j.items.length,
        counts: j.items.reduce(
          (r, i) => ((r[i.status] = (r[i.status] ?? 0) + 1), r),
          {} as Record<string, number>,
        ),
      }));
  }
  async get(id: string) {
    let job = this.jobs.get(id);
    if (!job) throw new SyncError("Sync report not found.", 404);
    if (this.archived.has(id))
      job =
        (await readJson<Job | null>(
          path.join(this.directory, "jobs", `${id}.json`),
          null,
        )) ?? undefined;
    if (!job) throw new SyncError("Sync report is missing from disk.", 404);
    return structuredClone(
      this.reserved && this.activeId === id
        ? { ...job, status: "running" }
        : job,
    );
  }
  private reserve() {
    if (this.closed) throw new SyncError("Service is shutting down.", 503);
    if (this.reserved)
      throw new SyncError("A maintenance task is already active.", 409);
    this.reserved = true;
  }
  async start(ids: unknown) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 50 ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      throw new SyncError("Select 1–50 unique incoming files.");
    this.reserve();
    try {
      const incoming = await this.incoming();
      const selected = ids.map((id) => {
        const file = incoming.find((f) => f.id === id);
        if (!file) throw new SyncError("Selected file no longer exists.", 409);
        return file;
      });
      const job = this.newJob(
        "sync",
        selected.map((f) => this.item(f)),
      );
      await this.launch(job);
      return this.get(job.id);
    } catch (e) {
      this.reserved = false;
      throw e;
    }
  }
  private item(file: Incoming, feedback = "", previous?: string): Item {
    return {
      id: randomUUID(),
      name: file.name,
      sourceHash: file.sourceHash,
      bytes: file.bytes,
      status: file.error ? "failed" : "queued",
      stage: "Queued",
      feedback,
      previous,
      ...(file.error ? { reason: file.error } : {}),
      textUsage: emptyUsage(),
      visualUsage: emptyUsage(),
    };
  }
  private newJob(kind: Job["kind"], items: Item[], prompt?: string): Job {
    const j: Job = {
      id: randomUUID(),
      kind,
      created: new Date().toISOString(),
      status: "queued",
      items,
      prompt,
    };
    this.jobs.set(j.id, j);
    return j;
  }
  async resync(
    jobId: string,
    itemId: string,
    feedback: unknown,
    force = false,
  ) {
    const old = this.jobs.get(jobId)?.items.find((i) => i.id === itemId);
    if (!old) throw new SyncError("Item not found.", 404);
    if (typeof feedback !== "string" || feedback.length > 16000)
      throw new SyncError("Feedback must be at most 16000 characters.");
    if (["published", "duplicate", "deleted"].includes(old.status))
      throw new SyncError(
        "This item is already committed. Use cleanup retry, or upload a new revision.",
        409,
      );
    if (this.jobs.get(jobId)!.kind === "delete")
      return this.preview(
        `${this.jobs.get(jobId)!.prompt}\n补充说明：${feedback}`,
      );
    this.reserve();
    try {
      const file = (await this.incoming()).find((f) => f.name === old.name);
      if (!file)
        throw new SyncError("Original input is missing. Upload it again.", 409);
      const item = this.item(
        file,
        `${old.feedback}${old.feedback ? "\n" : ""}${feedback}`,
        old.id,
      );
      const job = this.newJob("sync", [item]);
      // Reuse conversions only for unchanged bytes and no request to re-read/reconvert.
      if (
        !force &&
        !/重新.*(?:转换|识别|读取)|漏|识别.*错|reconvert|re.?read|missing|ocr/i.test(
          feedback,
        ) &&
        file.sourceHash === old.sourceHash
      ) {
        const oldDir = await safePath(this.directory, `work/${old.id}`);
        if (await fs.stat(oldDir).catch(() => undefined)) {
          await fs.mkdir(path.join(this.directory, "work"), {
            recursive: true,
          });
          await fs.cp(oldDir, path.join(this.directory, "work", item.id), {
            recursive: true,
            filter: async (p) => !(await fs.lstat(p)).isSymbolicLink(),
          });
        }
      }
      await this.launch(job);
      return this.get(job.id);
    } catch (e) {
      this.reserved = false;
      throw e;
    }
  }
  async preview(prompt: unknown) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000)
      throw new SyncError(
        "Enter a deletion request (maximum 16000 characters).",
      );
    this.reserve();
    try {
      const item = this.item({
        name: "Deletion preview",
        id: "",
        sourceHash: "",
        bytes: 0,
      });
      const job = this.newJob("delete", [item], prompt);
      await this.launch(job);
      return this.get(job.id);
    } catch (e) {
      this.reserved = false;
      throw e;
    }
  }
  async confirm(id: string) {
    const job = await this.get(id);
    if (
      !job ||
      job.kind !== "delete" ||
      job.status !== "awaiting_confirmation" ||
      !job.items[0]?.plan
    )
      throw new SyncError("No pending deletion preview.", 409);
    this.reserve();
    this.activeId = id;
    this.jobs.set(id, job);
    this.archived.delete(id);
    const item = job.items[0]!;
    this.controller = new AbortController();
    job.status = "running";
    item.status = "waiting_to_publish";
    try {
      await this.save(job);
    } catch (e) {
      this.reserved = false;
      this.activeId = undefined;
      throw e;
    }
    this.active = (async () => {
      try {
        await this.publisher.publish(
          item.id,
          item.plan!,
          this.controller!.signal,
        );
        job.confirmed = true;
        item.status = "deleted";
        item.stage = "Published";
        job.status = "completed";
      } catch (e) {
        item.status = "needs_review";
        item.reason = this.options.redact(e);
        job.status = "completed";
      } finally {
        job.finished = new Date().toISOString();
        try {
          await this.event(job, item);
        } finally {
          this.reserved = false;
          this.activeId = undefined;
          this.active = undefined;
          this.archive(job);
        }
      }
    })().catch((error) => {
      console.error(
        "Sync deletion report persistence failed:",
        this.options.redact(error),
      );
    });
    return this.get(id);
  }
  async stop(id: string) {
    const job = this.jobs.get(id);
    if (!job || terminal(job.status))
      throw new SyncError("No running task.", 409);
    this.controller?.abort();
    job.status = "stopping";
    await this.save(job);
    return this.get(id);
  }
  async cleanup(id: string, itemId: string) {
    this.reserve();
    let job: Job | undefined;
    try {
      job = await this.get(id);
      const item = job.items.find((i) => i.id === itemId);
      if (!item || !["published", "duplicate"].includes(item.status))
        throw new SyncError("Only committed inputs can be cleaned.");
      await this.clean(job, item);
      return structuredClone(job);
    } finally {
      if (job) this.archive(job);
      this.reserved = false;
    }
  }
  private async clean(job: Job, item: Item) {
    try {
      const file = await safePath(this.inbox, item.name);
      const bytes = await fs.readFile(file).catch((e) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
      if (bytes && hash(bytes) !== item.sourceHash)
        throw new Error("Input changed after sync; preserved the new file.");
      if (bytes) await fs.unlink(file);
      item.sourceDeleted = true;
      let attempt: Item | undefined = item;
      const seen = new Set<string>();
      while (attempt && !seen.has(attempt.id)) {
        seen.add(attempt.id);
        await fs.rm(await safePath(this.directory, `work/${attempt.id}`), {
          recursive: true,
          force: true,
        });
        const previous: string | undefined = attempt.previous;
        attempt = previous
          ? [...this.jobs.values()]
              .flatMap((j) => j.items)
              .find((i) => i.id === previous)
          : undefined;
      }
      item.cleanupError = undefined;
    } catch (e) {
      item.cleanupError = this.options.redact(e);
    }
    await this.save(job);
  }
  private async launch(job: Job) {
    this.activeId = job.id;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const planner = this.options.planner(),
      convert = this.options.converter();
    const model = this.options.modelId();
    job.status = "running";
    await this.save(job);
    this.active = this.execute(job, signal, planner, convert, model)
      .catch(async (e) => {
        job.status = "failed";
        for (const item of job.items)
          if (!terminal(item.status)) {
            item.status = "failed";
            item.reason = this.options.redact(e);
          }
        await this.save(job);
      })
      .catch((error) => {
        console.error(
          "Sync state persistence failed:",
          this.options.redact(error),
        );
      })
      .finally(() => {
        this.reserved = false;
        this.activeId = undefined;
        this.active = undefined;
        this.archive(job);
      });
  }
  private async execute(
    job: Job,
    signal: AbortSignal,
    planner: Planner,
    convert: Converter,
    model: string,
  ) {
    const converted = new Map<string, Conversion>();
    const conversionTimes = new Map<string, number>();
    let convertedBytes = 0;
    const deletions = [...this.jobs.values()]
      .filter((j) => j.kind === "delete" && j.confirmed)
      .map((j) => ({
        reason: j.prompt,
        files: j.items.flatMap((i) => i.plan?.decision.oldPaths ?? []),
        products: j.items.flatMap((i) => i.plan?.decision.products ?? []),
        documents: j.items
          .flatMap((i) => i.deletedSources ?? [])
          .map((d) => ({ path: d.path, preview: d.preview })),
        hashes: j.items
          .flatMap((i) => i.deletedSources ?? [])
          .map((d) => d.hash),
      }));
    if (job.kind === "sync")
      for (const item of job.items) {
        if (item.status === "failed") continue;
        if (signal.aborted) {
          item.status = "stopped";
          continue;
        }
        item.status = "running";
        item.stage = "Converting";
        item.started = new Date().toISOString();
        item.model = model;
        const abort = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.options.timeoutMs),
        ]);
        const conversionStart = Date.now();
        await this.event(job, item);
        try {
          const file = await safePath(this.inbox, item.name);
          if (hash(await fs.readFile(file)) !== item.sourceHash)
            throw new Error("Incoming file changed; start again.");
          const release = await knowledgeLock(this.root).read();
          let duplicate = false;
          try {
            const current = await catalog(this.root);
            duplicate = [...this.jobs.values()].some((j) =>
              j.items.some(
                (old) =>
                  old.id !== item.id &&
                  old.status === "published" &&
                  old.sourceHash === item.sourceHash &&
                  old.plan?.decision.newPath &&
                  old.publishedHash ===
                    hash(current.get(old.plan.decision.newPath) ?? ""),
              ),
            );
          } finally {
            release();
          }
          if (duplicate) {
            item.status = "duplicate";
            item.reason = "完全相同的输入已成功入库，当前资料仍存在。";
            item.stage = "Duplicate";
            await this.clean(job, item);
            continue;
          }
          const result = await convert(
            file,
            path.join(this.directory, "work", item.id),
            abort,
            item.visualUsage,
            () => this.save(job),
          );
          if (result.sourceHash !== item.sourceHash)
            throw new SyncError(
              "Input changed during conversion; start again.",
              409,
            );
          const size = Buffer.byteLength(result.markdown);
          if (
            convertedBytes + size >
            (this.options.maxBatchMarkdownBytes ?? 16 * 1024 * 1024)
          )
            throw new SyncError(
              "Batch full-text memory budget exceeded. Re-Sync this file separately.",
            );
          convertedBytes += size;
          converted.set(item.id, result);
          item.coverage = result.coverage;
          item.stage = "Converted";
          conversionTimes.set(item.id, Date.now() - conversionStart);
          await this.save(job);
        } catch (e) {
          item.coverage = await readJson<string[] | undefined>(
            path.join(this.directory, `work/${item.id}/coverage.json`),
            undefined,
          );
          item.status = signal.aborted ? "stopped" : "failed";
          item.reason = this.options.redact(e);
          item.finished = new Date().toISOString();
          await this.event(job, item);
        }
      }
    const batch = job.items.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      characters: converted.get(i.id)?.markdown.length,
      preview: converted.get(i.id)?.markdown.slice(0, 3000),
    }));
    for (const item of job.items) {
      if (job.kind === "sync" && !converted.has(item.id)) continue;
      if (signal.aborted) {
        item.status = "stopped";
        continue;
      }
      item.started ??= new Date().toISOString();
      item.model = model;
      const abort = AbortSignal.any([
        signal,
        AbortSignal.timeout(
          Math.max(
            1,
            this.options.timeoutMs - (conversionTimes.get(item.id) ?? 0),
          ),
        ),
      ]);
      try {
        abort.throwIfAborted();
        item.status = "running";
        item.stage = "Comparing and maintaining indexes";
        await this.event(job, item);
        const release = await knowledgeLock(this.root).read();
        let base: Map<string, string>;
        try {
          base = await catalog(this.root);
          this.knowledge = base;
          primeIndex(base);
        } finally {
          release();
        }
        if (
          job.kind === "sync" &&
          [...this.jobs.values()].some((j) =>
            j.items.some(
              (old) =>
                old.id !== item.id &&
                old.status === "published" &&
                old.sourceHash === item.sourceHash &&
                old.plan?.decision.newPath &&
                old.publishedHash ===
                  hash(base.get(old.plan.decision.newPath) ?? ""),
            ),
          )
        ) {
          item.status = "duplicate";
          item.stage = "Duplicate";
          item.reason = "完全相同的输入已在本批或先前成功入库。";
          await this.clean(job, item);
          continue;
        }
        const markdown = converted.get(item.id)?.markdown ?? "";
        const result = await planner({
          base,
          markdown,
          prompt:
            job.kind === "delete"
              ? `DELETE PREVIEW: ${job.prompt}`
              : `SYNC input ${item.name} (id ${item.id})`,
          feedback: item.feedback,
          candidates: new Map(
            [...converted].map(([id, c]) => [id, c.markdown]),
          ),
          batch: batch.map((b) => ({
            ...b,
            decision: job.items.find((i) => i.id === b.id)?.plan?.decision,
          })),
          deletions,
          timestamp: timestamp(),
          signal: abort,
          usage: item.textUsage,
          update: () => this.save(job),
        });
        if (
          job.kind === "sync" &&
          result.decision.action !== "review" &&
          !item.feedback.trim() &&
          deletions.some((d) => d.hashes.includes(hash(markdown)))
        )
          throw new SyncError(
            "This exact document was previously deleted as legacy. Administrator feedback is required to reintroduce it.",
          );
        item.reason = result.decision.reason;
        item.summary = result.decision.summary;
        item.plan = buildPlan(
          base,
          result.staged,
          result.decision,
          markdown,
          item.feedback,
          job.kind === "delete",
        );
        if (result.decision.action === "review") {
          item.status = "needs_review";
          item.stage = "Needs review";
        } else if (job.kind === "delete") {
          item.status = "awaiting_confirmation";
          item.stage = "Preview ready";
          job.status = "awaiting_confirmation";
        } else {
          item.stage = "Waiting to publish";
          item.status = "waiting_to_publish";
          await this.event(job, item);
          await this.publisher.publish(item.id, item.plan, abort);
          item.status = "published";
          item.stage = "Published";
          await this.event(job, item);
          await this.clean(job, item);
        }
      } catch (e) {
        item.status = signal.aborted
          ? "stopped"
          : e instanceof SyncError
            ? "needs_review"
            : "failed";
        item.reason = this.options.redact(e);
        if (job.kind === "sync" && (await this.publisher.committed(item.id))) {
          item.status = "published";
          item.stage = "Published";
          item.cleanupError =
            "Publication succeeded; retry cleanup after resolving storage errors.";
        }
      } finally {
        item.finished = new Date().toISOString();
        item.elapsedMs = Date.parse(item.finished) - Date.parse(item.started!);
        await this.event(job, item);
      }
    }
    for (const item of job.items) {
      if (!terminal(item.status))
        item.status = signal.aborted ? "stopped" : "interrupted";
      if (item.started && !item.finished) {
        item.finished = new Date().toISOString();
        item.elapsedMs = Date.parse(item.finished) - Date.parse(item.started);
      }
    }
    if (job.status !== "awaiting_confirmation")
      job.status = signal.aborted ? "stopped" : "completed";
    job.finished = new Date().toISOString();
    await this.save(job);
  }
  async close() {
    this.closed = true;
    clearInterval(this.pruneTimer);
    await this.pruning;
    this.controller?.abort();
    await this.active;
    await this.saveTail;
  }
}
