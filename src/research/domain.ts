import { z } from "zod";
import { publicationDates } from "./dates.js";
import type { BudgetState } from "./budget.js";
import type { Lead } from "./leads.js";

export class ResearchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const scenes = {
  retail: "零售门店",
  logistics: "仓储物流",
  coldChain: "冷链",
  manufacturing: "工业制造",
  field: "医疗与现场服务",
  payment: "支付与移动收款",
  management: "跨行业设备管理",
} as const;
export const sceneSchema = z.enum(
  Object.keys(scenes) as [keyof typeof scenes, ...(keyof typeof scenes)[]],
);
export type Scene = keyof typeof scenes;
export function day(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new ResearchError(400, "日期须为有效的 YYYY-MM-DD");
  return value;
}
export const localDay = (value: string | number | Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
export const today = () => localDay();
export function windowDays(end: string, count = 14) {
  day(end);
  if (![1, 7, 14].includes(count))
    throw new ResearchError(400, "日期范围仅支持 1、7、14 天");
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(end) - (count - 1 - i) * 86400000)
      .toISOString()
      .slice(0, 10),
  );
}
const text = z.string().trim().min(1).max(8000);
const date = z.string().refine((v) => {
  try {
    day(v);
    return true;
  } catch {
    return false;
  }
}, "Invalid date");
const citation = z
  .object({ evidenceId: z.string().uuid(), quote: text })
  .strict();
export const articleSchema = z
  .object({
    title: text,
    eventKey: z.string().trim().min(5).max(300),
    disclosureDate: date,
    dateEvidence: citation,
    eventDate: z.union([date, z.literal("")]),
    region: z.string().max(300),
    companies: z.array(text).max(20),
    scene: sceneSchema,
    tags: z.array(z.string().max(100)).max(20),
    relatedScenes: z.array(sceneSchema).max(7),
    facts: z
      .array(
        z
          .object({ claim: text, citations: z.array(citation).min(1).max(8) })
          .strict(),
      )
      .min(1)
      .max(30),
    deployment: text,
    competition: z
      .object({
        status: z.enum(["confirmed", "inferred", "undisclosed"]),
        detail: text,
        citations: z.array(citation).max(10),
      })
      .strict(),
    urovo: z
      .object({
        relevance: text,
        productClaims: z
          .array(
            z
              .object({
                claim: text,
                citations: z.array(citation).min(1).max(8),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    brief: z.object({ news: text, sales: text }).strict(),
    detail: z
      .object({
        analysis: text,
        sales: text,
        questions: z.array(text).max(20),
        limitations: z.array(text).max(20),
      })
      .strict(),
    relatedIds: z.array(z.string().uuid()).max(20),
    status: z.enum(["active", "disputed", "withdrawn"]),
  })
  .strict();
export type Article = z.infer<typeof articleSchema>;
export const candidateSchema = z
  .object({
    action: z.enum(["new", "update", "correction", "sources"]),
    targetId: z.string().uuid().optional(),
    expectedVersion: z.number().int().positive().optional(),
    reason: text,
    article: articleSchema,
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema> & {
  id: string;
  submittedAt: string;
  repairOf?: string;
  outcome?: string;
};
export const scoreSchema = z
  .object({
    relevance: z.number().min(0).max(5),
    commercial: z.number().min(0).max(5),
    evidence: z.number().min(0).max(5),
    importance: z.number().min(0).max(5),
    novelty: z.number().min(0).max(5),
  })
  .strict();
export type Scores = z.infer<typeof scoreSchema>;
export const checksSchema = z
  .object({
    readableBody: z.boolean(),
    dateVerified: z.boolean(),
    factsSupported: z.boolean(),
    businessLink: z.boolean(),
    productSupported: z.boolean(),
    consistent: z.boolean(),
  })
  .strict();
export const reviewSchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            candidateId: z.string().uuid(),
            approve: z.boolean(),
            unresolvedIssues: z.array(text).max(12),
            scores: scoreSchema,
            checks: checksSchema,
            material: z.boolean(),
            duplicateOf: z.string().uuid().optional(),
            reason: text,
          })
          .strict(),
      )
      .max(24),
    nextDirections: z.array(text).max(12),
    potential: z
      .object({ candidateId: z.string().uuid(), missingStep: text })
      .strict()
      .optional(),
    summary: text,
  })
  .strict();
export type Review = z.infer<typeof reviewSchema> & { incomplete?: boolean };
export type Verdict = Review["verdicts"][number];
export const weights: Scores = {
  relevance: 30,
  commercial: 25,
  evidence: 20,
  importance: 15,
  novelty: 10,
};
export interface ResearchConfig {
  initialMs: number;
  checkpointMs: number;
  maxMs: number;
  wrapMs: number;
  reviewMs: number;
  threshold: number;
  fetchTimeoutMs?: number;
  weights: Scores;
  budgetCny?: number;
}
export const defaults: ResearchConfig = {
  budgetCny: 3,
  initialMs: 300000,
  checkpointMs: 300000,
  maxMs: 1200000,
  wrapMs: 120000,
  reviewMs: 60000,
  threshold: 70,
  fetchTimeoutMs: 18000,
  weights,
};
export function config(
  env: Record<string, string | undefined>,
): ResearchConfig {
  const out = { ...defaults, weights: { ...weights } };
  for (const [key, name] of Object.entries({
    budgetCny: "RESEARCH_BUDGET_CNY",
    maxMs: "RESEARCH_MAX_MS",
    wrapMs: "RESEARCH_WRAP_MS",
    reviewMs: "RESEARCH_REVIEW_MS",
    threshold: "RESEARCH_THRESHOLD",
    fetchTimeoutMs: "RESEARCH_FETCH_TIMEOUT_MS",
  }))
    if (env[name] !== undefined) (out as any)[key] = Number(env[name]);
  if (env.RESEARCH_WEIGHTS)
    out.weights = scoreWeights(JSON.parse(env.RESEARCH_WEIGHTS));
  if (
    Object.values(out).some(
      (v) => typeof v === "number" && (!Number.isFinite(v) || v <= 0),
    ) ||
    out.maxMs <= out.wrapMs ||
    out.reviewMs > out.wrapMs ||
    out.threshold > 100
  )
    throw new ResearchError(400, "研究时间或阈值配置不合法");
  return out;
}
function scoreWeights(v: unknown): Scores {
  const r = z
    .object(
      Object.fromEntries(
        Object.keys(weights).map((k) => [k, z.number().min(0).max(100)]),
      ),
    )
    .strict()
    .parse(v) as Scores;
  if (Math.abs(Object.values(r).reduce((a, b) => a + b, 0) - 100) > 0.001)
    throw new Error("RESEARCH_WEIGHTS sum must be 100");
  return r;
}
export function total(s: Scores, w: Scores = weights) {
  return Math.round(
    Object.keys(weights).reduce(
      (n, k) => n + (s[k as keyof Scores] * w[k as keyof Scores]) / 5,
      0,
    ),
  );
}
export function admitted(v: Verdict, c: Candidate, settings: ResearchConfig) {
  return (
    v.approve &&
    (v.unresolvedIssues ?? []).length === 0 &&
    Object.values(v.checks).every(Boolean) &&
    ((c.action === "correction" && !!c.targetId) ||
      (total(v.scores, settings.weights) >= settings.threshold &&
        v.scores.relevance >= 3 &&
        v.scores.evidence >= 3))
  );
}
export interface Evidence {
  id: string;
  kind: "web" | "knowledge";
  locator: string;
  title: string;
  content: string;
  fetchedAt: string;
  hash: string;
  readable: boolean;
}
export interface Item {
  id: string;
  version: number;
  article: Article;
  evidence: Evidence[];
  score: number;
  review: Verdict;
  createdAt: string;
  updatedAt: string;
  archived?: { reason: string; at: string };
  history: Revision[];
}
export interface Revision {
  operation: string;
  at: string;
  reason: string;
  article: Article;
  review: Verdict;
  evidence: Evidence[];
}
export interface Coverage {
  scene: Scene;
  from: string;
  to: string;
  query: string;
  at: string;
  resultCount: number;
}
export interface Checkpoint {
  at: string;
  elapsedMs: number;
  final: boolean;
  points: number;
  continued: boolean;
  review?: Review;
  error?: string;
  resultSummary?: string;
  decisions?: {
    candidateId: string;
    title: string;
    status: "saved" | "below_threshold" | "rejected" | "pending";
    score?: number;
    reason: string;
  }[];
  changes: { id: string; kind: string; score: number; progressKey?: string }[];
}
export interface Run {
  id: string;
  endDate: string;
  days: string[];
  state:
    | "running"
    | "reviewing"
    | "wrapping"
    | "completed"
    | "interrupted"
    | "failed";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  stopReason?: string;
  config: ResearchConfig;
  phase?: "discovery" | "research" | "review" | "done";
  rulesHash?: string;
  instructions?: Record<string,string>;
  budget?: BudgetState;
  reuse?: { bodies: number; duplicates: number; cooldown: number; importedLeads: number; fullSweepDue: boolean; dueScenes: string[]; lastFullSweepAt?: string; gaps?: {scene: string; days: string[]}[]; priorCoverage: Coverage[] };
  batch?: number;
  backgroundHash: string;
  background: string;
  candidates: Candidate[];
  coverage: Coverage[];
  leads?: Lead[];
  checkpoints: Checkpoint[];
  metrics: {
    modelCalls: number;
    search: number;
    fetch: number;
    fetchCalls?: number;
    readableBodies?: number;
    unreadablePages?: number;
    fetchFailures?: number;
    inputTokens: number;
    outputTokens: number;
  };
  potentialUsed: boolean;
  errors: string[];
}
export const terminal = (r: Run) =>
  ["completed", "interrupted", "failed"].includes(r.state);
export const citations = (a: Article) => [
  a.dateEvidence,
  ...a.facts.flatMap((f) => f.citations),
  ...a.competition.citations,
  ...a.urovo.productClaims.flatMap((p) => p.citations),
];
export function evidenceCheck(c: Candidate, evidence: Evidence[]) {
  const map = new Map(evidence.map((e) => [e.id, e]));
  for (const ref of citations(c.article)) {
    const e = map.get(ref.evidenceId);
    if (!e || !e.content.includes(ref.quote)) {
      const offset = e
        ? Math.max(0, e.content.indexOf(ref.quote.slice(0, 16)) - 150)
        : 0;
      throw new ResearchError(
        400,
        `引用原文不匹配：${ref.evidenceId}。重新 read_evidence({id:"${ref.evidenceId}",offset:${offset}})，复制原文（保留空格/标点）。待核对引用：${ref.quote.slice(0, 120)}`,
      );
    }
  }
  const d = map.get(c.article.dateEvidence.evidenceId);
  if (d?.kind !== "web" || !d.readable)
    throw new ResearchError(400, "日期必须有可读网页正文依据");
  const published = publicationDates(d.content);
  if (
    published.length &&
    !published.some((p) => p.day === c.article.disclosureDate) &&
    !/(?:首次(?:公开|披露|发布|公告)|first (?:announced|published|disclosed))/i.test(
      c.article.dateEvidence.quote,
    )
  )
    throw new ResearchError(
      400,
      `归档日期与正文明确发布日期冲突：${JSON.stringify(published)}。签发/实施/事件日不能代替公开披露日，请核对后重新提交。`,
    );
  for (const fact of c.article.facts)
    if (
      !fact.citations.some((ref) => {
        const e = map.get(ref.evidenceId);
        return e?.kind === "web" && e.readable;
      })
    )
      throw new ResearchError(400, "新闻事实缺少可读网页正文");
  for (const claim of c.article.urovo.productClaims)
    if (
      !claim.citations.some((ref) => {
        const e = map.get(ref.evidenceId);
        return (
          e?.kind === "knowledge" &&
          !/^products:product-knowledge-vault\/(?:index\.md|overview\.md|categories\/)/i.test(
            e.locator,
          )
        );
      })
    )
      throw new ResearchError(
        400,
        "产品主张缺少正式内部资料依据；目录/overview/分类导航不能替代型号源文件",
      );
  if (
    c.article.competition.status === "confirmed" &&
    !c.article.competition.citations.length
  )
    throw new ResearchError(400, "已证实的竞争信息需要引用");
}
