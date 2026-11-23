import { validUsage, type ParentBinding } from "../sub-agents/tasks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { atomic, safePath } from "../knowledge-sync/core.js";
import type { Delegation, OnesTaskResult } from "./types.js";

export const ONES_RECEIPT = "ones-delegation-v1";
export const ONES_USAGE = "ones-task-usage-v1";

export type { ParentBinding };
export interface TaskRecord {
  version: 1; parentId: string; created: string; originalQuestion: string; delegation: Delegation; binding?: ParentBinding;
  result: OnesTaskResult;
}
const month = 30 * 86400000;
/** No model/runtime required: recover interrupted child tasks before parent metrics are read. */
export async function recoverOnesTasks(dataDir: string, cwd: string, parentId: string) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(parentId)) throw new Error("Invalid ONES parent.");
  const directory = await safePath(path.join(dataDir, "agents/ones/parents"), parentId);
  const tasksDir = await safePath(directory, "tasks");
  const names = await fs.readdir(tasksDir).catch(error => {if (error.code === "ENOENT") return [] as string[]; throw error;});
  const records: TaskRecord[] = [];
  let child: SessionManager | undefined; let childLoaded = false;
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = await safePath(tasksDir, name); const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid ONES task file.");
    const record = JSON.parse(await fs.readFile(file, "utf8")) as TaskRecord;
    if (!record || record.version !== 1 || record.parentId !== parentId || !record.result || !["queued", "running", "completed", "partial", "needs_clarification", "failed", "cancelled", "interrupted"].includes(record.result.status) || !Number.isSafeInteger(record.result.elapsedMs) || record.result.elapsedMs < 0 || name !== record.result.taskId + ".json" || !validUsage(record.result.usage) || !Number.isFinite(Date.parse(record.created)) || !Number.isSafeInteger(record.result.toolCalls) || record.result.toolCalls < 0 || record.binding && (!Number.isSafeInteger(record.binding.round) || record.binding.round < 1 || typeof record.binding.toolCallId !== "string")) throw new Error("Invalid ONES task record.");
    if (Date.parse(record.created) < Date.now() - month) {await fs.rm(file); continue;}
    if (["queued", "running"].includes(record.result.status)) {
      if (!childLoaded) {
        childLoaded = true;
        const sessionsDir = await safePath(directory, "sessions");
        const files = await SessionManager.list(cwd, sessionsDir);
        if (files.length > 1) throw new Error("Ambiguous ONES child history.");
        if (files[0]) child = SessionManager.open(await safePath(sessionsDir, path.basename(files[0].path)), sessionsDir, cwd);
      }
      const usage = child?.getBranch().findLast(e => e.type === "custom" && e.customType === ONES_USAGE && (e.data as {taskId?: string})?.taskId === record.result.taskId);
      if (usage?.type === "custom") {
        const data = usage.data as {usage: OnesTaskResult["usage"]; toolCalls: number};
        if (!validUsage(data.usage) || !Number.isSafeInteger(data.toolCalls) || data.toolCalls < 0) throw new Error("Invalid ONES usage checkpoint.");
        record.result.usage = data.usage; record.result.toolCalls = data.toolCalls;
      }
      record.result.status = "interrupted"; record.result.answer = "服务重启前 ONES 查询尚未完成，未自动重新执行。";
      await atomic(file, JSON.stringify(record));
    }
    records.push(record);
  }
  return records;
}
export async function recoverOnesReceipts(dataDir: string, cwd: string, parent: SessionManager) {
  const tasks = await recoverOnesTasks(dataDir, cwd, parent.getSessionId());
  const saved = new Set(parent.getBranch().flatMap(e => e.type === "custom" && e.customType === ONES_RECEIPT ? [(e.data as {result?: OnesTaskResult})?.result?.taskId] : []));
  for (const task of tasks) if (task.binding && !saved.has(task.result.taskId)) {
    parent.appendCustomEntry(ONES_RECEIPT, {round: task.binding.round, toolCallId: task.binding.toolCallId, result: task.result});
    saved.add(task.result.taskId);
  }
}

/** Runs before HTTP admission; archived detail reads can remain strictly read-only. */
export async function recoverAllOnesReceipts(dataDir: string, cwd: string, sessionsDir: string) {
  const directory = await safePath(path.join(dataDir, "agents/ones/parents"));
  const entries = await fs.readdir(directory, {withFileTypes: true}).catch(error => {if (error.code === "ENOENT") return []; throw error;});
  if (!entries.length) return;
  const saved = new Map((await SessionManager.list(cwd, sessionsDir)).map(s => [s.id, s.path]));
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9-]{8,80}$/.test(entry.name)) continue;
    const file = saved.get(entry.name);
    if (file) await recoverOnesReceipts(dataDir, cwd, SessionManager.open(await safePath(sessionsDir, path.basename(file)), sessionsDir, cwd));
  }
}
