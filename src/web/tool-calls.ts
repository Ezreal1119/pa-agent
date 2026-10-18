import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getRunMetrics } from "./run-metrics.js";

export interface ToolCallView {
  id: string;
  sequence: number;
  name: string;
  arguments: unknown;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted" | "not-executed";
  requestedAt: number;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  result: unknown;
}

/** Reconstruct a run from original messages, without copying tool bodies into metadata. */
export function getToolRuns(session: AgentSession, activeId?: string) {
  const metrics = getRunMetrics(session, activeId);
  const totalRounds = session.messages.filter(m => m.role === "user").length;
  const rounds = new Map<number, { id: string; round: number; calls: ToolCallView[] }>();
  let round = 0;
  for (const message of session.messages) {
    if (message.role === "user") {
      round++;
      const metric = metrics.findLast(m => m.round === round || (m.id === activeId && m.round === null && round === totalRounds));
      rounds.set(round, { id: metric?.id ?? `legacy-round-${round}`, round, calls: [] });
    }
    const run = rounds.get(round);
    if (!run) continue;
    const metric = metrics.find(m => m.id === run.id);
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const timing = metric?.toolCalls?.find(t => t.id === block.id);
        run.calls.push({
          id: block.id, sequence: run.calls.length + 1, name: block.name, arguments: block.arguments,
          requestedAt: message.timestamp, startedAt: timing?.startedAt ?? null,
          finishedAt: timing?.finishedAt ?? null, elapsedMs: timing?.elapsedMs ?? null,
          status: run.id === activeId ? "running" : metric?.status === "stopped" ? "stopped" : "interrupted",
          result: null,
        });
      }
    } else if (message.role === "toolResult") {
      const call = run.calls.findLast(c => c.id === message.toolCallId && c.result === null);
      if (!call) continue;
      call.status = message.isError ? "failed" : "completed";
      call.result = { content: message.content, details: message.details ?? null, isError: message.isError };
    }
  }
  for (const run of rounds.values()) {
    const metric = metrics.find(m => m.id === run.id);
    for (const call of run.calls) {
      if (call.result === null && metric?.status === "completed") call.status = "not-executed";
    }
  }
  return rounds;
}

export function publicRunMetrics(session: AgentSession, activeId?: string) {
  const rounds = getToolRuns(session, activeId);
  return getRunMetrics(session, activeId).map(metric => {
    const run = [...rounds.values()].find(r => r.id === metric.id);
    return { ...metric, toolCallCount: run?.calls.length ?? 0 };
  });
}
