import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ManagedFile } from "./store.js";
import type { MessageAttachments } from "../agent/message-attachments.js";

const OUTPUT_TYPE = "generated-file-v1";
export interface GeneratedFile {
  runId?: string;
  userMessageId: string;
  round: number;
  toolCallId: string;
  file: ManagedFile;
}
/** Called only after the backend has validated and published a real output file. */
export function registerGeneratedFile(manager: SessionManager, userMessageId: string, toolCallId: string, file: ManagedFile): void {
  const branch = manager.getBranch();
  const users = branch.filter(entry => entry.type === "message" && entry.message.role === "user");
  const index = users.findIndex(entry => entry.id === userMessageId);
  const user = users[index];
  if (!user || user.type !== "message") throw new Error("Cannot associate output with its user message.");
  const binding = branch.findLast(entry => entry.type === "custom" && entry.customType === "message-attachments-v1" && (entry.data as MessageAttachments)?.round === index + 1 && (entry.data as MessageAttachments)?.timestamp === user.message.timestamp);
  const runId = binding?.type === "custom" ? (binding.data as MessageAttachments).runId : undefined;
  manager.appendCustomEntry(OUTPUT_TYPE, { runId, userMessageId, round: index + 1, toolCallId, file: structuredClone(file) } satisfies GeneratedFile);
}
export function generatedFiles(session: AgentSession): GeneratedFile[] {
  const records = new Map<string, GeneratedFile>();
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== OUTPUT_TYPE) continue;
    const value = entry.data as GeneratedFile | undefined;
    if (value?.file?.direction !== "outputs" || typeof value.userMessageId !== "string" || !Number.isInteger(value.round) || typeof value.toolCallId !== "string" || !/^[a-f0-9-]{36}$/.test(value.file.id)) continue;
    records.set(value.file.id, value);
  }
  return [...records.values()];
}
