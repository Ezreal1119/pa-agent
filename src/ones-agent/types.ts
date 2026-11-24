import { Type } from "typebox";
import type { TokenUsage } from "../web/wecom-contacts.js";

export const delegationSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 4000, description: "Specific ONES query/analysis goal. The original user question is attached automatically." }),
  background: Type.String({ maxLength: 32000, description: "Relevant conversation background only. Resolve references such as this model/version from the conversation." }),
  confirmedFacts: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "Relevant verified facts; label their source. Do not promote guesses to facts." }),
  corrections: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "User corrections that supersede earlier assumptions, preserving exact model/version/record identifiers." }),
  constraints: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "User-specified project/customer/version/date boundaries and other restrictions." }),
  unresolvedQuestions: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "Relevant missing information and uncertainty. Do not guess." }),
}, { additionalProperties: false });
export interface Delegation { task: string; background: string; confirmedFacts: string[]; corrections: string[]; constraints: string[]; unresolvedQuestions: string[]; }
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
