import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Observation, TokenUsage } from "./wecom-contacts.js";
import type { ReasoningMode } from "../agent/reasoning.js";

export const RUN_METRICS_TYPE = "web-run-metrics-v1";
export type RunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";
export interface ToolTiming {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
}
export interface RunMetric {
  id: string;
  sequence: number;
  round: number | null;
  modelId: string;
  effort: ReasoningMode | "provider-default";
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  firstTextMs: number | null;
  status: RunStatus;
  /** Timing only; arguments/results remain in the original SDK messages. */
  toolCalls?: ToolTiming[];
  wecom?: Observation;
  mcpTaskId?: string;
  usage?: TokenUsage;
}

/** Custom entries persist in the SDK log but are excluded from model context. */
export function saveRunMetric(session: AgentSession, metric: RunMetric): void {
  session.sessionManager.appendCustomEntry(RUN_METRICS_TYPE, structuredClone(metric));
}

export function getRunMetrics(session: AgentSession, activeId?: string): RunMetric[] {
  return readRunMetrics(session.sessionManager, activeId);
}

export function readRunMetrics(manager: AgentSession["sessionManager"], activeId?: string): RunMetric[] {
  const runs = new Map<string, RunMetric>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== RUN_METRICS_TYPE) continue;
    const value = entry.data as Partial<RunMetric> | null;
    if (!value || typeof value.id !== "string" || typeof value.sequence !== "number" || typeof value.startedAt !== "string" || typeof value.status !== "string") continue;
    const metric = value as RunMetric;
    runs.set(metric.id, metric.status === "running" && metric.id !== activeId
      ? { ...metric, status: "interrupted", elapsedMs: null, finishedAt: null }
      : metric);
  }
  return [...runs.values()];
}

/** SDK input excludes cache reads/writes; output already contains reasoning tokens.
 * All-zero SDK usage is also the default when the provider omits usage. */
export function sdkTokens(raw: unknown): { input: number; output: number } | undefined {
  const u = raw as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  if (!u || ![u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return;
  const input = u.input! + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0); const output = u.output!;
  if (input + output > 0) return { input, output };
}
export function visionTokens(raw: unknown): { input: number; output: number } | undefined {
  const u = raw as { prompt_tokens?: number; completion_tokens?: number } | null;
  if (!u || ![u.prompt_tokens, u.completion_tokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return;
  return { input: u.prompt_tokens!, output: u.completion_tokens! };
}
