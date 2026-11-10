import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { messageAttachments } from "../agent/message-attachments.js";
import { generatedFiles } from "../file-tools/outputs.js";
import type { ManagedFile } from "../file-tools/store.js";
import { getToolRuns, publicRunMetrics } from "./tool-calls.js";

export const CHAT_HISTORY_PAGE_SIZE = 30;
export class ChatHistoryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function historyPageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) throw new ChatHistoryError("History page size must be an integer between 1 and 100.");
  return value;
}
export interface HistoryPageOptions { limit: number; before?: string; }
function beforeId(cursor: string, sessionId: string): string {
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || Object.keys(value).sort().join(",") !== "before,session,v" || value.v !== 1 || value.session !== sessionId || typeof value.before !== "string" || !value.before || value.before.length > 256) throw new Error();
    return value.before;
  } catch { throw new ChatHistoryError("Invalid conversation history cursor."); }
}
function cursor(sessionId: string, before: string) {
  return Buffer.from(JSON.stringify({ v: 1, session: sessionId, before })).toString("base64url");
}

/** Build lightweight positions first; only convert the selected page to display text.
 * Source entry IDs survive appends/restarts. No stored conversation is rewritten. */
export function chatHistory(session: AgentSession, files: ManagedFile[], activeId?: string, page?: HistoryPageOptions) {
  const tools = getToolRuns(session, activeId);
  const runs = publicRunMetrics(session, activeId, tools);
  const runsById = new Map(runs.map(run => [run.id, run]));
  const branch = session.sessionManager.getBranch();
  type VisibleMessage = Extract<AgentSession["messages"][number], { role: "user" | "assistant" }>;
  const entries = new Map<string, { id: string; message: VisibleMessage }[]>();
  const users = new Map<string, number>();
  let userIndex = 0;
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user" && entry.message.role !== "assistant") continue;
    if (entry.message.role === "user") users.set(entry.id, ++userIndex);
    const key = `${entry.message.role}:${entry.message.timestamp}`;
    const matches = entries.get(key) ?? []; matches.push({ id: entry.id, message: entry.message }); entries.set(key, matches);
  }
  const identify = (message: VisibleMessage) => {
    const matches = entries.get(`${message.role}:${message.timestamp}`);
    if (matches?.length) {
      const index = matches.length === 1 ? 0 : matches.findIndex(entry => entry.message === message || JSON.stringify(entry.message.content) === JSON.stringify(message.content));
      if (index >= 0) return matches.splice(index, 1)[0]!.id;
    }
    // A not-yet-persisted message can be present during an active run.
    return "live-" + createHash("sha256").update(JSON.stringify([message.role, message.timestamp, message.content])).digest("hex");
  };
  const knownFiles = new Map(files.filter(file => file.direction === "outputs").map(file => [file.id, file]));
  const outputs = new Map<number, Map<string, ManagedFile>>();
  const addOutput = (round: number, id: string) => {
    const file = knownFiles.get(id); if (!file) return;
    if (!outputs.has(round)) outputs.set(round, new Map());
    outputs.get(round)!.set(id, file);
  };
  for (const record of generatedFiles(session)) {
    const round = users.get(record.userMessageId);
    if (round) addOutput(round, record.file.id);
  }
  for (const run of tools.values()) for (const call of run.calls) {
    const result = call.result as { details?: { ok?: boolean; file?: { id?: string } } } | null;
    if (["excel_patch_template", "excel_create", "text_file_create"].includes(call.name) && call.status === "completed" && result?.details?.ok === true && result.details.file?.id) addOutput(run.round, result.details.file.id);
  }
  type Position = { id: string; role: "user" | "assistant"; timestamp: number; round: number; message?: VisibleMessage; placeholder?: string; };
  const positions: Position[] = [];
  const lastAnswer = new Map<number, string>();
  let round = 0; let hasAnswer = false; let userId = "start"; let userTimestamp = 0;
  const flush = () => {
    const toolRun = tools.get(round);
    if (!hasAnswer && (toolRun?.calls.length || outputs.has(round))) {
      const id = `placeholder-${userId}`;
      positions.push({ id, role: "assistant", timestamp: toolRun?.calls.at(-1)?.requestedAt ?? userTimestamp, round, placeholder: outputs.has(round) ? "Files are ready to download below." : "No text answer yet. You can inspect the tool calls." });
      lastAnswer.set(round, id);
    }
  };
  for (const message of session.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const id = identify(message);
    if (message.role === "user") { flush(); round++; hasAnswer = false; userId = id; userTimestamp = message.timestamp; }
    const hasText = typeof message.content === "string" ? Boolean(message.content) : message.content.some(c => c.type === "text" && c.text.length > 0);
    if (!hasText) continue;
    if (message.role === "assistant") { hasAnswer = true; lastAnswer.set(round, id); }
    positions.push({ id, role: message.role, timestamp: message.timestamp, round, message });
  }
  flush();
  let start = 0; let end = positions.length;
  if (page) {
    historyPageSize(page.limit);
    if (page.before !== undefined) {
      const id = beforeId(page.before, session.sessionId);
      end = positions.findIndex(item => item.id === id);
      if (end < 0) throw new ChatHistoryError("Conversation history changed. Reopen the conversation to load its latest messages.", 409);
    }
    start = Math.max(0, end - page.limit);
  }
  const attached = new Map(messageAttachments(session).map(record => [`${record.round}:${record.timestamp}`, record.files]));
  const messages = positions.slice(start, end).map(position => {
    const toolRun = tools.get(position.round);
    const run = toolRun ? runsById.get(toolRun.id) : undefined;
    const message = position.message;
    const text = message ? typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("") : position.placeholder!;
    const outputFiles = position.role === "assistant" && lastAnswer.get(position.round) === position.id ? [...(outputs.get(position.round)?.values() ?? [])] : [];
    return {
      ...(page ? { id: position.id } : {}), role: position.role, text, timestamp: position.timestamp,
      outputs: outputFiles,
      outputNotice: outputFiles.length && run && run.status !== "completed" ? run.status === "running" ? "File ready; the run is still in progress." : "Files are ready to download, although the run did not finish successfully." : "",
      ...(position.role === "user" ? { attachments: attached.get(`${position.round}:${position.timestamp}`) ?? [] } : { toolRunId: toolRun?.id, toolCallCount: toolRun?.calls.length ?? 0 }),
      run,
    };
  });
  return { messages, runs, rounds: round, ...(page ? { page: { hasMore: start > 0, nextCursor: start > 0 ? cursor(session.sessionId, positions[start]!.id) : null } } : {}) };
}
