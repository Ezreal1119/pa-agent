import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { delegationSchema, type Delegation } from "../sub-agents/delegation.js";
import type { TaskReceipt } from "../sub-agents/tasks.js";

export const WINDOWS_TOOLS_GUIDANCE = "Use ask_windows_tools_agent for PCTool and SNTool Windows utility workflows, error messages, logs, configuration and static diagnosis. Preserve exact tool name, version, symptom, error text, last successful step and relevant sanitized log excerpts from the conversation or attachments. Present the reported file/line evidence, distinguish confirmed triggers from hypotheses, and ask for the minimum missing evidence. Use this specialist only for supported Windows tools and static diagnosis.";
export const WINDOWS_DELEGATION_TOOL = {
  name: "ask_windows_tools_agent", label: "Diagnose Windows tools",
  description: "Delegate read-only static diagnosis of the PCTool and SNTool Windows utilities. The specialist examines versioned exports and reports evidence, limits and questions.",
};
export const WINDOWS_FINISH_TOOL = {
  name: "finish_windows_tools_task", label: "Submit diagnosis",
  description: "Submit the diagnosis with workspace-relative file and line references actually read during this task.",
};

export const windowsAnswerSchema = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("needs_clarification")]),
  answer: Type.String({ minLength: 1, maxLength: 10000 }),
  sources: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 768 }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }), { maxItems: 20 }),
  unknowns: Type.Array(Type.String({ maxLength: 1200 }), { maxItems: 12 }),
  questions: Type.Array(Type.String({ maxLength: 1200 }), { maxItems: 8 }),
}, { additionalProperties: false });
export type WindowsAnswer = Static<typeof windowsAnswerSchema>;
export type WindowsToolsResult = TaskReceipt & Omit<WindowsAnswer, "status"> & {
  status: WindowsAnswer["status"] | "failed" | "cancelled" | "interrupted";
};

export function createWindowsToolsDelegationTool(invoke?: (input: Delegation, id: string, signal?: AbortSignal) => Promise<WindowsToolsResult>) {
  return defineTool({
    ...WINDOWS_DELEGATION_TOOL, parameters: delegationSchema, promptGuidelines: [WINDOWS_TOOLS_GUIDANCE],
    async execute(id, args, signal) {
      if (!invoke) throw new Error("Windows Tools delegation is unavailable in a configuration preview.");
      const result = await invoke(args, id, signal);
      return {content: [{type: "text", text: JSON.stringify(result)}], details: {windowsToolsTask: result}};
    },
  });
}
