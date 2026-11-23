import { defineTool } from "@earendil-works/pi-coding-agent";
import type { OnesConfig } from "./config.js";
import { delegationSchema, type Delegation, type OnesTaskResult } from "./types.js";

export const ONES_GUIDANCE = "For ONES, after-sales issues, software test submissions, release history or ONES Wiki queries, call ask_ones_agent. The backend attaches the current user's original question. Use your semantic understanding to pass the specific task plus ONLY relevant background, confirmed facts, user corrections, constraints and unknowns. Preserve exact identifiers and earlier corrections; resolve references from the conversation. Do not copy the entire history/system prompt or send credentials. Empty arrays are valid when nothing is relevant. Treat the specialist's response as evidence with explicit limits: distinguish no visible result, missing permissions, partial results and service errors. Relay clarification questions when necessary. Do not invent missing findings. Only a bounded number of delegations is available per answer.";
export const ONES_DELEGATION_TOOL = {
  name: "ask_ones_agent", label: "查询 ONES", description: "Delegate ONES queries and after-sales record analysis to a specialist with its own prompt, read-only ONES tools and independent persistent context. Give a precise task and relevant context; the current question is attached automatically. Returns evidence, limitations and clarification requests. Never use this tool to write or modify ONES data.",
};
export const ONES_FINISH_TOOL = {
  name: "finish_ones_task", label: "提交 ONES 查询结果", description: "Submit the final evidence-based task result, then stop. Use needs_clarification when essential information is missing; partial when only part was verified. Sources must come from actual tool responses.",
};

export function createOnesTool(config: OnesConfig, invoke?: (args: Delegation, signal?: AbortSignal, notice?: (text: string) => void, toolCallId?: string) => Promise<OnesTaskResult>) {
  return defineTool({
    ...ONES_DELEGATION_TOOL,
    promptGuidelines: [ONES_GUIDANCE], parameters: delegationSchema,
    execute: async (_id, args, signal, update) => {
      if (!invoke) throw new Error("ONES Agent execution is unavailable in a configuration preview.");
      if (JSON.stringify(args).length > config.maxContextChars) throw new Error(`ONES 任务背景超过 ${config.maxContextChars} 字符，请精简相关背景后重试。`);
      const result = await invoke(args, signal, text => update?.({content: [{type: "text", text}], details: {onesNotice: text}}), _id);
      return {content: [{type: "text", text: JSON.stringify(result)}], details: {onesTask: result}};
    },
  });
}
