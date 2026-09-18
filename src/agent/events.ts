import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// Complete reference for every event currently emitted by the Pi AgentSession.
// The Record type makes TypeScript report an error if an event is missing.
export const agentEventDescriptions = {
  agent_start: "The agent started running.",
  agent_end: "The agent run ended and reports whether it will retry.",
  agent_settled: "The agent and its post-run work became fully idle.",
  turn_start: "A new agent turn started.",
  turn_end: "The current agent turn ended with its message and tool results.",
  message_start: "A message started.",
  message_update: "A message received a streaming update.",
  message_end: "A message completed.",
  tool_execution_start: "A tool call started with its validated arguments.",
  tool_execution_update: "A running tool call reported a partial result.",
  tool_execution_end: "A tool call completed with its final result.",
  queue_update: "The pending steering or follow-up message queue changed.",
  compaction_start: "Session context compaction started.",
  compaction_end: "Session context compaction completed.",
  entry_appended: "A new entry was appended to the persisted session.",
  session_info_changed: "The session metadata changed.",
  thinking_level_changed: "The active thinking level changed.",
  auto_retry_start: "An automatic retry started.",
  auto_retry_end: "An automatic retry completed.",
  summarization_retry_scheduled: "A summarization retry was scheduled.",
  summarization_retry_attempt_start: "A summarization retry attempt started.",
  summarization_retry_finished: "The summarization retry process finished.",
  bash_execution_update: "A bash execution emitted an output chunk.",
} satisfies Record<AgentSessionEvent["type"], string>;
