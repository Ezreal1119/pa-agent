import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import type { ModelConfig } from "../config.js";
import { atomic, read } from "./store.js";

export type CostPhase = "discovery" | "research" | "review";
export interface Pricing {
  version: string;
  modelId: string;
  baseUrl: string;
  currency: "CNY";
  input: number;
  cacheRead: number;
  output: number;
  search: number;
  fetch: number;
  source: string;
}
export interface Charge {
  id: string;
  kind: "model" | "search" | "fetch";
  phase: CostPhase;
  reserved: number;
  actual?: number;
  at: string;
  usage?: { miss: number; hit: number; output: number };
}
export interface BudgetState {
  limitCny: number;
  pricing: Pricing;
  charges: Charge[];
  overrun?: boolean;
}
export class BudgetError extends Error {
  constructor(message = "预算不足，保留待研究线索") { super(message); }
}
export function pricingFor(model: ModelConfig, custom?: Pricing): Pricing {
  const url = new URL(model.baseUrl);
  if(custom) {
    if(custom.currency !== "CNY" || custom.modelId !== model.modelId ||
      custom.baseUrl.replace(/\/+$/, "") !== model.baseUrl.replace(/\/+$/, "") ||
      !custom.version || !custom.source ||
      ![custom.input, custom.cacheRead, custom.output, custom.search, custom.fetch].every(v => Number.isFinite(v) && v > 0) ||
      custom.cacheRead > custom.input) throw new Error("研究价格配置与模型不匹配或无效");
    return structuredClone(custom);
  }
  if(url.hostname !== "api.deepseek.com" || url.protocol !== "https:" ||
    !["", "/", "/v1", "/v1/"].includes(url.pathname) || model.modelId !== "deepseek-flash")
    throw new Error("研究模型缺少适用的 CNY 价格配置，禁止按零价格启动");
  // Conservative peak tariff, including the announced tool tariff. Never assumes a free promotion.
  return {
    version: "deepseek-flash-2026-10-26-peak", modelId: model.modelId,
    baseUrl: model.baseUrl, currency: "CNY", input: 2, cacheRead: .04, output: 8,
    search: .005, fetch: .005, source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
  };
}
export function budgetTotals(state: BudgetState) {
  const spentCny = state.charges.reduce((n, c) => n + (c.actual ?? 0), 0);
  const reservedCny = state.charges.reduce((n, c) => n + (c.actual === undefined ? c.reserved : 0), 0);
  return {
    limitCny: state.limitCny, spentCny, reservedCny,
    availableCny: Math.max(0, state.limitCny - spentCny - reservedCny),
    discoveryCny: state.charges.filter(c => c.phase === "discovery").reduce((n, c) => n + (c.actual ?? c.reserved), 0),
    cacheHitTokens: state.charges.reduce((n, c) => n + (c.usage?.hit ?? 0), 0),
    cacheMissTokens: state.charges.reduce((n, c) => n + (c.usage?.miss ?? 0), 0),
    outputTokens: state.charges.reduce((n, c) => n + (c.usage?.output ?? 0), 0),
    pricingVersion: state.pricing.version, estimated: true
  };
}
interface Group { limitCny: number; charges: Record<string, number>; blocked?: string; }
export interface AggregateBudget { file: string; limitCny: number; }
/** Serializes reservations before sending requests, including parallel fetches and other validation processes. */
export class ResearchBudget {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly state: BudgetState, private persist: () => Promise<void>,
    private aggregate?: AggregateBudget) { }
  private serial<T>(fn: () => Promise<T>) {
    const task = this.queue.then(fn); this.queue = task.catch(() => { }); return task;
  }
  private async group<T>(fn: (group?: Group) => Promise<T>): Promise<T> {
    if(!this.aggregate) return fn();
    await fs.mkdir(path.dirname(this.aggregate.file), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.aggregate.file, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 100 } });
    try {
      const g = await read<Group>(this.aggregate.file) ?? { limitCny: this.aggregate.limitCny, charges: {} };
      // A restart or another script may lower a cap but cannot silently reset/increase it.
      g.limitCny = Math.min(g.limitCny, this.aggregate.limitCny);
      const result = await fn(g);
      await atomic(this.aggregate.file, g);
      return result;
    } finally { await release(); }
  }
  available(phase: CostPhase) {
    if(this.state.overrun) return 0;
    const t = budgetTotals(this.state);
    const total = Math.max(0, t.availableCny - (phase === "review" ? 0 : this.state.limitCny * .25));
    return phase === "discovery" ? Math.max(0, Math.min(total, this.state.limitCny * .2 - t.discoveryCny)) : total;
  }
  async reserve(kind: Charge["kind"], phase: CostPhase, amount: number) {
    return this.serial(() => this.group(async group => {
      if(group?.blocked) throw new BudgetError(group.blocked);
      if(!Number.isFinite(amount) || amount <= 0 || amount > this.available(phase) + 1e-10)
        throw new BudgetError(phase === "discovery" ? "发现阶段预算已到，转入线索核实" : undefined);
      if(group && Object.values(group.charges).reduce((a, b) => a + b, 0) + amount > group.limitCny + 1e-10)
        throw new BudgetError("付费验证总预算已到，保留未完成线索");
      const charge: Charge = { id: randomUUID(), kind, phase, reserved: amount, at: new Date().toISOString() };
      // Persist group first: a crash can over-reserve but must never forget an authorized charge.
      if(group) { group.charges[charge.id] = amount; await atomic(this.aggregate!.file, group); }
      this.state.charges.push(charge); await this.persist(); return charge.id;
    }));
  }
  async settle(id: string, actual: number, usage?: Charge["usage"]) {
    return this.serial(() => this.group(async group => {
      const c = this.state.charges.find(c => c.id === id);
      if(!c || c.actual !== undefined) return;
      if(!Number.isFinite(actual) || actual < 0) throw new Error("Invalid research usage");
      const overrun = actual > c.reserved + 1e-8;
      c.actual = actual; c.usage = usage; this.state.overrun ||= overrun; await this.persist();
      if(group) {
        group.charges[id] = actual;
        if(overrun) group.blocked = "验证用量超出预留，检查价格与token上界后再处理";
        await atomic(this.aggregate!.file, group);
      }
      if(overrun) throw new BudgetError("实际用量超出保守预留，停止后续调用并检查价格配置");
    }));
  }
  async model(payload: Record<string, any>, phase: CostPhase, maxTokens: number) {
    // UTF-8 bytes plus generous per-message/tool template overhead is an upper bound for byte-based tokenizers.
    const input = Buffer.byteLength(JSON.stringify({ messages: payload.messages, tools: payload.tools, response_format: payload.response_format }), "utf8") +
      4096 + (payload.messages?.length ?? 0) * 128 + (payload.tools?.length ?? 0) * 256;
    const price = this.state.pricing;
    const inputCost = input * price.input / 1e6;
    const output = Math.min(maxTokens, Math.floor((this.available(phase) - inputCost) * 1e6 / price.output));
    if(output < Math.min(maxTokens, phase === "research" ? 4096 : phase === "review" ? 2048 : 1024)) throw new BudgetError("剩余额度不足以安全发起模型请求，保留待处理线索");
    const id = await this.reserve("model", phase, inputCost + output * price.output / 1e6);
    return { id, payload: { ...payload, ["max_completion_tokens" in payload ? "max_completion_tokens" : "max_tokens"]: output } };
  }
  async usage(id: string, raw: unknown) {
    const u = raw as { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } | null;
    if(!u || ![u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0].every(n => Number.isSafeInteger(n) && Number(n) >= 0) ||
      u.input! + u.output! + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) === 0) return; // retain reservation
    const usage = { miss: u.input! + (u.cacheWrite ?? 0), hit: u.cacheRead ?? 0, output: u.output! };
    const p = this.state.pricing;
    await this.settle(id, (usage.miss * p.input + usage.hit * p.cacheRead + usage.output * p.output) / 1e6, usage);
  }
}
