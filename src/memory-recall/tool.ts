import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_TOOL_NAME } from "../tools/memory.js";
import type { RecallQuery } from "./retrieve.js";
import type { RecallResult } from "./service.js";

export const RECALL_TOOL = "recall_memory";
export const RECALL_GUIDANCE = [
  "Company memory is a primary source for internal business facts, human corrections, undocumented specifications, firmware compatibility and customer exceptions. For these questions actively use recall_memory even when you think you know the answer or published documents are silent.",
  "Default to one combined lookup per user turn. Resolve pronouns before searching and include all relevant models, versions, features, and comparisons in that call.",
  "Use applicable excerpts directly. If a specific entry's scope or conditions need checking, call memory with action=get and its exact id and source.",
  "If the initial recall fails or times out and the missing evidence is essential to the answer, retry once with the same inputs. If the retry fails, use other relevant sources and state what remains unverified.",
  "After a completed lookup, including no_match, search again only when a concrete new clue could change the answer, such as a corrected model, an exact version or part number, or a newly established constraint.",
  "Recheck older recalled facts because memory can change. When explicitly editing or deleting extra memory, locate the exact extra entry through recall_memory first.",
].join(" ");

export function recallQueryKey({query, background, identifiers}: RecallQuery): string {
  const normalize = (value: string) => value.trim().normalize("NFC");
  const normalizedIds = [...new Set((identifiers ?? []).map(normalize).filter(Boolean))].sort();
  return JSON.stringify([normalize(query), normalize(background ?? ""), normalizedIds]);
}

type RecallToolResult = RecallResult & {reused?: true};
export function createRecallTool(invoke?: (id: string, input: RecallQuery, signal?: AbortSignal, notice?: (text: string) => void) => Promise<RecallToolResult>) {
  return defineTool({
    name: RECALL_TOOL,
    label: "召回业务记忆",
    description: RECALL_GUIDANCE,
    parameters: Type.Object({
      query: Type.String({minLength: 1, maxLength: 4000, description: "Combine the specific facts, comparisons, and exceptions needed for the user's question."}),
      background: Type.Optional(Type.String({maxLength: 6000, description: "Relevant context and confirmed constraints only."})),
      identifiers: Type.Optional(Type.Array(Type.String({minLength: 1, maxLength: 100}), {maxItems: 16, description: "Exact model/version/feature names or memory IDs."})),
    }, {additionalProperties: false}),
    execute: async (id, args, signal, update) => {
      if (!invoke) throw new Error("Recall unavailable in Prompt preview.");
      const result = await invoke(id, args, signal, text => update?.({content: [{type: "text", text}], details: {memoryNotice: text}}));
      const {candidateIds, ...visible} = result;
      return {content: [{type: "text", text: JSON.stringify(visible)}], details: {memoryTask: result}};
    },
  });
}

type Messages = AgentSession["messages"];
export function withoutRecallHistory(messages: Messages): Messages {
  const removedCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && (block.name === RECALL_TOOL || block.name === MEMORY_TOOL_NAME && block.arguments?.action === "get")) {
        removedCallIds.add(block.id);
      }
    }
  }
  if (!removedCallIds.size) return messages;
  return messages.flatMap((message): Messages => {
    if (message.role === "toolResult" && removedCallIds.has(message.toolCallId)) return [];
    if (message.role !== "assistant") return [message];
    const content = message.content.filter(block => block.type !== "toolCall" || !removedCallIds.has(block.id));
    if (content.length === message.content.length) return [message];
    return content.some(block => block.type === "toolCall" || block.type === "text" && Boolean(block.text.trim()))
      ? [{ ...message, content }]
      : [];
  });
}

export function omitOldRecallEvidence(messages: Messages, all = false): Messages {
  const current = all ? messages.length : messages.findLastIndex(message => message.role === "user");
  return messages.map((message, index) => {
    if (index >= current || message.role !== "toolResult") return message;
    const expanded = message.toolName === MEMORY_TOOL_NAME && (message.details as {memoryRead?: boolean} | undefined)?.memoryRead === true;
    if (message.toolName !== RECALL_TOOL && !expanded) return message;
    return {...message, content: [{type: "text", text: "Memory was queried in an earlier turn. Run recall_memory again for current evidence."}], details: undefined};
  });
}
