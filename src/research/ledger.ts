import path from "node:path";
import { atomic, canonicalUrl, hash, read, type ResearchStore } from "./store.js";
import { scenes, citations, type Coverage, type Evidence, type Run } from "./domain.js";
import type { Lead } from "./leads.js";

interface Entry {
  lead: Lead;
  seenAt: string;
  attemptedAt?: string;
  failedAt?: string;
  signature: string;
  rules: string;
  evidenceId?: string;
  evidenceSignature?: string;
  dateDispute?: {hash:string; rules:string; reason:string; at:string};
  disposition?: "duplicate" | "irrelevant" | "accepted" | "pending";
}
interface Ledger { version: number; entries: Record<string, Entry>; coverage: Coverage[]; imported: string[]; }
const empty = (): Ledger => ({ version: 2, entries: {}, coverage: [], imported: [] });
export const leadSignature = (l: Lead) => l.sourceFingerprint ?? hash(JSON.stringify([l.title, l.summary]));
export class ResearchLedger {
  private value: Ledger = empty();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: ResearchStore) { }
  private get file() { return path.join(this.store.root, "ledger/state.json"); }
  private serial<T>(fn: () => Promise<T>) { const p = this.queue.then(fn); this.queue = p.catch(() => { }); return p; }
  async init() {
    this.value = await read<Ledger>(this.file) ?? empty();
    if (this.value.version > 2) throw new Error("研究台账版本较新，拒绝降级写入");
    if (this.value.version < 2) { this.value.version = 2; this.value.imported = []; }
    // Old runs retain unknown rule versions. They provide evidence/coverage, never permanent rejection decisions.
    for(const r of(await this.store.runs()).reverse())
      if(!this.value.imported.includes(r.id)) {
        await this.sync(r, r.rulesHash ?? "legacy-unknown");
        const evidence = await this.store.loadEvidence(r.id);
        for (const e of evidence) await this.capture(e);
        for (const cp of r.checkpoints) for (const verdict of cp.review?.verdicts ?? []) if (!verdict.checks.dateVerified) {
          const c = r.candidates.find(c=>c.id===verdict.candidateId);
          if (c) for (const ref of citations(c.article)) {
            const source = evidence.find(e=>e.id===ref.evidenceId);
            if (source?.kind === "web") await this.disputeDate(source,r.rulesHash ?? "legacy-unknown",verdict.reason);
          }
        }
        this.value.imported.push(r.id);
      }
    await atomic(this.file, this.value);
  }
  async capture(e: Evidence) {
    if(e.kind !== "web" || !e.readable) return;
    await this.serial(async () => {
      await atomic(path.join(this.store.root, "ledger/evidence", e.id + ".json"), e);
      const entry = this.value.entries[canonicalUrl(e.locator)];
      if(entry) {
        const prior = entry.evidenceId ? await read<Evidence>(path.join(this.store.root, "ledger/evidence", entry.evidenceId + ".json")) : undefined;
        if(!prior || e.fetchedAt >= prior.fetchedAt) { entry.evidenceId = e.id; entry.evidenceSignature = entry.signature; if (!entry.failedAt || e.fetchedAt >= entry.failedAt) entry.failedAt = undefined; }
      } else this.value.entries[canonicalUrl(e.locator)] = {
        lead: { id: hash(canonicalUrl(e.locator)).slice(0, 20), url: canonicalUrl(e.locator), title: e.title, summary: "", publishedAt: "", scenes: [], state: "read", priority: "normal", evidenceId: e.id },
        seenAt: e.fetchedAt, signature: "", rules: "legacy-unknown", evidenceId: e.id,
      };
      await atomic(this.file, this.value);
    });
  }
  async sync(r: Run, rules: string) {
    await this.serial(async () => {
      for(const l of r.leads ?? []) {
        const url = canonicalUrl(l.url);
        const old = this.value.entries[url];
        const matches = r.candidates.filter(c => l.evidenceId && JSON.stringify(c.article).includes(l.evidenceId));
        const outcome = matches.findLast(c=>c.outcome === "已入库")?.outcome ?? matches.at(-1)?.outcome;
        if(outcome) l.lastOutcome = outcome.slice(0, 1000);
        if(outcome?.includes("同一事件已存在")) l.classification = "duplicate";
        const disposition: Entry["disposition"] = outcome === "已入库" ? "accepted" :
          l.classification === "duplicate" ? "duplicate" : l.classification === "irrelevant" ? "irrelevant" : "pending";
        const signature = leadSignature(l);
        const unchanged = old?.signature === signature;
        this.value.entries[url] = {
          lead: structuredClone(l), signature, rules, seenAt: l.seenAt ?? r.startedAt,
          attemptedAt: l.attemptedAt ?? (l.state !== "unread" && l.state !== "deferred" ? r.updatedAt : old?.attemptedAt),
          evidenceId: l.evidenceId ?? old?.evidenceId,
          evidenceSignature: old?.evidenceSignature,
          dateDispute: old?.dateDispute,
          failedAt: l.state === "unavailable" ? l.attemptedAt ?? r.updatedAt : unchanged ? old?.failedAt : undefined,
          disposition: l.cooldown && unchanged && old ? old.disposition : disposition,
        };
      }
      const keys = new Set(this.value.coverage.map(c => JSON.stringify(c)));
      for(const c of r.coverage) if(!keys.has(JSON.stringify(c))) this.value.coverage.push(c);
      // Keep bounded search history; formal items and original run audits remain permanent.
      this.value.coverage = this.value.coverage.slice(-5000);
      await atomic(this.file, this.value);
    });
  }
  hydrate(r: Run, rules: string, now = Date.now()) {
    const entries = Object.values(this.value.entries).filter(e =>
      r.days.includes(e.lead.publishedAt.slice(0, 10)) ||
      (e.lead.publishedAt === "" && e.seenAt >= r.days[0]! && e.seenAt.slice(0, 10) <= r.endDate));
    r.leads = entries.sort((a, b) => Number(["accepted", "duplicate", "irrelevant"].includes(a.disposition ?? "")) - Number(["accepted", "duplicate", "irrelevant"].includes(b.disposition ?? "")) || b.seenAt.localeCompare(a.seenAt)).slice(0, 120).map(entry => this.restore(entry, rules, now));
    const relevant = this.value.coverage.filter(c => c.from <= r.endDate && c.to >= r.days[0]!);
    const full = relevant.filter(c => c.from <= r.days[0]! && c.to >= r.days[7]! && Date.parse(c.to) - Date.parse(c.from) >= 13 * 86400000);
    const gaps = Object.keys(scenes).map(scene => ({ scene, days: r.days.filter(d => !relevant.some(c => c.scene === scene && c.from <= d && c.to >= d)) }));
    const latestFull = full.map(c => c.at).sort().at(-1);
    const dueScenes = Object.keys(scenes).filter(scene => !full.some(c => c.scene === scene && now - Date.parse(c.at) < 7 * 86400000));
    r.reuse = {
      bodies: 0, duplicates: 0, cooldown: r.leads.filter(l => l.cooldown).length,
      importedLeads: r.leads.length, fullSweepDue: dueScenes.length > 0, dueScenes,
      lastFullSweepAt: latestFull, gaps, priorCoverage: relevant.slice(-100)
    };
  }
  private restore(e: Entry, rules: string, now: number): Lead {
    const l = structuredClone(e.lead);
    l.seenAt = e.seenAt; l.attemptedAt = e.attemptedAt;
    const rejected = ["accepted", "duplicate", "irrelevant"].includes(e.disposition ?? "");
    const failedAt = e.failedAt ?? (e.lead.state === "unavailable" ? e.attemptedAt : undefined);
    const failedRecently = !!failedAt && now - Date.parse(failedAt) < 86400000;
    l.cooldown = e.rules === rules && ((rejected && now - Date.parse(e.attemptedAt ?? e.seenAt) < 7 * 86400000) || failedRecently);
    if(l.cooldown) { l.state = "deferred"; l.reason = "近期相同线索已处理：" + (l.reason ?? e.disposition); }
    else { l.state = "unread"; l.classification = undefined; }
    return l;
  }
  refresh(l: Lead, rules: string, now = Date.now()) {
    const e = this.value.entries[l.url];
    if(!e) return;
    if(e.signature !== leadSignature(l) || e.rules !== rules) {
      l.cooldown = false; l.state = "unread"; l.classification = undefined; l.reason = "来源摘要或规则变化，需要重新评估";
    } else {
      const restored = this.restore(e, rules, now);
      if(restored.cooldown) Object.assign(l, restored, { title: l.title, summary: l.summary, seenAt: l.seenAt });
    }
  }
  priorOutcomes(urls: string[]) {
    return urls.map(url => this.value.entries[canonicalUrl(url)]).filter((e): e is Entry => !!e)
      .filter(e => e.lead.lastOutcome || e.dateDispute).map(e => ({url:e.lead.url, lastOutcome:e.lead.lastOutcome, dateDispute:e.dateDispute}));
  }
  unresolvedDate(e: Evidence, rules: string) {
    const dispute = this.value.entries[canonicalUrl(e.locator)]?.dateDispute;
    return dispute?.rules === rules && dispute.hash === e.hash ? dispute : undefined;
  }
  async disputeDate(e: Evidence, rules: string, reason: string) {
    if (e.kind !== "web") return;
    await this.serial(async () => {
      const entry = this.value.entries[canonicalUrl(e.locator)];
      if (entry) { entry.dateDispute = {hash:e.hash, rules, reason:reason.slice(0,2000), at:new Date().toISOString()}; await atomic(this.file,this.value); }
    });
  }
  async cached(url: string, lead?: Lead, now = Date.now()) {
    const entry = this.value.entries[canonicalUrl(url)];
    if(!entry?.evidenceId || (entry.evidenceSignature && entry.evidenceSignature !== entry.signature) || (lead && entry.evidenceSignature !== leadSignature(lead))) return;
    const e = await read<Evidence>(path.join(this.store.root, "ledger/evidence", entry.evidenceId + ".json"));
    if(e?.readable && now - Date.parse(e.fetchedAt) < 86400000) return e;
  }
}
