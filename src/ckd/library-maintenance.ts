import fs from "node:fs";
import { runLibrarySync } from "./library-sync.js";
import { createImageScorer, scoringContext } from './image-scorer.js';
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson } from "./store.js";
import { acquireDirectoryLock, acquireLibraryLock, libraryPendingMarker } from "./library-lock.js";
import { fileHash, readObject, safePath, sha, targets, validateInput } from "./library-source.js";
import { HttpLibraryModel, type LibraryModel } from "./library-model.js";
import { importLegacyTranslations, runTranslations, translateText, translationRegistryKey } from "./library-translation.js";
import { runSummaries } from "./library-summaries.js";
import type { LibraryJob, LibraryJobItem, LibraryJobKind, LibraryMaintenanceOptions, MaintenanceContext, ManagedTranslation } from "./library-job-types.js";
import type { MaintenanceInput } from "./library-source.js";
const terminal = new Set(["completed", "cancelled"]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export class LibraryMaintenance {
    readonly root: string;
    private readonly active = new Map<string, AbortController>();
    private readonly model: LibraryModel;
    constructor(readonly options: LibraryMaintenanceOptions) {
        this.root = path.resolve(options.dataDir, "ckd/library-jobs");
        fs.mkdirSync(this.root, { recursive: true });
        const delegate = options.model ?? new HttpLibraryModel({ timeoutMs: options.modelTimeoutMs });
        this.model = { complete: async (request, signal) => {
                const controller = new AbortController();
                const forward = () => controller.abort(signal.reason);
                signal.addEventListener("abort", forward, { once: true });
                if (signal.aborted)
                    forward();
                const timeout = setTimeout(() => controller.abort(new Error("Library model request timed out.")), options.modelTimeoutMs ?? 300000);
                try {
                    controller.signal.throwIfAborted();
                    const result = await Promise.race([delegate.complete(request, controller.signal), new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))]);
                    if (!result.text?.trim())
                        throw new Error("Model returned empty output.");
                    return result;
                }
                finally {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", forward);
                }
            } };
    }
    private directory(id: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))
        throw new Error("Invalid Library job ID."); return path.join(this.root, id); }
    get(id: string): LibraryJob {
        const job = readObject(path.join(this.directory(id), "state.json")) as LibraryJob | undefined;
        if (!job)
            throw Object.assign(new Error("Library job not found."), { code: "ENOENT" });
        if (job.id !== id || job.schemaVersion !== 1)
            throw new Error("Invalid Library job state.");
        if (job.status === "running" && !this.active.has(id)) {
            let alive = false;
            try {
                if (job.ownerPid) {
                    process.kill(job.ownerPid, 0);
                    alive = true;
                }
            }
            catch { }
            if (!alive || !fs.existsSync(path.join(this.directory(id), "job.lock")))
                job.status = "interrupted";
        }
        return job;
    }
    list(): LibraryJob[] { return fs.readdirSync(this.root).filter(id => /^[0-9a-f-]{36}$/u.test(id) && fs.existsSync(path.join(this.root, id, "state.json"))).map(id => this.get(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    private progressView(job: LibraryJob) {
        const images = job.sync?.images ?? [];
        const unique = new Map(images.map(image => [image.imageHash, image]));
        return { schemaVersion: 1, id: job.id, kind: job.kind, input: job.input, status: job.status,
            createdAt: job.createdAt, updatedAt: job.updatedAt, ownerPid: job.ownerPid, currentItem: job.currentItem,
            total: job.total, completed: job.completed, counts: job.counts, error: job.error,
            warningCount: job.warnings.length,
            sync: job.sync && { stage: job.sync.stage, stages: job.sync.stages,
                deletedFiles: job.sync.deletions?.filter(item => item.kind === "file").length ?? 0,
                deletedDirectories: job.sync.deletions?.filter(item => item.kind === "directory").length ?? 0,
                imageStats: { paths: images.length, unique: unique.size,
                    needsReview: [...unique.values()].filter(image => image.fallback || image.result?.reminder).length,
                    errors: [...unique.values()].filter(image => image.error).length } } };
    }
    private saveProgress(job: LibraryJob) { atomicJson(path.join(this.directory(job.id), "progress.json"), this.progressView(job)); }
    private save(job: LibraryJob) { job.updatedAt = new Date().toISOString(); atomicJson(path.join(this.directory(job.id), "state.json"), job); this.saveProgress(job); }
    getProgress(id: string) {
        let view: ReturnType<LibraryMaintenance["progressView"]> | undefined;
        try { view = readObject(path.join(this.directory(id), "progress.json")) as typeof view; }
        catch { /* The authoritative state is still available after a partial progress write. */ }
        if (!view || view.id !== id || view.schemaVersion !== 1) {
            const job = this.get(id), rebuilt = this.progressView(job);
            // Old completed jobs have no sidecar. Materialize one once instead of
            // parsing their multi-megabyte state on every history request.
            if (job.status !== "running" && job.status !== "interrupted") try { this.saveProgress(job); } catch { /* Read-only fallback still works. */ }
            return rebuilt;
        }
        if (view.status === "running" && !this.active.has(id)) {
            let alive = false;
            try { if (view.ownerPid) { process.kill(view.ownerPid, 0); alive = true; } } catch { /* Treat a dead worker as interrupted. */ }
            if (!alive || !fs.existsSync(path.join(this.directory(id), "job.lock"))) return { ...view, status: "interrupted" as const };
        }
        return view;
    }
    listProgress(limit = 15) { return fs.readdirSync(this.root).filter(id => /^[0-9a-f-]{36}$/u.test(id) && fs.existsSync(path.join(this.root, id, "state.json")))
        .map(id => { const stat = fs.statSync(path.join(this.root, id)); return { id, created: stat.birthtimeMs || stat.ctimeMs }; })
        .sort((a, b) => b.created - a.created).slice(0, limit).map(({ id }) => this.getProgress(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    create(kind: LibraryJobKind, input: MaintenanceInput = {}): LibraryJob {
        if (!["translate", "summaries", "sync"].includes(kind))
            throw new Error("Unknown Library job kind.");
        input = validateInput(kind, input);
        const root = fs.realpathSync(this.options.libraryPath);
        if(kind!=="sync") targets(root, input);
        const id = randomUUID(), now = new Date().toISOString();
        const job: LibraryJob = { schemaVersion: 1, id, kind, libraryPath: root, input, status: "interrupted", createdAt: now, updatedAt: now, total: 0, completed: 0, counts: { updated: 0, reused: 0, skipped: 0, planned: 0, conflict: 0, error: 0 }, items: [], warnings: [] };
        if(kind==='sync')job.imageContext=scoringContext(this.options.imageChecker??createImageScorer(this.options.dataDir));
        this.save(job);
        return job;
    }
    async start(kind: LibraryJobKind, input: MaintenanceInput = {}) { return this.resume(this.create(kind, input).id); }
    async cancel(id: string): Promise<LibraryJob> {
        const job = this.get(id);
        if (terminal.has(job.status) && !job.pending)
            return job;
        fs.writeFileSync(path.join(this.directory(id), "cancel.request"), "cancel\n", { mode: 0o600 });
        this.active.get(id)?.abort(new Error("Library job cancelled."));
        if (!this.active.has(id))
            try {
                return await this.resume(id);
            }
            catch (error) {
                if (!/busy/u.test(errorText(error)))
                    throw error;
            }
        return this.get(id);
    }
    async shutdown(): Promise<void> { for (const controller of this.active.values())
        controller.abort(new Error("Library service stopped; resume explicitly.")); while (this.active.size)
        await new Promise(resolve => setTimeout(resolve, 10)); }
    async resume(id: string): Promise<LibraryJob> {
        const directory = this.directory(id);
        const releaseJob = acquireDirectoryLock(path.join(directory, "job.lock"));
        let releaseLibrary: (() => void) | undefined;
        try {
            const job = this.get(id);
            if (terminal.has(job.status) && !job.pending)
                return job;
            if (fs.realpathSync(this.options.libraryPath) !== job.libraryPath)
                throw new Error("Job belongs to a different configured Library.");
            releaseLibrary = acquireLibraryLock(job.libraryPath, true);
            const marker = libraryPendingMarker(job.libraryPath);
            if (fs.existsSync(marker) && readObject(marker)?.jobId !== id)
                throw new Error("Library is busy: another interrupted job must be resumed first.");
            const controller = new AbortController();
            const registryFile = path.join(this.options.dataDir, "ckd/library-cache", translationRegistryKey(job.libraryPath), "managed-translations.json");
            const translations: Record<string, ManagedTranslation> = {};
            const saveRegistry = () => atomicJson(registryFile, translations);
            const cancelled = () => fs.existsSync(path.join(directory, "cancel.request"));
            const poll = setInterval(() => { if (cancelled())
                controller.abort(new Error("Library job cancelled.")); }, 100);
            const context: MaintenanceContext = { root: job.libraryPath, directory, job, signal: controller.signal, model: this.model, translations, save: () => this.save(job),
                record: item => { if (job.items.some(i => i.key === item.key))
                    return; job.items.push(item); job.counts[item.status]++; job.completed++; delete job.currentItem; this.save(job); this.options.onEvent?.(`${job.kind} ${item.status}: ${item.key}${item.message ? ": " + item.message : ""}`); },
                warning: message => { if (!job.warnings.includes(message))
                    job.warnings.push(message); this.save(job); },
                textTranslation: (text, language) => translateText(context, text, language),
                commit: (key, sources, writes) => {
                    controller.signal.throwIfAborted();
                    if (job.pending)
                        throw new Error("Unfinished file transaction must be recovered first.");
                    const transaction = randomUUID();
                    const pending = { key, sources, journal: `transactions/${transaction}.json`, writes: writes.map((write, index) => {
                            const staged = write.data!==null&&!write.directory ? `staged/${transaction}/${index}` : undefined;
                            const backup = write.before === null ? undefined : `backups/${transaction}/${index}`;
                            const target = safePath(job.libraryPath, write.relative);
                            if (fileHash(target) !== write.before)
                                throw new Error(`Target changed before staging: ${write.relative}`);
                            if(staged){fs.mkdirSync(path.dirname(path.join(directory, staged)), { recursive: true });
                            fs.writeFileSync(path.join(directory, staged), write.data!); }
                            if (backup && !write.directory) {
                                fs.mkdirSync(path.dirname(path.join(directory, backup)), { recursive: true });
                                fs.copyFileSync(target, path.join(directory, backup));
                            }
                            return { relative: write.relative, before: write.before, after: write.data===null?null:write.directory?sha("[]"):sha(write.data), staged, directory:write.directory, backup, translation: write.translation, previousTranslation: translations[write.relative], previousSourceTranslation: write.translation&&translations[write.translation.source]?.source===write.relative?translations[write.translation.source]:undefined };
                        }) };
                    atomicJson(path.join(directory, pending.journal), { ...pending, status: "prepared" });
                    job.pending = pending;
                    this.save(job);
                    atomicJson(marker, { jobId: id, directory });
                    finishPending();
                }
            };
            const atomicBytes = (file: string, data: Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = file + `.${randomUUID()}.tmp`; try {
                const fd = fs.openSync(temporary, "wx", 0o600);
                try {
                    fs.writeFileSync(fd, data);
                    fs.fsyncSync(fd);
                }
                finally {
                    fs.closeSync(fd);
                }
                fs.renameSync(temporary, file);
            }
            finally {
                fs.rmSync(temporary, { force: true });
            } };
            const clearPending = (status = "committed") => { if (job.pending?.journal)
                atomicJson(path.join(directory, job.pending.journal), { ...job.pending, status }); delete job.pending; this.save(job); fs.rmSync(marker, { force: true }); };
            const rollback = () => {
                for (const write of job.pending!.writes) {
                    const target = safePath(job.libraryPath, write.relative), current = fileHash(target);
                    if (current === write.before)
                        continue;
                    if (current !== write.after)
                        throw new Error(`Interrupted transaction conflicts with external edit: ${write.relative}`);
                    if(write.directory){if(write.before!==null)fs.mkdirSync(target,{recursive:true});else fs.rmdirSync(target);}
                    else if (write.backup)
                        atomicBytes(target, fs.readFileSync(path.join(directory, write.backup)));
                    else
                        fs.rmSync(target, { force: true });
                }
                for (const write of job.pending!.writes)
                    if (write.translation || write.after===null) {
                        if (write.previousTranslation)
                            translations[write.relative] = write.previousTranslation;
                        else
                            delete translations[write.relative];
                        if(write.previousSourceTranslation)translations[write.previousSourceTranslation.target]=write.previousSourceTranslation;
                    }
                saveRegistry();
                clearPending("rolled_back");
            };
            const finishPending = () => {
                if (!job.pending)
                    return;
                atomicJson(marker, { jobId: id, directory });
                if (Object.entries(job.pending.sources).some(([relative, hash]) => fileHash(safePath(job.libraryPath, relative)) !== hash)) {
                    rollback();
                    throw new Error("Sources changed during interrupted transaction; restored prior outputs.");
                }
                // Preflight all writes before the first replacement. A journal plus marker covers process death between replacements.
                for (const write of job.pending.writes) {
                    const current = fileHash(safePath(job.libraryPath, write.relative));
                    if (current !== write.before && current !== write.after) {
                        rollback();
                        throw new Error(`Target changed during transaction: ${write.relative}`);
                    }
                    if (write.staged && fileHash(path.join(directory, write.staged)) !== write.after)
                        throw new Error("Staged output Hash mismatch.");
                }
                for (const write of job.pending.writes) {
                    const target = safePath(job.libraryPath, write.relative);
                    const current = fileHash(target);
                    if (current !== write.before && current !== write.after)
                        throw new Error(`Target changed before replacement: ${write.relative}`);
                    if (current !== write.after){
                        if(write.directory){if(write.after===null)fs.rmdirSync(target);else fs.mkdirSync(target,{recursive:true});}
                        else if(write.after===null)fs.rmSync(target,{force:true});
                        else atomicBytes(target, fs.readFileSync(path.join(directory, write.staged!)));
                    }
                    if(write.after===null)delete translations[write.relative];
                    if (write.translation){
                        if(translations[write.translation.source]?.source===write.relative)delete translations[write.translation.source];
                        translations[write.relative] = write.translation;
                    }
                }
                saveRegistry();
                if(job.sync)for(const write of job.pending.writes)if(write.after===null&&!job.sync.deletions?.some(d=>d.path===write.relative)){job.sync.deletions??=[];job.sync.deletions.push({path:write.relative,kind:write.directory?"directory":"file"});}
                clearPending();
            };
            try {
                this.active.set(id, controller);
                job.status = "running";job.ownerPid = process.pid;delete job.error;this.save(job);
                Object.assign(translations,readObject(registryFile) ?? {});
                if (job.pending)
                    finishPending();
                else if (fs.existsSync(marker))
                    fs.rmSync(marker, { force: true });
                const retryItems = job.kind==="sync"?[]:job.items.filter(item => item.status === "error" || item.status === "conflict");
                for (const item of retryItems) {
                    job.counts[item.status]--;
                    job.completed--;
                }
                job.items = job.items.filter(item => item.status !== "error" && item.status !== "conflict");
                this.save(job);
                if (cancelled())
                    controller.abort(new Error("Library job cancelled."));
                controller.signal.throwIfAborted();
                if (!job.input.dryRun) {
                    importLegacyTranslations(context);
                    saveRegistry();
                }
                if(job.kind === "sync")
                    await runLibrarySync(context, this.options.dataDir, this.options.imageChecker);
                else if (job.kind === "translate")
                    await runTranslations(context);
                else
                    await runSummaries(context);
                controller.signal.throwIfAborted();
                const failures = job.counts.error + job.counts.conflict;
                job.status = failures ? (job.completed > failures ? "partial_failed" : "failed") : "completed";
            }
            catch (error) {
                job.status = cancelled() ? "cancelled" : controller.signal.aborted ? "interrupted" : "failed";
                job.error = errorText(error);
                const stage=job.sync?.stages[job.sync.stage];if(stage)stage.status=job.status==="cancelled"?"cancelled":job.status==="interrupted"?"interrupted":"failed";
            }
            finally {
                clearInterval(poll);
                this.active.delete(id);
                if(job.sync)job.sync.outcome=job.status;
                delete job.ownerPid;
                delete job.currentItem;
                this.save(job);
            }
            return job;
        }
        finally {
            releaseLibrary?.();
            releaseJob();
        }
    }
}
export type { LibraryJob, LibraryJobKind, LibraryJobItem, LibraryMaintenanceOptions } from "./library-job-types.js";
