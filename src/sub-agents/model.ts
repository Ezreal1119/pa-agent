import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelConfig } from "../config.js";
import { meterSession, usageScope } from "../usage/ledger.js";
import { sdkTokens } from "../web/run-metrics.js";
import { applyDeepSeekReasoning, isDeepSeekModel, isReasoningMode } from "../agent/reasoning.js";
import type { TaskContext } from "./tasks.js";

export async function runChildModel(options: {
  session: AgentSession; task: TaskContext; source: string; scopeKind?: string; dataDir: string; model: ModelConfig;
  maxRequests: number; prompt: string; effort?: AgentSession["thinkingLevel"];
  beforeRequest?: () => void; checkpoint?: () => void;
}) {
  const {session, task, source, dataDir, model, maxRequests, prompt, effort} = options;
  const {signal, receipt} = task;
  meterSession(session, dataDir, source, model);
  session.agent.onPayload = payload => {
    signal.throwIfAborted();
    options.beforeRequest?.();
    if (receipt.usage.requests >= maxRequests) throw new Error("Sub-agent model request budget exceeded.");
    receipt.usage.requests++;
    options.checkpoint?.();
    return effort && isDeepSeekModel(model) && isReasoningMode(effort) ? applyDeepSeekReasoning(payload, effort) : payload;
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const tokens = sdkTokens(event.message.usage);
    if (tokens) {
      receipt.usage.input += tokens.input;
      receipt.usage.output += tokens.output;
      receipt.usage.reportedRequests++;
    }
    options.checkpoint?.();
  });
  const abort = () => { void session.abort().catch(() => {}); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    await usageScope({kind: options.scopeKind ?? source, id: receipt.taskId}, () => session.prompt(prompt));
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe();
  }
}
