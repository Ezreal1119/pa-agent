import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RunMetric } from "../web/run-metrics.js";
import type { TokenUsage } from "../web/wecom-contacts.js";
import { ONES_RECEIPT } from "../ones-agent/store.js";
import { validUsage, type TaskReceipt } from "./tasks.js";

export const MEMORY_RECEIPT = "memory-delegation-v1";
export const WINDOWS_TOOLS_RECEIPT = "windows-tools-delegation-v1";
const receiptFields = {
  [ONES_RECEIPT]: "onesTasks", [MEMORY_RECEIPT]: "memoryTasks", [WINDOWS_TOOLS_RECEIPT]: "windowsToolsTasks",
} as const;
type ReceiptField = (typeof receiptFields)[keyof typeof receiptFields];
const keys = ["input", "output", "requests", "reportedRequests"] as const;
const empty = (): TokenUsage => ({input: 0, output: 0, requests: 0, reportedRequests: 0});
function record(metric: RunMetric, field: ReceiptField, task?: TaskReceipt) {
  if (!task || !validUsage(task.usage) || metric[field]?.some(t => t.taskId === task.taskId)) return;
  const {taskId, status, elapsedMs, toolCalls, usage} = task;
  (metric[field] ??= []).push({taskId, status, elapsedMs, toolCalls, usage: structuredClone(usage)});
  metric.usage ??= empty();
  for (const key of keys) metric.usage[key] += usage[key];
}
export function recordSubAgentResult(metric: RunMetric, toolResult: unknown) {
  const details = (toolResult as {details?: {onesTask?: TaskReceipt; memoryTask?: TaskReceipt; windowsToolsTask?: TaskReceipt}})?.details;
  record(metric, "onesTasks", details?.onesTask);
  record(metric, "memoryTasks", details?.memoryTask);
  record(metric, "windowsToolsTasks", details?.windowsToolsTask);
}
export function splitAgentUsage(metric: Pick<RunMetric, "usage" | ReceiptField>) {
  if (!Object.values(receiptFields).some(field => metric[field]?.length)) return;
  const main = {...(metric.usage ?? empty())};
  const ones = empty(); const memory = empty(); const windowsTools = empty();
  for (const [tasks, total] of [[metric.onesTasks, ones], [metric.memoryTasks, memory], [metric.windowsToolsTasks, windowsTools]] as const) {
    for (const task of tasks ?? []) for (const key of keys) {
      total[key] += task.usage[key];
      main[key] = Math.max(0, main[key] - task.usage[key]);
    }
  }
  return {main, ...(metric.onesTasks?.length ? {ones} : {}), ...(metric.memoryTasks?.length ? {memory} : {}), ...(metric.windowsToolsTasks?.length ? {windowsTools} : {})};
}
export function applySubAgentReceipts(metric: RunMetric, manager: SessionManager) {
  if (metric.round === null) return;
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom" || !Object.hasOwn(receiptFields, entry.customType)) continue;
    const receipt = entry.data as {round?: number; result?: TaskReceipt};
    if (receipt?.round === metric.round) record(metric, receiptFields[entry.customType as keyof typeof receiptFields], receipt.result);
  }
}
