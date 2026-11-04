import { z } from "zod";
import type { ModelConfig } from "../config.js";
import { ReviewStore } from "./store.js";
import { readCases } from "./source.js";
import { scrub, safeCandidate, questionKey } from "./privacy.js";
import { ReviewKnowledge } from "./knowledge.js";
import { ReviewAgent } from "./agent.js";
import { candidateSchema, type Candidate, type InternalQuestion, type ReviewCase, type ReviewRun } from "./types.js";

const auditSchema = z.object({ reviewed: z.array(z.string().regex(/^case-\d+$/)).max(6), candidates: z.array(candidateSchema).max(24) }).strict();
const privacySchema = z.object({ decisions: z.array(z.object({ index: z.number().int().min(0), safe: z.boolean(), candidate: candidateSchema.optional() }).strict()).max(24) }).strict();
const mergeSchema = z.object({ groups: z.array(z.array(z.number().int().min(0)).min(1)).max(500) }).strict();
const generalizeSchema = z.object({ items: z.array(z.object({ id: z.string().regex(/^item-\d+$/), question: z.string().min(8).max(120), products: z.array(z.string().max(64)).max(8), versions: z.array(z.string().max(64)).max(8), explanation: z.string().min(5).max(400), evidence: z.string().min(5).max(400) }).strict()).max(20) }).strict();
const scope = (q: Candidate | InternalQuestion) => JSON.stringify([q.category, q.products.map(p => p.toLowerCase().trim()).sort(), q.versions.map(v => v.toLowerCase().replace(/\s/g, "")).sort()]);
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every(v => b.includes(v));
const normalized = (s: string) => s.normalize("NFKC").trim().toLowerCase();
function retainScope(proposed: string[], allowed: string[], version = false): string[] | null {
  const key = (s: string) => version ? normalized(s).replace(/\s/g, "") : normalized(s);
  const result = proposed.map(p => allowed.find(a => key(a) === key(p)));
  return result.some(v => v === undefined) ? null : [...new Set(result as string[])];
}
export type ReviewCaller = Pick<ReviewAgent, "call">;

export async function executeReview(options: { dataDir: string; resourcesDir: string; model: ModelConfig; run: ReviewRun; signal: AbortSignal; caller?: ReviewCaller }) {
  const { dataDir, resourcesDir, model, run, signal } = options;
  const store = new ReviewStore(dataDir), save = () => store.save(run);
  const source = await readCases(dataDir, run.from, run.to, signal);
  const available = new Map(source.cases.map(c => [c.key, c]));
  const resuming = !!run.manifest;
  run.manifest ??= source.cases.map(c => c.key);
  const completed = new Set(run.processed);
  const previousReviewed = run.coverage.reviewed;
  run.coverage = { ...(resuming ? run.coverage : source.coverage), privacyHeld: run.coverage.privacyHeld, reviewed: completed.size, eligible: run.manifest.length,
    remaining: run.manifest.filter(key => !completed.has(key)).length };
  const missing = run.manifest.filter(key => !completed.has(key) && !available.has(key));
  run.coverage.unavailable += missing.length;
  const knowledge = new ReviewKnowledge(dataDir), publicProducts = await knowledge.publicProducts();
  const caller = options.caller ?? new ReviewAgent({ dataDir, resourcesDir, model, run, signal, save, knowledge });
  const pending = run.manifest.filter(key => !completed.has(key)).map(key => available.get(key)).filter((c): c is ReviewCase => !!c);
  await save();
  // Older checkpoints may have passed identity filtering but still retain an
  // overly specific scenario. Do not expose them until independently generalized.
  const legacy = run.questions.filter(q => !q.generalized);
  for (let at = 0; at < legacy.length; at += 10) {
    signal.throwIfAborted(); const batch = legacy.slice(at, at + 10);
    const handles = batch.map((_, i) => `item-${i + 1}`);
    const output = await caller.call("generalize", { publicProducts: [...publicProducts], items: batch.map(({ sources, generalized, id, ...q }, i) => ({ ...q, id: handles[i] })) }, generalizeSchema);
    if (!sameSet(output.items.map(i => i.id), handles)) throw new Error("review_incomplete_generalization");
    for (const item of output.items) {
      const original = batch[handles.indexOf(item.id)]!;
      const refs = original.sources.map(id => available.get(id)).filter((c): c is ReviewCase => !!c);
      const products = retainScope(item.products, original.products), versions = retainScope(item.versions, original.versions, true);
      const candidate: Candidate = { ...item, products: products ?? [], versions: versions ?? [], category: original.category, cases: ["case-1"] };
      if (refs.length !== original.sources.length || !products || !versions || !safeCandidate(candidate, refs.flatMap(c => [c.question, c.answer, c.context, c.tools]), publicProducts)) {
        run.questions = run.questions.filter(q => q.id !== original.id); run.coverage.privacyHeld++; continue;
      }
      const { id, ...fields } = item;
      Object.assign(original, fields, { products, versions, generalized: true });
    }
    await save();
  }
  let index = 0;
  while (index < pending.length) {
    signal.throwIfAborted();
    const batch: ReviewCase[] = [];
    let bytes = 0;
    while (index < pending.length && batch.length < 6) {
      let item = pending[index]!;
      const reserve = Math.min(40000, Math.floor(model.contextWindow / 2));
      let size = Buffer.byteLength(JSON.stringify(item)) + 1000;
      if (size + reserve > model.contextWindow) {
        // Preserve the entire actual question and answer. Only supporting tool
        // excerpts/prior rounds may be reduced, with the limitation made explicit.
        item = { ...item, context: item.context.slice(-2000), tools: item.tools.slice(0, 4000), limited: true };
        size = Buffer.byteLength(JSON.stringify(item)) + 1000;
      }
      if (size + reserve > model.contextWindow) {
        run.coverage.oversized++; index++; continue;
      }
      if (batch.length && bytes + size + reserve > model.contextWindow) break;
      if (item.limited && !pending[index]!.limited) run.coverage.evidenceLimited++;
      batch.push(item); bytes += size; index++;
    }
    if (!batch.length) continue;
    const handles = batch.map((_, i) => `case-${i + 1}`);
    const input = { publicProducts: [...publicProducts], cases: batch.map((c, i) => ({ id: handles[i], question: scrub(c.question), answer: scrub(c.answer), context: scrub(c.context), tools: scrub(c.tools), evidenceLimited: c.limited })) };
    const audited = await caller.call("review", input, auditSchema);
    if (!sameSet(audited.reviewed, handles) || audited.candidates.some(c => c.cases.some(id => !handles.includes(id)))) throw new Error("review_invalid_coverage");
    let decisions: z.infer<typeof privacySchema>["decisions"] = [];
    if (audited.candidates.length) {
      decisions = (await caller.call("privacy", { ...input, candidates: audited.candidates }, privacySchema)).decisions;
      if (decisions.length !== audited.candidates.length || new Set(decisions.map(d => d.index)).size !== decisions.length || decisions.some(d => !audited.candidates[d.index])) throw new Error("review_incomplete_privacy_check");
    }
    for (const decision of decisions) {
      const initial = audited.candidates[decision.index]!, c = decision.candidate;
      const originals = batch.flatMap(item => [item.question, item.answer, item.context, item.tools]);
      const products = c && retainScope(c.products, initial.products), versions = c && retainScope(c.versions, initial.versions, true);
      if (c && products && versions) { c.products = products; c.versions = versions; }
      if (!decision.safe || !c || c.category !== initial.category || !sameSet(c.cases, initial.cases) ||
          !products || !versions || !safeCandidate(c, originals, publicProducts)) {
        run.coverage.privacyHeld++; continue;
      }
      const sources = c.cases.map(handle => batch[handles.indexOf(handle)]!.key);
      const key = questionKey(c), existing = run.questions.find(q => q.id === key);
      if (existing) { existing.sources = [...new Set([...existing.sources, ...sources])]; existing.occurrences = existing.sources.length; }
      else {
        const { cases, ...fields } = c;
        run.questions.push({ ...fields, id: key, status: "pending_verification", occurrences: new Set(sources).size, sources: [...new Set(sources)], generalized: true });
      }
    }
    batch.forEach(c => completed.add(c.key)); run.processed = [...completed];
    run.coverage.reviewed = completed.size; run.coverage.remaining = run.manifest.length - completed.size;
    await save();
  }
  // Only already approved questions enter semantic merging. The merger can
  // choose groups but cannot generate new output text or weaken privacy checks.
  if (run.questions.length > 1 && run.questions.length <= 500) {
    const original = run.questions;
    const output = await caller.call("merge", { questions: original.map(({ sources, generalized, ...q }, index) => ({ ...q, index })) }, mergeSchema);
    const indices = output.groups.flat();
    if (indices.length !== original.length || new Set(indices).size !== original.length || indices.some(i => !original[i]) || output.groups.some(g => g.some(i => scope(original[i]!) !== scope(original[g[0]!]!)))) throw new Error("review_invalid_merge");
    run.questions = output.groups.map(group => {
      const selected = group.map(i => original[i]!).sort((a, b) => a.question.localeCompare(b.question))[0]!;
      const sources = [...new Set(group.flatMap(i => original[i]!.sources))];
      return { ...selected, sources, occurrences: sources.length };
    });
  }
  run.questions.sort((a, b) => b.occurrences - a.occurrences || a.question.localeCompare(b.question));
  run.status = run.coverage.remaining || run.coverage.corrupt || run.coverage.unavailable || run.coverage.oversized || run.coverage.unfinished || run.coverage.evidenceLimited ? "partial" : "completed";
  run.reason = run.status === "partial" ? "部分记录缺失、损坏、未完成或上下文超限；列表不代表全部问答均已充分核实。" : undefined;
  if (!run.coverage.eligible && run.status === "completed") run.reason = "指定范围内没有可评审的完整问答记录；空列表不代表没有知识缺口。";
  // Legacy interrupted jobs may contain a counter but no completed checkpoint.
  if (previousReviewed > completed.size) run.reason = "已按可恢复的完成批次重新核对覆盖数量。";
  run.finishedAt = new Date().toISOString(); await save(); return run;
}
