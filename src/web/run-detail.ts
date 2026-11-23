import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { readRunMetrics } from "./run-metrics.js";

/** Read one recorded WeCom round without creating an Agent or exposing tool/thinking data. */
export function wecomRunDetail(manager: SessionManager, runId: string, activeId?: string, activeText?: string) {
  const run = readRunMetrics(manager, activeId).find(value => value.id === runId && value.wecom);
  if (!run) return;
  const answers: string[] = [];
  let round = 0;
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") round++;
    if (run.round === null || round !== run.round || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("");
    if (text) answers.push(text);
  }
  let answer = run.id === activeId && activeText !== undefined ? activeText : answers.join("\n\n");
  if (run.onesTasks?.length) answer += "\n\nONES 查询：\n" + run.onesTasks.map(t => `${t.taskId} · ${t.status} · ${(t.elapsedMs / 1000).toFixed(1)} 秒 · ${t.toolCalls} 次查询 · ${t.usage.input + t.usage.output} tokens`).join("\n");
  if (run.memoryTasks?.length) answer += "\n\n记忆召回：\n" + run.memoryTasks.map(t => `${t.status} · ${(t.elapsedMs / 1000).toFixed(1)} 秒 · ${t.usage.input + t.usage.output} tokens`).join("\n");
  return { status: run.status, answer };
}
