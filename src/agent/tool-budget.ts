import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const AGENT_TOOL_CALL_LIMIT = 50;

/** Count attempted calls, including invalid arguments, and reserve one final inference. */
export function installToolBudget(session: AgentSession, options: {
  limit?: number;
  finishTool?: string;
  lastRequest?: () => boolean;
} = {}) {
  const { agent } = session;
  const { finishTool, lastRequest } = options;
  const workLimit = (options.limit ?? AGENT_TOOL_CALL_LIMIT) - (finishTool ? 1 : 0);
  let calls = 0;
  let finalCalls = 0;
  let final = false;

  const unsubscribe = agent.subscribe(event => {
    if (event.type !== "tool_execution_start") return;
    if (final) finalCalls++;
    else calls++;
  });
  const before = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    if (final ? context.toolCall.name !== finishTool || finalCalls > 1 : calls > workLimit) {
      return { block: true, reason: "Tool call limit reached. Use the results already available." };
    }
    return before?.(context, signal);
  };
  const stream = agent.streamFunction;
  agent.streamFunction = (model, context, options) => {
    final ||= calls >= workLimit || Boolean(lastRequest?.());
    if (!final) return stream(model, context, options);
    const instruction = finishTool
      ? `The search budget is exhausted. Call ${finishTool} now with verified evidence and state any unresolved points. Submit a partial result when the evidence is incomplete.`
      : "The tool call budget is exhausted. Answer now using the available results and state any unresolved points.";
    const systemPrompt = `${context.systemPrompt ?? ""}\n\n${instruction}`;
    return stream(model, { ...context, systemPrompt, tools: context.tools?.filter(tool => tool.name === finishTool) }, options);
  };
  const stop = agent.shouldStopAfterTurn;
  agent.shouldStopAfterTurn = async (context, signal) => final || Boolean(await stop?.(context, signal));
  const dispose = session.dispose.bind(session);
  session.dispose = () => { unsubscribe(); dispose(); };

  return () => { calls = 0; finalCalls = 0; final = false; };
}
