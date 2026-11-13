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
  return { status: run.status, answer: run.id === activeId && activeText !== undefined ? activeText : answers.join("\n\n") };
}
