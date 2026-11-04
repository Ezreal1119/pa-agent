import fs from "node:fs";
import path from "node:path";

export const IMAGE_SCORE_VERSION = "framing-numeric-v1";
export const IMAGE_ALERT_THRESHOLD = 80;
export interface FramingData {
  imageType: "object" | "screenshot" | "diagram" | "scene" | "unknown";
  confidence: number;
  boundingBox: { left: number; top: number; right: number; bottom: number } | null;
}
export interface ScoreParameters { edgeWeight: number; areaWeight: number; bias: number; typeOffsets: Record<string, number> }
export interface CalibrationSample { imageHash: string; humanScore: number; data: FramingData }
export interface ImageScoreCalibration {
  id: string; analysisVersion: string; analysisModel: string; scoreVersion: string; createdAt: string;
  sampleCount: number; mode: "offset_only" | "weights_and_offset"; parameters: ScoreParameters;
}
export const DEFAULT_SCORE_PARAMETERS: ScoreParameters = { edgeWeight: 80, areaWeight: 15, bias: 0, typeOffsets: { object: 0, screenshot: 0, diagram: 5, scene: 5 } };
export function framingFeatures(data: FramingData) {
  const b = data.boundingBox;
  if (!b || data.confidence < 0.7 || data.imageType === "unknown") return null;
  const margins = [b.left, b.top, 1 - b.right, 1 - b.bottom];
  return {
    // Focus on the worse axis and the largest single margin. Interior gaps are excluded.
    edge: (Math.max(margins[0]! + margins[2]!, margins[1]! + margins[3]!) + Math.max(...margins)) / 2,
    outside: 1 - (b.right - b.left) * (b.bottom - b.top),
  };
}
export function predictImageScore(data: FramingData, p: ScoreParameters): number | null {
  const f = framingFeatures(data); if (!f) return null;
  return Math.max(0, Math.min(100, 100 - p.edgeWeight * f.edge - p.areaWeight * f.outside + (p.typeOffsets[data.imageType] ?? 0) + p.bias));
}
export function readImageCalibration(dataDir: string, analysisVersion: string): ImageScoreCalibration | undefined {
  const file = path.join(dataDir, "ckd/image-calibration/active.json");
  if (!fs.existsSync(file)) return;
  const c = JSON.parse(fs.readFileSync(file, "utf8")) as ImageScoreCalibration;
  const p = c.parameters;
  if (c.analysisVersion !== analysisVersion || c.scoreVersion !== IMAGE_SCORE_VERSION) return;
  if (!c.id || !c.analysisModel || !p || !Number.isFinite(p.edgeWeight) || p.edgeWeight < 40 || p.edgeWeight > 160 || !Number.isFinite(p.areaWeight) || p.areaWeight < 0 || p.areaWeight > 20 || !Number.isFinite(p.bias) || Math.abs(p.bias) > 25 || !p.typeOffsets || ["object", "screenshot", "diagram", "scene"].some(type => !Number.isFinite(p.typeOffsets[type]) || Math.abs(p.typeOffsets[type]!) > 8)) throw new Error("Invalid active image calibration. Restore its saved version before scoring.");
  return c;
}
export function scoreWithCalibration(data: FramingData, model: string, calibration?: ImageScoreCalibration) {
  const compatible = calibration?.analysisModel === model;
  const parameters = compatible ? calibration!.parameters : DEFAULT_SCORE_PARAMETERS;
  const base = predictImageScore(data, DEFAULT_SCORE_PARAMETERS);
  const calibrated = predictImageScore(data, parameters);
  const score = calibrated === null ? null : Math.round(calibrated);
  const f = framingFeatures(data);
  return { score, baseScore: base === null ? null : Math.round(base), calibrationId: compatible ? calibration!.id : null,
    calibrationSampleCount: compatible ? calibration!.sampleCount : 0, calibrationExperimental: compatible && calibration!.sampleCount < 12,
    scoreBreakdown: f ? { edgeFeature: f.edge, outsideFeature: f.outside, edgeDeduction: parameters.edgeWeight * f.edge, areaDeduction: parameters.areaWeight * f.outside, typeOffset: parameters.typeOffsets[data.imageType] ?? 0, calibrationBias: parameters.bias } : null,
    calibrationStatus: calibration && !compatible ? "model_mismatch" : compatible ? "applied" : "uncalibrated",
    scoreVersion: IMAGE_SCORE_VERSION, alertThreshold: IMAGE_ALERT_THRESHOLD, reminder: score !== null && score < IMAGE_ALERT_THRESHOLD,
    status: score === null ? "needs_review" as const : score < IMAGE_ALERT_THRESHOLD ? "excessive_whitespace" as const : "normal" as const };
}

/** Deterministic bounded least squares. Small datasets fit only a global offset. */
export function fitImageScores(samples: CalibrationSample[]) {
  if (!samples.length || samples.some(s => !framingFeatures(s.data))) throw new Error("Calibration requires scored observations.");
  const p: ScoreParameters = structuredClone(DEFAULT_SCORE_PARAMETERS), prior = structuredClone(p);
  const mode = samples.length < 8 ? "offset_only" as const : "weights_and_offset" as const;
  const axes: { get(): number; set(n: number): void; min: number; max: number; prior: number; scale: number }[] = [
    { get: () => p.bias, set: n => { p.bias = n; }, min: -25, max: 25, prior: 0, scale: 10 },
  ];
  if (mode === "weights_and_offset") {
    axes.push({ get: () => p.edgeWeight, set: n => { p.edgeWeight = n; }, min: 40, max: 160, prior: prior.edgeWeight, scale: 40 });
    axes.push({ get: () => p.areaWeight, set: n => { p.areaWeight = n; }, min: 0, max: 20, prior: prior.areaWeight, scale: 10 });
    for (const type of ["object", "screenshot", "diagram", "scene"]) if (samples.filter(s => s.data.imageType === type).length >= 4)
      axes.push({ get: () => p.typeOffsets[type]!, set: n => { p.typeOffsets[type] = n; }, min: -8, max: 8, prior: prior.typeOffsets[type]!, scale: 5 });
  }
  const objective = () => samples.reduce((sum, s) => sum + (predictImageScore(s.data, p)! - s.humanScore) ** 2, 0) / samples.length + 0.05 * axes.reduce((sum, a) => sum + ((a.get() - a.prior) / a.scale) ** 2, 0);
  let best = objective();
  for (const step of [8, 4, 2, 1, 0.5, 0.1, 0.02]) {
    for (let round = 0; round < 100; round++) {
      let improved = false;
      for (const a of axes) {
        const old = a.get(); let chosen = old;
        for (const candidate of [Math.max(a.min, old - step), Math.min(a.max, old + step)]) {
          a.set(candidate); const loss = objective();
          if (loss < best - 1e-9) { best = loss; chosen = candidate; improved = true; }
        }
        a.set(chosen);
      }
      if (!improved) break;
    }
  }
  return { parameters: p, mode };
}
export function calibrationMetrics(samples: CalibrationSample[], parameters: ScoreParameters) {
  const errors = samples.map(s => predictImageScore(s.data, parameters)! - s.humanScore);
  return { count: errors.length, mae: errors.reduce((sum, n) => sum + Math.abs(n), 0) / errors.length,
    bias: errors.reduce((sum, n) => sum + n, 0) / errors.length, maxAbsoluteError: Math.max(...errors.map(Math.abs)) };
}
