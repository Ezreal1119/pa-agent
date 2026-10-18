import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Messages = AgentSession["agent"]["state"]["messages"];

/** A round starts with a user message and includes every ensuing tool exchange. */
export function recentRounds(messages: Messages, limit = 5): Messages {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Round limit must be a positive integer.");
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") starts.push(i);
  }
  const start = starts[Math.max(0, starts.length - limit)];
  if (start === undefined) return [];
  // Summaries can contain arbitrarily old history and must not bypass the window.
  return messages.slice(start).filter(message =>
    message.role !== "compactionSummary" && message.role !== "branchSummary",
  );
}
