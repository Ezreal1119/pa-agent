import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Message = AgentSession["messages"][number];
const key = (m: Message) => JSON.stringify([m.role, "timestamp" in m ? m.timestamp : null, "toolCallId" in m ? m.toolCallId : null]);

/** Display/audit history is independent of the compacted inference context. */
export function historyMessages(session: AgentSession): Message[] {
  const branch = session.sessionManager.getBranch();
  if (!branch.some(e => e.type === "compaction" || e.type === "custom" && e.customType === "chat-context-v1")) return session.messages;
  const messages = branch.flatMap(e => e.type === "message" ? [e.message] : []);
  const saved = new Set(messages.map(key));
  // Streaming messages may not have reached the SDK log yet.
  return [...messages, ...session.messages.filter(m => (m.role === "user" || m.role === "assistant" || m.role === "toolResult") && !saved.has(key(m)))];
}

export const historyRounds = (session: AgentSession) => historyMessages(session).filter(m => m.role === "user").length;
