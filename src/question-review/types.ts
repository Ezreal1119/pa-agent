import { z } from "zod";

export class ReviewError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const categories = ["knowledge_gap", "retrieval_gap", "answer_issue", "needs_clarification"] as const;
export const categoryLabels: Record<typeof categories[number], string> = { knowledge_gap: "知识缺口", retrieval_gap: "检索遗漏", answer_issue: "回答疑似有误", needs_clarification: "用户信息不足" };
export const settingsSchema = z.object({
  enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }),
  maxDurationMs: z.number().int().min(10000).max(7200000), maxModelRequests: z.number().int().min(1).max(500),
}).strict();
export type ReviewSettings = z.infer<typeof settingsSchema>;
export const defaults: ReviewSettings = { enabled: false, time: "02:00", timeZone: "Asia/Shanghai", maxDurationMs: 1200000, maxModelRequests: 100 };
export const candidateSchema = z.object({
  category: z.enum(categories), question: z.string().min(8).max(240),
  products: z.array(z.string().min(1).max(64)).max(8), versions: z.array(z.string().min(1).max(64)).max(8),
  explanation: z.string().min(5).max(400), evidence: z.string().min(5).max(400),
  cases: z.array(z.string().regex(/^case-\d+$/)).min(1).max(6),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export interface Question extends Omit<Candidate, "cases"> { id: string; status: "pending_verification"; occurrences: number; }
export interface InternalQuestion extends Question { sources: string[]; generalized?: boolean; }
export interface Coverage {
  files: number; scanned: number; eligible: number; reviewed: number; remaining: number;
  unfinished: number; corrupt: number; unavailable: number; oversized: number; evidenceLimited: number; privacyHeld: number;
}
export const emptyCoverage = (): Coverage => ({ files: 0, scanned: 0, eligible: 0, reviewed: 0, remaining: 0, unfinished: 0, corrupt: 0, unavailable: 0, oversized: 0, evidenceLimited: 0, privacyHeld: 0 });
export type ReviewStatus = "queued" | "running" | "completed" | "partial" | "cancelled" | "interrupted" | "failed";
export interface ReviewRun {
  version: 1; id: string; requestId: string; from: string; to: string; createdAt: string; finishedAt?: string;
  status: ReviewStatus; settings: ReviewSettings; modelId: string; reason?: string; modelRequests: number;
  coverage: Coverage; questions: InternalQuestion[]; processed: string[]; manifest?: string[];
  scheduleDate?: string;
  requestFingerprint?: string;
  diagnostics?: Record<string, number>;
}
export type PublicRun = Omit<ReviewRun, "requestId" | "processed" | "manifest" | "questions" | "scheduleDate" | "requestFingerprint" | "diagnostics"> & { questions: Question[] };
export function publicRun(run: ReviewRun): PublicRun {
  return { version: run.version, id: run.id, from: run.from, to: run.to, createdAt: run.createdAt, finishedAt: run.finishedAt,
    status: run.status, settings: { ...run.settings }, modelId: run.modelId, reason: run.reason, modelRequests: run.modelRequests, coverage: { ...run.coverage },
    questions: run.questions.filter(q => q.generalized === true).map(q => ({ id: q.id, category: q.category, question: q.question, products: q.products, versions: q.versions,
      explanation: q.explanation, evidence: q.evidence, status: q.status, occurrences: q.occurrences })) };
}
export const runInput = z.object({
  from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), retryRunId: z.string().uuid().optional(),
}).strict().refine(v => Date.parse(v.from) < Date.parse(v.to) && Date.parse(v.to) - Date.parse(v.from) <= 31 * 86400000, "Invalid date range (maximum 31 days)");
export interface ReviewCase { key: string; question: string; answer: string; context: string; tools: string; limited: boolean; }
