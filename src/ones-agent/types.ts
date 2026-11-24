import { Type } from "typebox";
import type { TokenUsage } from "../web/wecom-contacts.js";

export { delegationSchema, type Delegation } from "../sub-agents/delegation.js";
export type OnesQueryStep = { id: string; name: string; state: "running" | "done" | "error" };
export type OnesProgress = (update: string | OnesQueryStep) => void;
export const finishSchema = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("needs_clarification"), Type.Literal("failed")]),
  answer: Type.String({ maxLength: 12000 }),
  sources: Type.Array(Type.Object({ id: Type.String({ maxLength: 256 }), title: Type.String({ maxLength: 512 }), url: Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }), { maxItems: 40 }),
  unknowns: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 20 }),
  questions: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 10 }),
}, { additionalProperties: false });
export interface OnesAnswer { status: "completed" | "partial" | "needs_clarification" | "failed"; answer: string; sources: { id: string; title: string; url?: string }[]; unknowns: string[]; questions: string[]; }
export interface OnesTaskResult extends Omit<OnesAnswer, "status"> {
  taskId: string;
  status: OnesAnswer["status"] | "cancelled" | "interrupted";
  elapsedMs: number;
  toolCalls: number;
  usage: TokenUsage;
}
