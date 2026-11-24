import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { delegationSchema } from "../sub-agents/delegation.js";
import type { TaskReceipt } from "../sub-agents/tasks.js";

export const WINDOWS_TOOLS_GUIDANCE = "Use ask_windows_tools_agent for PCTool and SNTool Windows utility workflows, error messages, logs, configuration and static diagnosis. When delegating a task involving an uploaded text log, pass its ID in attachment_ids so the specialist can inspect the original. Preserve exact tool name, version, symptom, error text, last successful step and relevant sanitized log excerpts when available. Present the reported file/line evidence, distinguish confirmed triggers from hypotheses, and ask for the minimum missing evidence. Use this specialist only for supported Windows tools and static diagnosis.";
export const WINDOWS_DELEGATION_TOOL = {
  name: "ask_windows_tools_agent", label: "Diagnose Windows tools",
  description: "Delegate read-only static diagnosis of the PCTool and SNTool Windows utilities. Optionally pass text attachment IDs to let the specialist examine uploaded logs directly.",
};
export const WINDOWS_FINISH_TOOL = {
  name: "finish_windows_tools_task", label: "Submit diagnosis",
  description: "Submit the diagnosis with workspace-relative file or delegated attachment references and line ranges actually read during this task.",
};

const windowsDelegationSchema = Type.Object({
  ...delegationSchema.properties,
  attachment_ids: Type.Optional(Type.Array(Type.String({pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$"}), {
    maxItems: 20, uniqueItems: true,
    description: "IDs from the conversation's uploaded plain-text attachments. The specialist can read these files directly. Use IDs from message metadata, not filenames or paths.",
  })),
}, {additionalProperties: false});
type WindowsDelegation = Static<typeof windowsDelegationSchema>;

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

export function createWindowsToolsDelegationTool(invoke?: (input: WindowsDelegation, id: string, signal?: AbortSignal) => Promise<WindowsToolsResult>) {
  return defineTool({
    ...WINDOWS_DELEGATION_TOOL, parameters: windowsDelegationSchema, promptGuidelines: [WINDOWS_TOOLS_GUIDANCE],
    async execute(id, args, signal) {
      if (!invoke) throw new Error("Windows Tools delegation is unavailable in a configuration preview.");
      const result = await invoke(args, id, signal);
      return {content: [{type: "text", text: JSON.stringify(result)}], details: {windowsToolsTask: result}};
    },
  });
}
