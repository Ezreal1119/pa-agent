import lockfile from "proper-lockfile";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { atomic, readJson, safePath } from "../knowledge-sync/core.js";
import { pricingFor, type Pricing } from "../research/budget.js";

type Model = { modelId: string; baseUrl: string };
type Scope = { kind: string; id: string };
const scopes = new AsyncLocalStorage<Scope>();
const configuredPrices = new Map<string, string | undefined>();
export const configureUsagePricing = (dataDir: string, raw?: string) => configuredPrices.set(path.resolve(dataDir), raw);
export const usageScope = <T>(scope: Scope, task: () => T): T => scopes.run(scope, task);
type Tokens = { input: number; cacheRead: number; output: number };
type Receipt = { version: 1; id: string; source: string; scope?: Scope; model: string; started: string; finished?: string; tokens?: Tokens; price?: Pricing; amount?: number };
export type CostSummary = { cny: number; requests: number; priced: number; unpriced: number; missingUsage: number; pending: number; historyMissing: boolean };
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function tokens(value: any, sdk: boolean): Tokens | undefined {
  if (sdk) {
    if (!value || ![value.input, value.output, value.cacheRead ?? 0, value.cacheWrite ?? 0].every(count) || value.input + value.output + (value.cacheRead ?? 0) + (value.cacheWrite ?? 0) === 0) return;
    return { input: value.input + (value.cacheWrite ?? 0), cacheRead: value.cacheRead ?? 0, output: value.output };
  }
  if (!value || !count(value.prompt_tokens) || !count(value.completion_tokens)) return;
  const hit = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0;
  if (!count(hit) || hit > value.prompt_tokens) return;
  return { input: value.prompt_tokens - hit, cacheRead: hit, output: value.completion_tokens };
}
function price(model: Model, dataDir: string): Pricing | undefined {
  try {
    const url = new URL(model.baseUrl); if (url.username || url.password || url.search || url.hash) return;
    const raw = configuredPrices.has(path.resolve(dataDir)) ? configuredPrices.get(path.resolve(dataDir)) : process.env.RESEARCH_PRICING_JSON;
    const custom = raw ? JSON.parse(raw) : undefined;
    return pricingFor({ ...model, apiKey: "", contextWindow: 1, maxTokens: 1 }, custom);
  } catch { return; }
}

/** Request receipts contain no keys, prompts, answers, file paths or images. */
export class UsageLedger {
  readonly directory: string;
  constructor(readonly dataDir: string) { this.directory = path.join(dataDir, "usage-ledger"); }
  async init() {
    await safePath(this.directory); await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await safePath(this.directory, "coverage.json");
    try { await fs.writeFile(file, JSON.stringify({ version: 1, since: new Date().toISOString() }), { mode: 0o600, flag: "wx" }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  private async locked<T>(task: () => Promise<T>) {
    const release = await lockfile.lock(this.directory, { realpath: false, stale: 30000, update: 5000, retries: { retries: 60, minTimeout: 10, maxTimeout: 100 } });
    try { return await task(); } finally { await release(); }
  }
  async start(source: string, model: Model) {
    await this.init();
    const record: Receipt = { version: 1, id: randomUUID(), source, scope: scopes.getStore(), model: model.modelId, started: new Date().toISOString(), price: price(model, this.dataDir) };
    const file = path.join(this.directory, record.id + ".json");
    await atomic(file, JSON.stringify(record));
    let settled = false;
    return { finish: async (raw?: unknown, sdk = false) => {
      if (settled) return;
      await this.locked(async () => {
        const cutoff = await readJson<{ through: number }>(path.join(this.directory, "accounting-cutoff.json"), { through: 0 });
        if (!Number.isFinite(cutoff.through)) throw new Error("Invalid accounting cutoff.");
        // A receipt settled after a frozen report belongs to the next period,
        // including same-millisecond completions and another local process.
        record.finished ??= new Date(Math.max(Date.now(), cutoff.through + 1)).toISOString(); record.tokens = tokens(raw, sdk);
        if (record.tokens && record.price) record.amount = (record.tokens.input * record.price.input + record.tokens.cacheRead * record.price.cacheRead + record.tokens.output * record.price.output) / 1e6;
        await atomic(file, JSON.stringify(record)); settled = true;
      });
    } };
  }
  async summary(from: string, to: string, scopeIds?: string[]): Promise<CostSummary> {
    const lo = Date.parse(from), hi = Date.parse(to);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) throw new Error("Invalid usage period.");
    await this.init();
    return this.locked(async () => {
      const cutoffFile = path.join(this.directory, "accounting-cutoff.json");
      const cutoff = await readJson<{ through: number }>(cutoffFile, { through: 0 });
      if (!Number.isFinite(cutoff.through)) throw new Error("Invalid accounting cutoff.");
      await atomic(cutoffFile, JSON.stringify({ through: Math.max(hi, cutoff.through) }));
      const coverage = await readJson<{ version: number; since: string }>(path.join(this.directory, "coverage.json"), { version: 0, since: "" });
      if (coverage.version !== 1 || !Number.isFinite(Date.parse(coverage.since))) throw new Error("Invalid usage coverage.");
      const result: CostSummary = { cny: 0, requests: 0, priced: 0, unpriced: 0, missingUsage: 0, pending: 0, historyMissing: lo < Date.parse(coverage.since) };
      for (const name of await fs.readdir(this.directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const r = await readJson<Receipt | null>(await safePath(this.directory, name), null);
        if (!r || r.version !== 1 || r.id + ".json" !== name || !Number.isFinite(Date.parse(r.started))) throw new Error("Invalid usage receipt.");
        if (scopeIds && (!r.scope || r.scope.kind !== "sync" || !scopeIds.includes(r.scope.id))) continue;
        const end = r.finished ? Date.parse(r.finished) : undefined;
        if (end === undefined) { if (Date.parse(r.started) <= hi) result.pending++; continue; }
        if (!Number.isFinite(end)) throw new Error("Invalid usage receipt time.");
        if (end <= lo || end > hi) continue;
        result.requests++;
        if (!r.tokens) result.missingUsage++;
        else if (r.amount === undefined) result.unpriced++;
        else { if (!Number.isFinite(r.amount) || r.amount < 0) throw new Error("Invalid usage charge."); result.cny += r.amount; result.priced++; }
      }
      return result;
    });
  }
}

/** Wrap the actual SDK stream, so later onPayload hooks cannot bypass metering. */
export function meterSession(session: AgentSession, dataDir: string | undefined, source: string, model: Model) {
  if (!dataDir) return;
  const original = session.agent.streamFunction;
  session.agent.streamFunction = async (m, context, options) => {
    const receipt = await new UsageLedger(dataDir).start(source, model);
    try {
      const stream = await original(m, context, options);
      const originalResult = stream.result.bind(stream);
      let result: ReturnType<typeof originalResult> | undefined;
      stream.result = () => result ??= originalResult().then(async message => { await receipt.finish(message.usage, true); return message; }, async error => { await receipt.finish(); throw error; });
      return stream;
    } catch (error) { await receipt.finish(); throw error; }
  };
}
export async function metered<T>(dataDir: string | undefined, source: string, model: Model, task: (record: (usage: unknown) => Promise<void>) => Promise<T>): Promise<T> {
  const receipt = dataDir ? await new UsageLedger(dataDir).start(source, model) : undefined;
  try { return await task(async usage => { await receipt?.finish(usage); }); }
  finally { await receipt?.finish(); }
}
