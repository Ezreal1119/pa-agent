import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  atomic,
  hash,
  readJson,
  safePath,
  SyncError,
} from "../knowledge-sync/core.js";
import { SftpPathsEditor } from "../sftp-sync/paths-editor.js";
import {
  checkDocs,
  parseDocs,
  kind,
  FORMAT_VERSION,
  MAX_SNAPSHOT_BYTES,
  type Source,
  type WecomConfig,
} from "./config.js";
import { CliReader, WecomError, type Reader } from "./client.js";
import { Collector, sectionHash, markdown, type Snapshot } from "./snapshot.js";
export type Output = {
  key: string;
  title: string;
  status: string;
  hash: string;
  target: string;
  bytes: number;
};
export type Item = Source & {
  status: string;
  stage?: string;
  version?: string;
  title?: string;
  error?: string;
  coverage?: string[];
  outputs: Output[];
  removedSheets?: string[];
};
export type Run = {
  id: string;
  created: string;
  finished?: string;
  status: string;
  items: Item[];
  counts: Record<string, number>;
  error?: string;
  removedSources?: string[];
};
type Receipt = { hash: string; target: string; markdownHash: string };
type PendingOutput = Output & {
  stage: string;
  markdownHash: string;
  expected?: string;
  done?: boolean;
};
type Pending = {
  run: string;
  snapshotFile: string;
  snapshotHash: string;
  outputs: PendingOutput[];
};
type Entry = {
  docid: string;
  version?: string;
  snapshotFile?: string;
  snapshotHash?: string;
  sections: Record<string, Receipt>;
  activeKeys: string[];
  pending?: Pending;
};
type State = { version: 1; sources: Record<string, Entry> };
type Options = {
  dataDir: string;
  config: WecomConfig;
  reader?: Reader;
  disk?: (bytes: number) => Promise<void>;
};
const active = (s: string) => ["running", "stopping"].includes(s),
  now = () => new Date().toISOString(),
  hex = /^[a-f0-9]{64}$/,
  uuid = /^[a-f0-9-]{36}$/;
const plain = (o: unknown): o is Record<string, any> =>
  !!o && typeof o === "object" && !Array.isArray(o);
const targetName = (s: unknown): s is string =>
  typeof s === "string" &&
  /^WeCom-[a-f0-9]{16}-.+\.md$/.test(s) &&
  s === path.basename(s) &&
  Buffer.byteLength(s) <= 220 &&
  !/[\\\x00-\x1f\x7f]/.test(s);
function slug(title: string) {
  let s = title.replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, "_").trim() || "document";
  while (Buffer.byteLength(s) > 100) s = Array.from(s).slice(0, -1).join("");
  return s;
}
export class WecomImportService {
  readonly root: string;
  readonly inbox: string;
  readonly work: string;
  private reader: Reader;
  private editor: SftpPathsEditor;
  private running?: {
    id: string;
    controller: AbortController;
    task: Promise<void>;
  };
  private starting = false;
  private closing = false;
  private recoveryError?: string;
  constructor(private options: Options) {
    this.root = path.join(options.dataDir, "logs", "wecom_sync");
    this.inbox = path.join(
      options.dataDir,
      "urovo-product-expert",
      "newly_added",
    );
    this.work = path.join(this.inbox, ".wecom-import-work");
    this.reader = options.reader ?? new CliReader(options.config);
    this.editor = new SftpPathsEditor(
      options.config.docsFile,
      this.root,
      checkDocs,
    );
  }
  redact(e: unknown) {
    return (e instanceof Error ? e.message : "WeCom import failed.")
      .replace(
        /(Bearer\s+|(?:secret|token|authorization)\s*[:=]\s*)\S+/gi,
        "[REDACTED]",
      )
      .slice(0, 1800);
  }
  private async lock() {
    await safePath(this.root);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await safePath(this.root, "runner.lock");
    return lockfile
      .lock(path.join(this.root, "runner"), {
        realpath: false,
        stale: 60000,
        update: 10000,
        retries: 0,
        onCompromised: (e) => this.running?.controller.abort(e),
      })
      .catch((e) => {
        if (e.code === "ELOCKED")
          throw new SyncError("A WeCom import is already running.", 409);
        throw e;
      });
  }
  private async directories() {
    for (const dir of [this.inbox, this.work, path.join(this.root, "cache")]) {
      await safePath(dir);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }
  private stateFile() {
    return path.join(this.root, "state.json");
  }
  private async state(): Promise<State> {
    const s = await readJson<State>(this.stateFile(), {
      version: 1,
      sources: {},
    });
    const cache = (n: unknown): n is string =>
      typeof n === "string" && /^[a-f0-9-]{36}\.json$/.test(n);
    if (s.version !== 1 || !plain(s.sources))
      throw new SyncError(
        "Invalid WeCom state. Restore a trusted state file; it will not be reset.",
      );
    const targets = new Set<string>();
    for (const [key, e] of Object.entries(s.sources)) {
      if (
        !hex.test(key) ||
        !plain(e) ||
        typeof e.docid !== "string" ||
        hash(e.docid) !== key ||
        !plain(e.sections) ||
        !Array.isArray(e.activeKeys) ||
        !e.activeKeys.every((k) => typeof k === "string") ||
        (e.version !== undefined && typeof e.version !== "string")
      )
        throw new SyncError("Invalid WeCom source state.");
      kind(e.docid);
      e.sections = Object.assign(Object.create(null), e.sections);
      if (
        e.snapshotFile &&
        (!cache(e.snapshotFile) || !hex.test(e.snapshotHash || ""))
      )
        throw new SyncError("Invalid cached WeCom snapshot.");
      for (const [sectionKey, r] of Object.entries(e.sections)) {
        if (
          !plain(r) ||
          !hex.test(r.hash) ||
          !hex.test(r.markdownHash) ||
          !targetName(r.target) ||
          !r.target.startsWith(
            `WeCom-${hash(e.docid + "\0" + sectionKey).slice(0, 16)}-`,
          ) ||
          targets.has(r.target)
        )
          throw new SyncError("Invalid or conflicting WeCom delivery state.");
        targets.add(r.target);
      }
      if (e.pending) {
        const p = e.pending;
        if (
          !plain(p) ||
          !uuid.test(p.run) ||
          !cache(p.snapshotFile) ||
          !hex.test(p.snapshotHash) ||
          !Array.isArray(p.outputs)
        )
          throw new SyncError("Invalid pending WeCom delivery.");
        const keys = new Set<string>();
        for (const o of p.outputs)
          if (
            !plain(o) ||
            typeof o.key !== "string" ||
            keys.has(o.key) ||
            !hex.test(o.hash) ||
            !targetName(o.target) ||
            !o.target.startsWith(
              `WeCom-${hash(e.docid + "\0" + o.key).slice(0, 16)}-`,
            ) ||
            !hex.test(o.markdownHash) ||
            !/^[a-f0-9]{8}-[a-f0-9-]{27}\.part$/.test(o.stage) ||
            (o.expected !== undefined && !hex.test(o.expected)) ||
            typeof o.bytes !== "number" ||
            !Number.isSafeInteger(o.bytes) ||
            o.bytes < 0 ||
            o.bytes > MAX_SNAPSHOT_BYTES ||
            (o.done !== undefined && typeof o.done !== "boolean")
          )
            throw new SyncError("Invalid pending WeCom output.");
          else keys.add(o.key);
      }
    }
    return s;
  }
  private saveState(state: State) {
    return atomic(this.stateFile(), JSON.stringify(state, null, 2) + "\n");
  }
  async readDocs() {
    return this.editor.read();
  }
  checkDocs(text: unknown) {
    return checkDocs(text);
  }
  async saveDocs(text: unknown, revision: unknown) {
    const release = await this.lock();
    try {
      return await this.editor.save(text, revision);
    } finally {
      await release();
    }
  }
  async get(id: string): Promise<Run> {
    if (!uuid.test(id)) throw new SyncError("WeCom report not found.", 404);
    const r = await readJson<Run | undefined>(
      path.join(this.root, id + ".json"),
      undefined,
    );
    if (!r) throw new SyncError("WeCom report not found.", 404);
    return r;
  }
  async list() {
    const names = await fs.readdir(this.root).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const files = await Promise.all(
      names
        .filter((n) => /^[a-f0-9-]{36}\.summary\.json$/.test(n))
        .map(async (n) => ({
          n,
          time: (await fs.lstat(await safePath(this.root, n))).mtimeMs,
        })),
    );
    files.sort((a, b) => b.time - a.time);
    return Promise.all(
      files
        .slice(0, 100)
        .map((f) =>
          readJson<Omit<Run, "items">>(path.join(this.root, f.n), null!),
        ),
    );
  }
  private async save(run: Run) {
    run.counts = {};
    for (const i of run.items)
      run.counts[i.status] = (run.counts[i.status] || 0) + 1;
    await atomic(
      path.join(this.root, run.id + ".json"),
      JSON.stringify(run, null, 2) + "\n",
    );
    const { items, ...small } = run;
    await atomic(
      path.join(this.root, run.id + ".summary.json"),
      JSON.stringify(small) + "\n",
    );
  }
  private async event(run: Run, type: string, item?: Item) {
    await fs.appendFile(
      await safePath(this.root, run.id + ".jsonl"),
      JSON.stringify({
        time: now(),
        type,
        run: run.id,
        status: run.status,
        ...(item ? { item } : {}),
      }) + "\n",
      { mode: 0o600 },
    );
  }
  private async disk(bytes: number) {
    if (this.options.disk) return this.options.disk(bytes);
    for (const dir of [this.root, this.work]) {
      const s = await fs.statfs(dir);
      if (s.bavail * s.bsize < this.options.config.reserveBytes + bytes)
        throw new WecomError(
          "Insufficient disk space. Keep 256 MiB free in addition to snapshot storage.",
          true,
        );
    }
  }
  private async file(file: string) {
    await safePath(path.dirname(file));
    const s = await fs.lstat(file).catch((e) => {
      if (e.code === "ENOENT") return;
      throw e;
    });
    if (!s) return;
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      s.size > MAX_SNAPSHOT_BYTES
    )
      throw new WecomError("Unsafe or oversized WeCom storage file.", true);
    return {
      bytes: await fs.readFile(
        await safePath(path.dirname(file), path.basename(file)),
      ),
      stat: s,
    };
  }
  private async snapshot(file: string, digest: string): Promise<Snapshot> {
    const b = await this.file(path.join(this.root, "cache", file));
    if (!b || hash(b.bytes) !== digest)
      throw new WecomError(
        "Cached snapshot is missing or changed. Preserve state for recovery.",
        true,
      );
    const s = JSON.parse(b.bytes.toString("utf8"));
    if (s.schema !== FORMAT_VERSION || !Array.isArray(s.sections))
      throw new WecomError("Unsupported snapshot format.", true);
    return s;
  }
  private async syncDir(dir: string) {
    const h = await fs.open(dir, "r");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  }
  private async publish(state: State, e: Entry) {
    const p = e.pending!;
    const snapshot = await this.snapshot(p.snapshotFile, p.snapshotHash);
    if (snapshot.docid !== e.docid)
      throw new WecomError("Pending snapshot identity does not match.", true);
    for (const o of p.outputs) {
      if (o.done) continue;
      const stage = path.join(this.work, o.stage),
        target = path.join(this.inbox, o.target);
      await safePath(this.work);
      await safePath(this.inbox);
      const a = await fs.lstat(stage).catch((err) => {
          if (err.code === "ENOENT") return;
          throw err;
        }),
        b = await fs.lstat(target).catch((err) => {
          if (err.code === "ENOENT") return;
          throw err;
        });
      if (
        a &&
        b &&
        a.isFile() &&
        b.isFile() &&
        !a.isSymbolicLink() &&
        !b.isSymbolicLink() &&
        a.ino === b.ino &&
        a.dev === b.dev &&
        a.nlink === 2 &&
        b.nlink === 2
      ) {
        if (hash(await fs.readFile(stage)) !== o.markdownHash)
          throw new WecomError("Pending linked content changed.", true);
        await fs.unlink(stage);
      } else {
        const saved = await this.file(stage),
          existing = await this.file(target);
        if (existing && hash(existing.bytes) === o.markdownHash) {
          if (saved) await fs.unlink(stage);
        } else {
          if (!saved || hash(saved.bytes) !== o.markdownHash)
            throw new WecomError(
              "Pending delivery cannot be verified. Preserve state and files for manual recovery.",
              true,
            );
          if (existing && (!o.expected || hash(existing.bytes) !== o.expected))
            throw new WecomError(
              "Incoming file was edited outside this importer. Preserve the pending delivery for review.",
              true,
            );
          if (existing) await fs.rename(stage, target);
          else {
            await fs.link(stage, target);
            await fs.unlink(stage);
          }
        }
      }
      await this.syncDir(this.inbox);
      o.done = true;
      await this.saveState(state);
    }
    for (const o of p.outputs)
      e.sections[o.key] = {
        hash: o.hash,
        target: o.target,
        markdownHash: o.markdownHash,
      };
    e.version = snapshot.version;
    e.activeKeys = snapshot.sections.map((s) => s.key);
    e.snapshotFile = p.snapshotFile;
    e.snapshotHash = p.snapshotHash;
    delete e.pending;
    await this.saveState(state);
    const report = await this.get(p.run);
    const item = report.items.find((i) => i.docid === e.docid);
    if (item) {
      item.version = snapshot.version;
      item.coverage = snapshot.coverage;
      item.outputs = item.outputs.map((o) => ({ ...o, status: "delivered" }));
      item.status = "delivered";
      delete item.error;
      await this.save(report);
      await this.event(report, "delivery_committed", item);
    }
  }
  private async recover() {
    await this.directories();
    const state = await this.state();
    for (const e of Object.values(state.sources))
      if (e.pending) await this.publish(state, e);
    for (const report of await this.list())
      if (active(report.status)) {
        const run = await this.get(report.id);
        for (const i of run.items)
          if (
            ["pending", "checking", "reading", "publishing"].includes(i.status)
          ) {
            i.status = "interrupted";
            i.error =
              "Process stopped before this document completed. Run again to resume.";
          }
        run.status = "interrupted";
        run.finished = now();
        await this.save(run);
        await this.event(run, "interrupted");
      }
    const referenced = new Set(
      Object.values(state.sources).flatMap((e) =>
        [e.snapshotFile, e.pending?.snapshotFile].filter(Boolean),
      ),
    );
    for (const f of await fs.readdir(path.join(this.root, "cache")))
      if (/^[a-f0-9-]{36}\.json$/.test(f) && !referenced.has(f))
        await fs.unlink(await safePath(path.join(this.root, "cache"), f));
    for (const f of await fs.readdir(this.work)) {
      if (/^[a-f0-9-]{36}\.part$/.test(f))
        await fs.unlink(await safePath(this.work, f));
      else if (/^word-[A-Za-z0-9]{6}$/.test(f))
        await fs.rm(await safePath(this.work, f), {
          recursive: true,
          force: true,
        });
    }
  }
  async init() {
    const release = await this.lock().catch((e) => {
      if (e instanceof SyncError && e.status === 409) return;
      throw e;
    });
    if (!release) return;
    try {
      await this.recover();
      this.recoveryError = undefined;
    } catch (e) {
      this.recoveryError = this.redact(e);
    } finally {
      await release();
    }
  }
  async status() {
    let reports = await this.list();
    if (
      !this.running &&
      !this.starting &&
      reports.some((r) => active(r.status))
    ) {
      await this.init();
      reports = await this.list();
    }
    let documents = 0,
      listError: string | undefined;
    try {
      const list = await this.readDocs();
      if (!list.check.valid)
        listError = list.check.errors
          .map((e) => `Line ${e.line}: ${e.message}`)
          .join("\n");
      documents = list.check.count;
    } catch (e) {
      listError = this.redact(e);
    }
    const authorizedDirectory = !!(
      await fs.stat(this.options.config.authDir).catch(() => null)
    )?.isDirectory();
    return {
      configured: authorizedDirectory,
      configurationError: authorizedDirectory
        ? undefined
        : "Initialize the official CLI authorization directory on the VPS.",
      documents,
      listError,
      docsFile: this.options.config.docsFile,
      recoveryError: this.recoveryError,
      reports,
      running: this.running?.id || reports.find((r) => active(r.status))?.id,
    };
  }
  async start(): Promise<Run> {
    if (this.closing || this.starting || this.running)
      throw new SyncError("WeCom importer is running or shutting down.", 409);
    this.starting = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.lock();
      await this.recover();
      this.recoveryError = undefined;
      const entries = parseDocs((await this.readDocs()).text);
      if (this.reader instanceof CliReader) await this.reader.preflight();
      if (this.closing)
        throw new SyncError("WeCom importer is shutting down.", 409);
      const run: Run = {
        id: randomUUID(),
        created: now(),
        status: "running",
        items: entries.map((e) => ({ ...e, status: "pending", outputs: [] })),
        counts: {},
      };
      await this.save(run);
      await this.event(run, "started");
      const controller = new AbortController(),
        unlock = release;
      release = undefined;
      const marker = path.join(this.root, run.id + ".stop");
      let polling = false;
      const watch = setInterval(() => {
        if (polling) return;
        polling = true;
        void fs
          .lstat(marker)
          .then(() => controller.abort(new Error("Stopped by administrator.")))
          .catch((e) => {
            if (e.code !== "ENOENT") controller.abort(e);
          })
          .finally(() => {
            polling = false;
          });
      }, 500);
      const deadline = setTimeout(
        () =>
          controller.abort(
            new Error("Import exceeded its two-hour batch deadline."),
          ),
        2 * 60 * 60 * 1000,
      );
      const task = Promise.resolve()
        .then(() => this.execute(run, controller.signal))
        .catch(async (e) => {
          run.status = controller.signal.aborted ? "stopped" : "failed";
          run.error = this.redact(e);
          run.finished = now();
          for (const i of run.items)
            if (
              ["pending", "checking", "reading", "publishing"].includes(
                i.status,
              )
            ) {
              i.status = controller.signal.aborted ? "stopped" : "failed";
              i.error = run.error;
            }
          await this.save(run);
          await this.event(run, "failed");
        })
        .finally(async () => {
          clearInterval(watch);
          clearTimeout(deadline);
          try {
            await fs.rm(marker, { force: true });
          } finally {
            try {
              await unlock();
            } finally {
              this.running = undefined;
            }
          }
        });
      this.running = { id: run.id, controller, task };
      void task.catch(() => {});
      if (this.closing) controller.abort(new Error("Service shutting down."));
      return structuredClone(run);
    } finally {
      this.starting = false;
      if (release) await release();
    }
  }
  private async execute(run: Run, signal: AbortSignal) {
    const state = await this.state(),
      collector = new Collector(this.reader, this.options.config);
    const listed = new Set(run.items.map((i) => i.docid));
    run.removedSources = Object.values(state.sources)
      .filter((e) => !listed.has(e.docid))
      .map((e) => e.docid);
    let stopBatch = false;
    for (const item of run.items) {
      if (signal.aborted || stopBatch) {
        item.status = signal.aborted ? "stopped" : "not_attempted";
        continue;
      }
      const id = hash(item.docid),
        entry: Entry = state.sources[id] ?? {
          docid: item.docid,
          sections: Object.create(null),
          activeKeys: [],
        };
      const timed = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.options.config.documentTimeoutMs),
      ]);
      try {
        item.status = "checking";
        item.stage = "Checking document version";
        await this.save(run);
        let revision: string | undefined;
        if (kind(item.docid) === "sheet") {
          revision = await collector.getVersion(item.docid, timed);
          item.version = revision;
          if (
            entry.version === revision &&
            entry.snapshotFile &&
            entry.snapshotHash
          ) {
            const old = await this.snapshot(
              entry.snapshotFile,
              entry.snapshotHash,
            );
            item.title = old.title;
            item.status = "unchanged";
            item.stage = "Version unchanged; full read skipped";
            item.coverage = old.coverage;
            await this.save(run);
            await this.event(run, "unchanged_version", item);
            continue;
          }
        }
        item.status = "reading";
        await this.save(run);
        await this.disk(MAX_SNAPSHOT_BYTES);
        const snapshot = await collector.collect(
          item.docid,
          timed,
          this.work,
          revision,
          async (stage) => {
            item.stage = stage;
            await this.save(run);
          },
        );
        timed.throwIfAborted();
        item.title = snapshot.title;
        item.version = snapshot.version;
        item.coverage = snapshot.coverage;
        item.removedSheets = entry.activeKeys.filter(
          (k) => !snapshot.sections.some((s) => s.key === k),
        );
        const changed = snapshot.sections.filter(
          (s) => entry.sections[s.key]?.hash !== sectionHash(snapshot, s),
        );
        const snapshotFile = randomUUID() + ".json",
          snapshotText = JSON.stringify(snapshot);
        if (Buffer.byteLength(snapshotText) > MAX_SNAPSHOT_BYTES)
          throw new WecomError("Text snapshot exceeds 16 MiB.");
        await this.disk(Buffer.byteLength(snapshotText));
        await atomic(path.join(this.root, "cache", snapshotFile), snapshotText);
        state.sources[id] = entry;
        if (!changed.length) {
          entry.version = snapshot.version;
          entry.activeKeys = snapshot.sections.map((s) => s.key);
          entry.snapshotFile = snapshotFile;
          entry.snapshotHash = hash(snapshotText);
          await this.saveState(state);
          item.status = "unchanged";
          item.stage = "Text unchanged; no Markdown generated";
          await this.save(run);
          await this.event(run, "unchanged_text", item);
          continue;
        }
        const outputs: PendingOutput[] = [];
        try {
          for (const section of changed) {
            timed.throwIfAborted();
            const previous = entry.sections[section.key],
              digest = sectionHash(snapshot, section),
              body = markdown(snapshot, section),
              target =
                previous?.target ??
                `WeCom-${hash(item.docid + "\0" + section.key).slice(0, 16)}-${slug(section.title)}.md`;
            const existing = await this.file(path.join(this.inbox, target));
            const mdHash = hash(body);
            if (
              existing &&
              hash(existing.bytes) !== mdHash &&
              (!previous || hash(existing.bytes) !== previous.markdownHash)
            )
              throw new WecomError(
                "Incoming file differs from the last managed copy. Resolve the manual-edit conflict first.",
              );
            await this.disk(Buffer.byteLength(body));
            const stage = randomUUID() + ".part";
            await atomic(path.join(this.work, stage), body);
            outputs.push({
              key: section.key,
              title: section.title,
              status: "pending",
              hash: digest,
              target,
              bytes: Buffer.byteLength(body),
              stage,
              markdownHash: mdHash,
              ...(previous ? { expected: previous.markdownHash } : {}),
            });
          }
        } catch (e) {
          for (const o of outputs)
            await fs.rm(path.join(this.work, o.stage), { force: true });
          throw e;
        }
        item.outputs = outputs.map(
          ({ stage, markdownHash, expected, done, ...o }) => o,
        );
        item.status = "publishing";
        item.stage = "Delivering verified text snapshots";
        await this.save(run);
        entry.pending = {
          run: run.id,
          snapshotFile,
          snapshotHash: hash(snapshotText),
          outputs,
        };
        await this.saveState(state);
        await this.publish(state, entry);
        item.outputs = item.outputs.map((o) => ({ ...o, status: "delivered" }));
        item.status = "delivered";
        item.stage = "Delivered to Incoming files";
      } catch (e) {
        item.status = signal.aborted ? "stopped" : "failed";
        item.error = this.redact(e);
        if (
          (e instanceof WecomError && e.fatal) ||
          entry.pending ||
          (e as NodeJS.ErrnoException).code === "ENOSPC"
        )
          stopBatch = true;
      }
      await this.save(run);
      await this.event(run, "document_finished", item);
    }
    run.status = signal.aborted
      ? "stopped"
      : run.items.some((i) => ["failed", "not_attempted"].includes(i.status))
        ? "completed_with_errors"
        : "completed";
    run.finished = now();
    await this.save(run);
    await this.event(run, "finished");
  }
  async stop(id: string) {
    const run = await this.get(id);
    if (active(run.status)) {
      if (this.running?.id === id)
        this.running.controller.abort(new Error("Stopped by administrator."));
      else await atomic(path.join(this.root, id + ".stop"), "stop\n");
    }
    return run;
  }
  async wait() {
    await this.running?.task;
  }
  async close() {
    this.closing = true;
    this.running?.controller.abort(new Error("Service shutting down."));
    await this.wait();
  }
}
