import { performance } from "node:perf_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { saveRunMetric, getRunMetrics, sdkTokens, type RunMetric } from "../web/run-metrics.js";
import { applyDeepSeekReasoning, type ReasoningMode } from "../agent/reasoning.js";
import type { McpTask, TaskAnswer } from "./store.js";

/** Same SDK usage semantics as Web/WeCom; count every tool-loop model request once. */
export async function runMcpAgent(session: AgentSession, task: McpTask, question: string, signal: AbortSignal, options: {
  modelId: string; effort: ReasoningMode | "provider-default"; update: (metric: RunMetric) => Promise<void>; redact: (error: unknown) => string;
}): Promise<TaskAnswer & { status: McpTask["status"] }> {
  const started = performance.now();
  const metric: RunMetric = { id: task.id, mcpTaskId: task.id, sequence: getRunMetrics(session).length + 1, round: null, modelId: options.modelId, effort: options.effort, startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: null, firstTextMs: null, status: "running", toolCalls: [], usage: { input: 0, output: 0, requests: 0, reportedRequests: 0 } };
  const rounds = session.messages.filter(m => m.role === "user").length;
  let persistence = Promise.resolve(); let persistenceError: unknown;
  const persist = () => {
    saveRunMetric(session, metric); const snapshot = structuredClone(metric);
    persistence = persistence.then(() => options.update(snapshot)).catch(error => { persistenceError ??= error; });
  };
  const prior = session.agent.onPayload;
  session.agent.onPayload = async (payload, model) => {
    metric.usage!.requests++; persist(); await persistence;
    if (persistenceError) throw persistenceError;
    const result = await prior?.(payload, model);
    return options.effort === "provider-default" ? result ?? payload : applyDeepSeekReasoning(result ?? payload, options.effort);
  };
  const times = new Map<string, number>();
  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = sdkTokens(event.message.usage);
      if (usage) { metric.usage!.input += usage.input; metric.usage!.output += usage.output; metric.usage!.reportedRequests++; } persist();
    }
    if (event.type === "message_end" && event.message.role === "user" && metric.round === null) { metric.round = rounds + 1; persist(); }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") metric.firstTextMs ??= Math.round(performance.now() - started);
    if (event.type === "tool_execution_start") { times.set(event.toolCallId, performance.now()); metric.toolCalls!.push({ id: event.toolCallId, startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: null }); persist(); }
    if (event.type === "tool_execution_end") {
      const timing = metric.toolCalls!.findLast(t => t.id === event.toolCallId); const start = times.get(event.toolCallId);
      if (timing && start !== undefined) { timing.finishedAt = new Date().toISOString(); timing.elapsedMs = Math.round(performance.now() - start); } persist();
    }
  });
  const stop = () => void session.abort(); signal.addEventListener("abort", stop, { once: true });
  let error: string | undefined;
  try {
    signal.throwIfAborted(); if (options.effort !== "provider-default") session.setThinkingLevel(options.effort);
    persist(); await persistence; if (persistenceError) throw persistenceError;
    await session.prompt(question);
    const last = session.messages.findLast(m => m.role === "assistant");
    if (signal.aborted || last?.role === "assistant" && last.stopReason === "aborted") { metric.status = "stopped"; error = options.redact(signal.reason ?? new Error("MCP task stopped.")); }
    else if (last?.role === "assistant" && last.stopReason === "error") { metric.status = "failed"; error = options.redact(last.errorMessage ?? "The model run failed."); }
    else metric.status = "completed";
  } catch (failure) { metric.status = signal.aborted ? "stopped" : "failed"; error = options.redact(signal.aborted ? signal.reason ?? failure : failure); }
  finally {
    metric.finishedAt = new Date().toISOString(); metric.elapsedMs = Math.round(performance.now() - started);
    if (session.messages.filter(m => m.role === "user").length > rounds) metric.round = rounds + 1;
    try { persist(); await persistence; }
    finally { unsubscribe(); signal.removeEventListener("abort", stop); session.agent.onPayload = prior; }
  }
  if (persistenceError) throw persistenceError;
  const last = metric.round === null ? undefined : session.messages.slice(session.messages.findLastIndex(m => m.role === "user") + 1).findLast(m => m.role === "assistant");
  const answer = last?.role === "assistant" ? last.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
  return { answer, ...(error ? { error } : {}), status: metric.status === "stopped" ? "cancelled" : metric.status };
}
