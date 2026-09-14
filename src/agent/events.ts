import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface PatrickMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface PatrickSessionState {
  sessionId: string;
  model: string | null;
  isStreaming: boolean;
  messages: PatrickMessage[];
}

export type PatrickEvent =
  | { type: "state"; state: PatrickSessionState }
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; isError: boolean }
  | { type: "status"; status: "idle" | "running" | "stopping" }
  | { type: "error"; message: string };

export function translateAgentEvent(event: AgentSessionEvent): PatrickEvent | null {
  if (event.type === "agent_start") {
    return { type: "status", status: "running" };
  }

  if (event.type === "agent_settled") {
    return { type: "status", status: "idle" };
  }

  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      return { type: "assistant_delta", text: event.assistantMessageEvent.delta };
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      return { type: "thinking_delta", text: event.assistantMessageEvent.delta };
    }
  }

  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      id: event.toolCallId,
      name: event.toolName,
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      id: event.toolCallId,
      name: event.toolName,
      isError: event.isError,
    };
  }

  return null;
}
