import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ImageQualityChecker, IMAGE_QUALITY_VERSION, MAX_IMAGE_BYTES } from "./image-quality.js";
import { acquireDirectoryLock } from "./library-lock.js";
import { atomicJson } from "./store.js";
import { sha256 } from "./scripts.js";
import { calibrationMetrics, DEFAULT_SCORE_PARAMETERS, fitImageScores, framingFeatures, IMAGE_SCORE_VERSION, predictImageScore, readImageCalibration, type CalibrationSample, type ImageScoreCalibration } from "./image-scoring.js";

interface Reference { file: string; humanScore?: number; imageHash?: string; error?: string }
export interface CalibrationJob {
  id: string; status: "interrupted" | "running" | "completed" | "partial_failed" | "failed" | "cancelled";
  ownerPid?: number; createdAt: string; updatedAt: string; completed: number; total: number;
  counts: { analyzed: number; reused: number; duplicate: number; error: number };
  items: { file: string; imageHash?: string; humanScore?: number; baseScore?: number; score?: number; error?: string; duplicate?: boolean }[];
  warnings: string[]; error?: string; activated: boolean; report?: Record<string, unknown>;
}
export class ImageCalibration {
  readonly root: string;
  readonly samplesDir: string;
  private readonly active = new Map<string, AbortController>();
  constructor(readonly dataDir: string, private readonly checker: ImageQualityChecker) {
    this.root = path.resolve(dataDir, "ckd/image-calibration"); this.samplesDir = path.join(this.root, "samples");
    fs.mkdirSync(this.samplesDir, { recursive: true }); fs.mkdirSync(path.join(this.root, "jobs"), { recursive: true });
  }
  current() { return { samplesDir: this.samplesDir, analysisVersion: IMAGE_QUALITY_VERSION, scoreVersion: IMAGE_SCORE_VERSION, calibration: readImageCalibration(this.dataDir, IMAGE_QUALITY_VERSION) ?? null }; }
  private directory(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new Error("Invalid calibration job ID.");
    return path.join(this.root, "jobs", id);
  }
  private save(job: CalibrationJob) { job.updatedAt = new Date().toISOString(); atomicJson(path.join(this.directory(job.id), "state.json"), job); }
  get(id: string): CalibrationJob {
    const job = JSON.parse(fs.readFileSync(path.join(this.directory(id), "state.json"), "utf8")) as CalibrationJob;
    if (job.status === "running" && !this.active.has(id)) {
      let alive = false; try { if (job.ownerPid) { process.kill(job.ownerPid, 0); alive = true; } } catch { /* Interrupted owner. */ }
      if (!alive) job.status = "interrupted";
    }
    return job;
  }
  private scan(): Reference[] {
    return fs.readdirSync(this.samplesDir).filter(name => !name.startsWith(".")).sort().map(file => {
      const full = path.join(this.samplesDir, file), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()) return { file, error: "References must be regular files; no subdirectories/symlinks." };
      const match = /^(\d{1,3}(?:\.\d{1,2})?)-(.+)\.(png|jpe?g)$/iu.exec(file);
      if (!match || Number(match[1]) > 100) return { file, error: "Name must be <score 0..100>-<name>.png/.jpg/.jpeg." };
      if (stat.size > MAX_IMAGE_BYTES) return { file, error: "Image exceeds 10 MiB." };
      return { file, humanScore: Number(match[1]), imageHash: sha256(fs.readFileSync(full)) };
    });
  }
  create(): CalibrationJob {
    if (!this.scan().length) throw new Error(`Place scored reference images in ${this.samplesDir} first.`);
    const now = new Date().toISOString();
    const job: CalibrationJob = { id: randomUUID(), status: "interrupted", createdAt: now, updatedAt: now, completed: 0, total: 0, counts: { analyzed: 0, reused: 0, duplicate: 0, error: 0 }, items: [], warnings: [], activated: false };
    this.save(job); return job;
  }
  async cancel(id: string) {
    const job = this.get(id);
    if (["completed", "cancelled"].includes(job.status)) return job;
    fs.writeFileSync(path.join(this.directory(id), "cancel.request"), "cancel\n");
    this.active.get(id)?.abort(new Error("Calibration cancelled."));
    if (!this.active.has(id)) { job.status = "cancelled"; this.save(job); }
    return this.get(id);
  }
  async resume(id: string): Promise<CalibrationJob> {
    const job = this.get(id); if (["completed", "cancelled"].includes(job.status)) return job;
    const release = acquireDirectoryLock(path.join(this.root, "calibration.lock"));
    const controller = new AbortController(); this.active.set(id, controller);
    const cancelled = () => { if (fs.existsSync(path.join(this.directory(id), "cancel.request"))) controller.abort(new Error("Calibration cancelled.")); };
    const poll = setInterval(cancelled, 100); cancelled();
    try {
      controller.signal.throwIfAborted();
      const references = this.scan(), snapshot = JSON.stringify(references);
      job.status = "running"; job.ownerPid = process.pid; job.completed = 0; job.total = references.length;
      job.items = []; job.counts = { analyzed: 0, reused: 0, duplicate: 0, error: 0 }; job.activated = false; job.warnings = []; delete job.error;
      this.save(job);
      const samples: CalibrationSample[] = [], models = new Set<string>();
      const seen = new Map<string, Reference>();
      const conflicts = new Set(references.filter(r => r.imageHash && references.some(other => other.imageHash === r.imageHash && other.humanScore !== r.humanScore)).map(r => r.imageHash));
      for (const reference of references) {
        controller.signal.throwIfAborted();
        const item: CalibrationJob["items"][number] = { ...reference }; job.items.push(item);
        try {
          if (reference.error) throw new Error(reference.error);
          if (conflicts.has(reference.imageHash)) throw new Error("Same image Hash has conflicting human scores. Keep one score.");
          if (seen.has(reference.imageHash!)) { item.duplicate = true; job.counts.duplicate++; }
          else {
            seen.set(reference.imageHash!, reference);
            const bytes = fs.readFileSync(path.join(this.samplesDir, reference.file));
            if (sha256(bytes) !== reference.imageHash) throw new Error("Reference changed during calibration.");
            // Never send filename, humanScore, other examples or fitted parameters to the vision model.
            const result = await this.checker.check(bytes, controller.signal, null);
            if (!framingFeatures(result)) throw new Error("Uncertain/unknown image: review this reference before fitting.");
            if (result.cached) job.counts.reused++; else job.counts.analyzed++;
            models.add(result.model);
            samples.push({ imageHash: result.imageHash, humanScore: reference.humanScore!, data: result });
            item.baseScore = Math.round(predictImageScore(result, DEFAULT_SCORE_PARAMETERS)!);
          }
        } catch (error) { controller.signal.throwIfAborted(); item.error = error instanceof Error ? error.message : String(error); job.counts.error++; }
        job.completed++; this.save(job);
      }
      if (!samples.length) throw new Error("No valid unique calibration samples.");
      if (JSON.stringify(this.scan()) !== snapshot) throw new Error("Reference set changed. Run calibration again; the active version was preserved.");
      if (models.size !== 1) throw new Error("Reference observations use different vision models. Do not mix feature extractors.");
      const fitted = fitImageScores(samples);
      const calibration: ImageScoreCalibration = { id, analysisVersion: IMAGE_QUALITY_VERSION, analysisModel: [...models][0]!, scoreVersion: IMAGE_SCORE_VERSION, createdAt: new Date().toISOString(), sampleCount: samples.length, ...fitted };
      const byHash = new Map(samples.map(sample => [sample.imageHash, sample]));
      for (const item of job.items) { const sample = byHash.get(item.imageHash!); if (sample) item.score = Math.round(predictImageScore(sample.data, fitted.parameters)!); }
      // Held-out errors, not training errors, estimate whether calibration generalizes.
      const holdout = samples.length >= 12 ? samples.filter((_s, i) => i % 5 === 0) : [];
      const training = samples.filter((_s, i) => i % 5 !== 0);
      const validation = holdout.length ? { count: holdout.length, before: calibrationMetrics(holdout, DEFAULT_SCORE_PARAMETERS), after: calibrationMetrics(holdout, fitImageScores(training).parameters), method: "deterministic holdout; active parameters refit all samples" } : null;
      if (samples.length < 8) job.warnings.push("Fewer than 8 unique samples: fit only a global offset; experimental calibration, no independent validation.");
      else if (!holdout.length) job.warnings.push("Fewer than 12 unique samples: fitted weights are experimental, no independent validation.");
      if (validation && validation.after.mae > validation.before.mae) job.warnings.push("Held-out error increased: add more representative references before relying on the fitted weights.");
      job.report = { calibration, samples, before: calibrationMetrics(samples, DEFAULT_SCORE_PARAMETERS), after: calibrationMetrics(samples, fitted.parameters), validation };
      cancelled(); controller.signal.throwIfAborted();
      if (JSON.stringify(this.scan()) !== snapshot) throw new Error("Reference set changed before activation. Active calibration unchanged.");
      if (calibrationMetrics(samples, fitted.parameters).maxAbsoluteError > 15) job.warnings.push("Some references still differ by more than 15 points; inspect per-image residuals.");
      if (job.counts.error || (validation && validation.after.mae > validation.before.mae + 0.25)) { job.status = "partial_failed"; job.warnings.push("Errors/conflicts or worse held-out performance: candidate saved for inspection; active calibration unchanged."); }
      else {
        atomicJson(path.join(this.root, "versions", `${id}.json`), job.report);
        atomicJson(path.join(this.root, "active.json"), calibration);
        job.activated = true; job.status = "completed";
      }
      this.save(job);
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); this.save(job);
    } finally { clearInterval(poll); this.active.delete(id); release(); }
    return job;
  }
}
