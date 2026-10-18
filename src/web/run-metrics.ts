import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
}

/** Custom entries persist in the SDK log but are excluded from model context. */
export function saveRunMetric(session: AgentSession, metric: RunMetric): void {
  session.sessionManager.appendCustomEntry(RUN_METRICS_TYPE, structuredClone(metric));
}

export function getRunMetrics(session: AgentSession, activeId?: string): RunMetric[] {
  const runs = new Map<string, RunMetric>();
  for (const entry of session.sessionManager.getBranch()) {
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
