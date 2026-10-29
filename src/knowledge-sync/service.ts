import { CompletionJournal } from "../sync-notifications/journal.js";
import { usageScope } from "../usage/ledger.js";
import { compactVisualResolutions, VisualReviewError, validateVisualSubmission, visualIssue, type PartialVisualEvidence } from "./visual-review.js";
import {ReportViews} from "./report-view.js";
import { incomingWecom, contextFor, verifyRetirement } from "./wecom-sources.js";
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
  PlanError,
  safePath,
  SyncError,
  timestamp,
  terminal,
  type Attempt,
  type Conversion,
  type Job,
  type Item,
  type Plan,
  type SourceMatch,
} from "./core.js";
import { Publisher } from "./publication.js";
import { buildPlan, primeIndex, references, resolveHub } from "./validation.js";
import { sourceCoverage } from "./associations.js";
import type { Converter } from "./converter.js";
import type { Planner } from "./agent.js";
import { isIgnoredSyncFile } from "./config.js";
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
// Older reports only store append-only feedback. Recover the last non-empty
// submission by exact attempt prefixes, never by interpreting its wording.
const currentAnswer = (item: Item): string => {
  if (item.currentFeedback !== undefined) return item.currentFeedback;
  let text = item.feedback;
  for (const previous of [...(item.attempts ?? [])].reverse()) {
    const prefix = previous.feedback ? previous.feedback + "\n" : "";
    if (!text.startsWith(prefix)) continue;
    const submitted = text.slice(prefix.length);
    if (submitted.trim()) return submitted;
    text = previous.feedback;
  }
  return text;
};
const attemptOf = (item: Item): Attempt => ({
  id: item.id,
  status: item.status,
  reason: item.reason,
  summary: item.summary,
  feedback: item.feedback,
  currentFeedback: item.currentFeedback,
  started: item.started,
  finished: item.finished,
  elapsedMs: item.elapsedMs,
  textUsage: item.textUsage,
  visualUsage: item.visualUsage,
  model: item.model,
  matchedSources: item.matchedSources,
  associationOnly: item.associationOnly,
  visualReview: item.visualReview,
  visualResolutions: item.visualResolutions,
});
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
  private readonly completionJournal: CompletionJournal;
  private knowledge = new Map<string, string>();
  private jobs = new Map<string, Job>();
  private archived = new Set<string>();
  private inputHashes = new Map<string, { signature: string; hash: string }>();
  private saveTail: Promise<unknown> = Promise.resolve();
  private readonly reportViews = new ReportViews();
  private detailTail: Promise<unknown> = Promise.resolve();
  private progressSaves = new Map<string, {job: Job; timer: ReturnType<typeof setTimeout>}>();
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
    this.completionJournal = new CompletionJournal(options.dataDir);
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
        job.status = job.items.some((i) => i.status === "awaiting_confirmation")
          ? "awaiting_confirmation"
          : "interrupted";
      }
      if (job.execution && !job.finished && ["interrupted", "failed", "stopped"].includes(job.status)) job.finished = new Date().toISOString();
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
    for(const item of job.items) this.reportViews.record(item);
    const small = {
      ...job,
      items: job.items.map((i) => ({
        ...i,
        coverage: undefined,
        visualResolutions: compactVisualResolutions(i.visualResolutions),
        attempts: i.attempts?.map(a => ({ ...a, visualResolutions: compactVisualResolutions(a.visualResolutions) })),
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
    const progress = this.progressSaves.get(job.id);
    if(progress) { clearTimeout(progress.timer); this.progressSaves.delete(job.id); }
    // Serialize only when the previous write finishes, never retain queued full-report strings.
    const task = this.saveTail.then(async () => {
      for(const item of job.items) this.reportViews.record(item);
      await atomic(path.join(this.directory, "jobs", `${job.id}.json`), JSON.stringify(job));
      await this.completionJournal.job(job).catch(() => console.error("Sync completion notification deferred; report retained."));
    });
    this.saveTail = task.catch(() => {});
    await task;
  }
  private progress(job: Job): Promise<void> {
    if(!this.progressSaves.has(job.id)) {
      // Usage is advisory; critical phase/publication/stop saves remain awaited and flush it.
      const timer = setTimeout(() => {
        void this.save(job).catch(e => console.error("Sync progress save:",this.options.redact(e)));
      },1000);
      this.progressSaves.set(job.id,{job,timer});
    }
    return Promise.resolve();
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
        if (entry.name.startsWith(".") || isIgnoredSyncFile(entry.name))
          continue;
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
    if (isIgnoredSyncFile(name)) {
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > this.options.maxBytes)
          throw new SyncError(
            `File exceeds ${this.options.maxBytes / 1048576} MB upload limit.`,
            413,
          );
      }
      return { name, ignored: true as const, bytes };
    }
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
          throw new SyncError(
            `File exceeds ${this.options.maxBytes / 1048576} MB upload limit.`,
            413,
          );
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
  /** Delete one inbox file; refused while a task may be reading the inbox. */
  async removeIncoming(id: unknown) {
    if (typeof id !== "string") throw new SyncError("Invalid file id.");
    this.reserve();
    try {
      const file = (await this.incoming()).find((f) => f.id === id);
      if (!file) throw new SyncError("Incoming file no longer exists.", 404);
      const target = path.join(this.inbox, file.name);
      await safePath(path.dirname(target));
      const stat = await fs.lstat(target);
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new SyncError("Only files can be removed.");
      await fs.unlink(target);
      this.inputHashes.delete(file.name);
      return { name: file.name, removed: true };
    } finally {
      this.reserved = false;
    }
  }
  async reconcileCompletions() { for (const job of this.jobs.values()) await this.completionJournal.job(job); }
  latestCompletion() { return [...this.jobs.values()].filter(j => j.kind === "sync" && j.finished).map(j => j.finished!).sort().at(-1); }
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
  summary(id: string) {
    const job = this.jobs.get(id);
    if(!job) throw new SyncError("Sync report not found.",404);
    return this.reportViews.job(job,this.reserved && this.activeId===id);
  }
  /** At most one archived full-report parse at a time; only the requested body leaves this method. */
  async detail(id: string,itemId: string,kind: "change" | "coverage",index = 0,revision?: string) {
    const task = this.detailTail.catch(() => {}).then(async () => {
      let job = this.jobs.get(id);
      if(!job) throw new SyncError("Sync report not found.",404);
      if(this.archived.has(id)) job = await readJson<Job | undefined>(await safePath(this.directory,`jobs/${id}.json`),undefined);
      const item = job?.items.find(i=>i.id===itemId);
      if(!item) throw new SyncError("Report item not found. Refresh the report.",404);
      if(kind === "coverage") return {coverage:item.coverage??[]};
      if(!Number.isSafeInteger(index) || index<0 || !revision || !/^[a-f0-9]{64}$/.test(revision)) throw new SyncError("Invalid change request.");
      const change = item.plan?.changes[index];
      if(!change || this.reportViews.revision(item,index)!==revision) throw new SyncError("This report changed. Refresh before opening its changes.",409);
      return {change};
    });
    this.detailTail = task.then(()=>{},()=>{}); return task;
  }
  private async visualEvidence(jobId: string, itemId: string, issueId: string) {
    const job = await this.get(jobId);
    const item = job.items.find(i => i.id === itemId);
    const issue = item?.visualReview?.issues.find(i => i.id === issueId);
    if (!item || !issue) throw new SyncError("Visual issue not found. Refresh the report.", 404);
    const dir = await safePath(this.directory, `work/${item.id}`);
    const evidence = await readJson<PartialVisualEvidence | null>(await safePath(dir, `${issue.file}.partial.json`), null);
    if (!evidence || evidence.id !== issue.id || evidence.sourceHash !== item.sourceHash ||
        evidence.id !== visualIssue(evidence.sourceHash, evidence.imageHash, evidence.file, evidence.label, evidence.text, evidence.issues).id)
      throw new SyncError("Visual evidence changed. Re-Sync to review it again.", 409);
    const bytes = await fs.readFile(await safePath(dir, issue.file));
    if (hash(bytes) !== issue.imageHash) throw new SyncError("Visual image changed. Re-Sync to review it again.", 409);
    return { evidence, bytes };
  }
  async visualDetail(jobId: string, itemId: string, issueId: string) {
    const { evidence } = await this.visualEvidence(jobId, itemId, issueId);
    return { text: evidence.text, issues: evidence.issues, label: evidence.label };
  }
  async visualImage(jobId: string, itemId: string, issueId: string) {
    return (await this.visualEvidence(jobId, itemId, issueId)).bytes;
  }
  get busy() {
    return this.reserved;
  }
  private reserve() {
    if (this.closed) throw new SyncError("Service is shutting down.", 503);
    if (this.reserved)
      throw new SyncError("A maintenance task is already active.", 409);
    this.reserved = true;
  }
  /** Scheduler metadata only; manual Sync selection and validation stay intact. */
  wasAttempted(file: Incoming) {
    return [...this.jobs.values()].some(job => job.kind === "sync" &&
      job.items.some(item => item.name === file.name && item.sourceHash === file.sourceHash));
  }
  async waitFor(id: string) {
    if (this.activeId === id) await this.active;
  }
  async start(ids: unknown, expected?: ReadonlyMap<string, string>, autoRunId?: string) {
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
        if (expected && (file.error || expected.get(id) !== file.sourceHash || this.wasAttempted(file)))
          throw new SyncError("Scheduled input changed or was already handled; left for the next schedule or manual Sync.", 409);
        return file;
      });
      const job = this.newJob(
        "sync",
        selected.map((f) => this.item(f)),
      );
      await this.launch(job, undefined, autoRunId);
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
  private matches(sourceHash:string,base:Map<string,string>):SourceMatch[]{
    const matches=new Map<string,SourceMatch>();
    for(const job of this.jobs.values())for(const old of job.items){
      const decision=old.plan?.decision,source=decision?.newPath;
      if(old.status!=="published" || old.sourceHash!==sourceHash || !source || !old.publishedHash || !base.has(source) || hash(base.get(source)!)!==old.publishedHash)continue;
      const existing=matches.get(source);
      if(existing){if(!existing.inputNames.includes(old.name))existing.inputNames.push(old.name);continue;}
      matches.set(source,{path:source,markdownHash:old.publishedHash,inputNames:[old.name],slot:decision!.slot,
        ...sourceCoverage(base,source,decision!.products,{references,resolveHub})});
    }
    return [...matches.values()].sort((a,b)=>a.path.localeCompare(b.path));
  }
  private selectMatch(item:Item,matches:SourceMatch[]):SourceMatch{
    if(matches.length===1)return matches[0]!;
    const selected=matches.filter(m=>currentAnswer(item).includes(m.path));
    if(selected.length===1)return selected[0]!;
    throw new PlanError([matches.length
      ? `相同原件匹配多份已发布资料，请在反馈中明确指定一条完整 Markdown 路径：\n${matches.map(m=>m.path).join("\n")}`
      : "无法验证此前入库的正文，未修改关联。请重新上传原件，从 Incoming files 开始处理。"],true);
  }
  private fastDuplicate(item:Item,match:SourceMatch){
    return !item.associationOnly && !item.reconvert && !item.previous && !item.feedback.trim() && match.inputNames.includes(item.name) && match.products.length>0 && match.products.every(p=>match.coveredProducts.includes(p));
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
  /** Re-run one item inside its existing report; earlier attempts become history. */
  async resync(
    jobId: string,
    itemId: string,
    feedback: unknown,
    force = false,
    visualSubmission?: unknown,
  ) {
    if (typeof feedback !== "string" || feedback.length > 16000)
      throw new SyncError("Feedback must be at most 16000 characters.");
    this.reserve();
    try {
      const job = await this.get(jobId);
      const index = job.items.findIndex(
        (i) => i.id === itemId || i.attempts?.some((a) => a.id === itemId),
      );
      const old = job.items[index];
      if (!old) throw new SyncError("Item not found.", 404);
      if (["published", "deleted"].includes(old.status))
        throw new SyncError(
          "This item is already committed. Use cleanup retry, or upload a new revision.",
          409,
        );
      if (old.wecom && old.status === "duplicate")
        throw new SyncError("This verified WeCom section already has its own source binding. To review product coverage, restore its unchanged imported Markdown to Incoming files and start a new Sync with instructions; association-only review cannot change this binding.", 409);
      const submitted = visualSubmission === undefined ? undefined : validateVisualSubmission(visualSubmission, old.visualReview);
      if (submitted && (job.kind !== "sync" || old.status !== "needs_review" || old.id !== itemId || force))
        throw new SyncError("Visual decisions require a pending visual review and cannot be combined with Reconvert original.", 409);
      if (submitted) for (const decision of submitted.decisions) await this.visualEvidence(jobId, old.id, decision.issueId);
      const instructions = `${old.feedback}${old.feedback ? "\n" : ""}${feedback}`;
      const associationOnly=job.kind==="sync" && (old.status==="duplicate" || old.associationOnly===true);
      if(associationOnly && force)
        throw new SyncError("Product coverage review cannot reconvert or replace source contents. Upload the original and start a separate Sync.",409);
      if(old.status==="duplicate" && !feedback.trim())throw new SyncError("Explain which product should also reference this source.");
      let item: Item;
      if (job.kind === "delete")
        item = this.item(
          { name: old.name, id: "", sourceHash: "", bytes: 0 },
          instructions,
          old.id,
        );
      else if(associationOnly){
        item=this.item({name:old.name,id:"",sourceHash:old.sourceHash,bytes:old.bytes},instructions,old.id);
        item.associationOnly=true;item.sourceDeleted=old.sourceDeleted;
      } else {
        const file = (await this.incoming()).find((f) => f.name === old.name);
        if (!file)
          throw new SyncError(
            "Original input is missing. Upload it again.",
            409,
          );
        item = this.item(file, instructions, old.id);
        if (submitted && file.sourceHash !== old.sourceHash)
          throw new SyncError("Original input changed. Re-Sync without visual decisions to inspect the new file.", 409);
        item.reconvert=force || !submitted && /重新.*(?:转换|识别|读取)|漏|识别.*错|reconvert|re.?read|missing|ocr/i.test(feedback);
        if (file.sourceHash === old.sourceHash && !item.reconvert)
          item.visualResolutions = old.visualResolutions?.filter(r => r.sourceHash === file.sourceHash);
        if (submitted) {
          item.visualResolutions = [
            ...(item.visualResolutions ?? []).filter(r => !submitted.decisions.some(d => d.issueId === r.issueId)),
            ...submitted.decisions.filter(d => d.action !== "retry").map(d => ({
              issueId: d.issueId, sourceHash: file.sourceHash,
              action: d.action as "accept" | "supplement", ...(d.action === "supplement" ? { text: d.text } : {}),
            })),
          ];
        }
        // Reuse conversions only for unchanged bytes and no request to re-read/reconvert.
        if (
          !item.reconvert &&
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
      }
      if (submitted) {
        const dir = await safePath(this.directory, `work/${item.id}`);
        await fs.rm(await safePath(dir, "conversion.json"), { force: true });
        for (const decision of submitted.decisions.filter(d => d.action === "retry")) {
          const issue = old.visualReview!.issues.find(i => i.id === decision.issueId)!;
          await fs.rm(await safePath(dir, `${issue.file}.partial.json`), { force: true });
        }
      }
      // Preserve the legacy cumulative audit text; current instructions are
      // separate. An empty retry retains the last explicitly submitted answer.
      item.currentFeedback = feedback.trim() ? feedback : currentAnswer(old);
      item.attempts = [...(old.attempts ?? []), attemptOf(old)];
      job.items[index] = item;
      job.confirmed = undefined;
      job.finished = undefined;
      this.jobs.set(job.id, job);
      this.archived.delete(job.id);
      await this.launch(job, new Set([item.id]));
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
  async confirm(id: string, itemId?: string) {
    const job = await this.get(id);
    if (
      !job ||
      job.status !== "awaiting_confirmation" ||
      !job.items.some(
        (i) =>
          i.status === "awaiting_confirmation" &&
          i.plan &&
          (!itemId || i.id === itemId),
      )
    )
      throw new SyncError("No pending publication preview.", 409);
    const pending = job.items.filter(
      (i) =>
        i.status === "awaiting_confirmation" &&
        i.plan &&
        (!itemId || i.id === itemId),
    );
    if (pending.length !== 1)
      throw new SyncError("Choose one pending file to confirm.", 409);
    this.reserve();
    this.activeId = id;
    this.jobs.set(id, job);
    this.archived.delete(id);
    const item = pending[0]!;
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
        if (item.visualResolutions?.length) {
          const file = await safePath(this.inbox, item.name);
          if (hash(await fs.readFile(file)) !== item.sourceHash || item.visualResolutions.some(r => r.sourceHash !== item.sourceHash))
            throw new SyncError("Original input changed after visual review. Re-Sync and inspect the new file before publishing.", 409);
        }
        await this.publisher.publish(
          item.id,
          item.plan!,
          this.controller!.signal,
        );
        job.confirmed = true;
        item.status = job.kind === "delete" ? "deleted" : "published";
        item.stage = "Published";
        if (job.kind === "sync") await this.clean(job, item);
        job.status = job.items.some((i) => i.status === "awaiting_confirmation")
          ? "awaiting_confirmation"
          : "completed";
      } catch (e) {
        if (await this.publisher.committed(item.id)) {
          item.status = job.kind === "delete" ? "deleted" : "published";
          item.stage = "Published";
          if (job.kind === "sync")
            item.cleanupError =
              "Publication succeeded; retry cleanup after resolving storage errors.";
        } else {
          item.status = "failed";
          item.stage = "Not published";
        }
        item.reason = this.options.redact(e);
        job.status = job.items.some((i) => i.status === "awaiting_confirmation")
          ? "awaiting_confirmation"
          : "completed";
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
        "Sync confirmation report persistence failed:",
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
      const ids = new Set([
        item.id,
        ...(item.attempts ?? []).map((a) => a.id),
      ]);
      // Reports created before in-place Re-Sync linked attempts across jobs.
      let attempt: Item | undefined = item;
      while (attempt?.previous && !ids.has(attempt.previous)) {
        ids.add(attempt.previous);
        const previous: string = attempt.previous;
        attempt = [...this.jobs.values()]
          .flatMap((j) => j.items)
          .find((i) => i.id === previous);
      }
      for (const id of ids)
        await fs.rm(await safePath(this.directory, `work/${id}`), {
          recursive: true,
          force: true,
        });
      item.cleanupError = undefined;
    } catch (e) {
      item.cleanupError = this.options.redact(e);
    }
    await this.save(job);
  }
  private async launch(job: Job, only?: Set<string>, autoRunId?: string) {
    job.execution = { id: randomUUID(), started: new Date().toISOString(), itemIds: job.items.filter(i => !only || only.has(i.id)).map(i => i.id), ...(autoRunId ? { autoRunId } : {}) };
    job.finished = undefined;
    this.activeId = job.id;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const planner = this.options.planner(),
      convert = this.options.converter();
    const model = this.options.modelId();
    job.status = "running";
    await this.save(job);
    this.active = usageScope({ kind: "sync", id: job.execution.id }, () => this.execute(job, signal, planner, convert, model, only))
      .catch(async (e) => {
        job.status = "failed";
        job.finished = new Date().toISOString();
        for (const item of job.items)
          if (!terminal(item.status) && (!only || only.has(item.id))) {
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
    only?: Set<string>,
  ) {
    const targets = job.items.filter((i) => !only || only.has(i.id));
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
      for (const item of targets) {
        if (item.status === "failed") continue;
        if (signal.aborted) {
          item.status = "stopped";
          continue;
        }
        item.status = "converting";
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
          if (!item.associationOnly && hash(await fs.readFile(file)) !== item.sourceHash)
            throw new Error("Incoming file changed; start again.");
          const release = await knowledgeLock(this.root).read();
          let matches:SourceMatch[]=[];
          let reusable:string|undefined;
          try {
            const current = await catalog(this.root);
            item.wecom = await incomingWecom(this.options.dataDir,item.name,item.sourceHash);
            matches=item.wecom ? [] : this.matches(item.sourceHash,current);item.matchedSources=matches;
            if(item.associationOnly || matches.length && !item.reconvert){
              const selected=this.selectMatch(item,matches);
              const fast=this.fastDuplicate(item,selected);
              if(fast){
                item.status="duplicate";item.stage="Duplicate";
                item.reason=`同名同内容输入已入库，已核对当前覆盖：${selected.coveredProducts.join(", ")}。如需增加型号，请使用下方 Review product coverage。\n匹配正文：${selected.path}`;
              }else{item.associationOnly=true;reusable=current.get(selected.path)!;}
            }
          } finally {
            release();
          }
          if (item.status==="duplicate") {
            await this.clean(job, item);
            continue;
          }
          const result:Conversion = reusable!==undefined ? {markdown:reusable,sourceHash:item.sourceHash,coverage:["Reused verified published Markdown for product coverage review; source contents remain unchanged."],visual:emptyUsage(),version:0} : await convert(
            file,
            path.join(this.directory, "work", item.id),
            abort,
            item.visualUsage,
            () => this.progress(job),
            item.visualResolutions,
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
          item.visualReview = undefined;
          item.visualResolutions = result.visualResolutions;
          item.status = "converted";
          item.stage = "Converted · waiting for analysis";
          conversionTimes.set(item.id, Date.now() - conversionStart);
          await this.save(job);
        } catch (e) {
          item.coverage = await readJson<string[] | undefined>(
            path.join(this.directory, `work/${item.id}/coverage.json`),
            undefined,
          );
          const visual = e instanceof VisualReviewError;
          if (visual) item.visualReview = e.review;
          item.status = signal.aborted ? "stopped" : visual || e instanceof PlanError && e.review ? "needs_review" : "failed";
          item.stage = item.status === "needs_review" ? "Needs your decision" : signal.aborted ? "Stopped" : "Conversion failed · nothing published";
          item.reason = this.options.redact(e);
          item.finished = new Date().toISOString();
          await this.event(job, item);
        }
      }
    const batch = targets.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      characters: converted.get(i.id)?.markdown.length,
      preview: converted.get(i.id)?.markdown.slice(0, 3000),
    }));
    for (const item of targets) {
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
        item.status = "analyzing";
        item.stage = "Analyzing and maintaining indexes";
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
        let association:SourceMatch|undefined;
        if(job.kind==="sync" && !item.wecom){
          const matches=this.matches(item.sourceHash,base);item.matchedSources=matches;
          if(item.associationOnly || matches.length && !item.reconvert){
            association=this.selectMatch(item,matches);
            const fast=this.fastDuplicate(item,association);
            if(fast){
              item.status="duplicate";item.stage="Duplicate";item.reason=`同名同内容输入已入库，已核对当前覆盖：${association.coveredProducts.join(", ")}。\n匹配正文：${association.path}`;
              await this.clean(job,item);continue;
            }
            item.associationOnly=true;
          }
        }
        const markdown = association ? base.get(association.path)! : converted.get(item.id)?.markdown ?? "";
        const wecom = item.wecom ? contextFor(item.wecom,base) : undefined;
        if (wecom?.previous && !wecom.previous.withdrawn && !item.feedback.trim() && wecom.previous.hash === hash(markdown)) {
          item.status="duplicate";item.stage="Duplicate";item.reason="已核验同一 WeCom 文档/工作表的已发布正文，无需重复发布。";
          await this.clean(job,item);continue;
        }
        const result = await planner({
          base,
          markdown,
          prompt:
            job.kind === "delete"
              ? `DELETE PREVIEW: ${job.prompt}`
              : `SYNC input ${item.name} (id ${item.id})`,
          feedback: currentAnswer(item),
          feedbackHistory: item.currentFeedback !== undefined ? item.attempts?.at(-1)?.feedback : undefined,
          deletion: job.kind === "delete",
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
          update: () => this.progress(job),
          association,
          wecom,
          validate: decision => verifyRetirement(this.options.dataDir,base,decision),
        });
        if (
          job.kind === "sync" &&
          result.decision.action !== "review" &&
          !item.feedback.trim() &&
          deletions.some((d) => d.hashes.includes(hash(markdown)))
        )
          throw new PlanError(
            [
              "This exact document was previously deleted as legacy. Administrator feedback is required to reintroduce it.",
            ],
            true,
          );
        await verifyRetirement(this.options.dataDir,base,result.decision);
        item.reason = result.decision.reason;
        item.summary = result.decision.summary;
        item.plan = buildPlan(
          base,
          result.staged,
          result.decision,
          markdown,
          currentAnswer(item),
          job.kind === "delete",
          association,
          wecom,
        );
        if (result.decision.action !== "review" && item.visualResolutions?.length)
          item.plan.confirmationReason = `Review the accepted visual omissions and administrator supplements before publishing (${item.visualResolutions.length} region(s)).`;
        if (result.decision.action === "review") {
          item.status = "needs_review";
          item.stage = "Needs your decision";
        } else if (result.decision.action==="associate" && !item.plan.changes.length && !item.feedback.trim()){
          item.status="duplicate";item.stage="Duplicate";
          item.reason=`已核对，要求覆盖的型号均已关联：${result.decision.products.join(", ")}。\n匹配正文：${association!.path}`;
          await this.clean(job,item);
        } else if (job.kind === "delete" || item.plan.confirmationReason || result.decision.action==="associate") {
          if(result.decision.action==="associate" && !item.plan.confirmationReason)item.plan.confirmationReason=`Confirm existing coverage: ${result.decision.products.join(", ")} → ${association!.path}. No source or index changes are proposed.`;
          item.status = "awaiting_confirmation";
          item.stage = "Preview ready";
          if (item.plan.confirmationReason)
            item.reason = item.plan.confirmationReason;
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
        const review = e instanceof PlanError && e.review;
        item.status = signal.aborted
          ? "stopped"
          : review
            ? "needs_review"
            : "failed";
        item.stage = signal.aborted
          ? "Stopped"
          : review
            ? "Needs your decision"
            : e instanceof PlanError
              ? "Automatic checks failed · nothing published"
              : "Failed · nothing published";
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
    job.status = job.items.some((i) => i.status === "awaiting_confirmation")
      ? "awaiting_confirmation"
      : signal.aborted
        ? "stopped"
        : "completed";
    job.finished = new Date().toISOString();
    await this.save(job);
  }
  async close() {
    this.closed = true;
    clearInterval(this.pruneTimer);
    await this.pruning;
    this.controller?.abort();
    await this.active;
    await Promise.all([...this.progressSaves.values()].map(p=>this.save(p.job)));
    await this.saveTail;
    await this.detailTail;
  }
}
