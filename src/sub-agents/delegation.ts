import { Type, type Static } from "typebox";

export const delegationSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 4000, description: "Specific task. The user's question is attached automatically." }),
  background: Type.String({ maxLength: 32000, description: "Relevant background only. Resolve references from the conversation." }),
  confirmedFacts: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "Verified facts and their sources." }),
  corrections: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "User corrections, preserving exact identifiers." }),
  constraints: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "Limits on the task and its scope." }),
  unresolvedQuestions: Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 40, description: "Missing information and uncertainty." }),
}, { additionalProperties: false });

export type Delegation = Static<typeof delegationSchema>;
