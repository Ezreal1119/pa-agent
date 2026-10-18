import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ExtraMemoryStore } from "../agent/extra-memory.js";

export const MEMORY_TOOL_NAME = "memory";
export function createMemoryTool(dataDir: string): ToolDefinition {
  const store = new ExtraMemoryStore(dataDir);
  const revision = Type.String({ description: "Latest extra memory Revision from the injected context or a successful memory tool result.", pattern: "^[a-f0-9]{64}$" });
  const content = Type.String({ description: "The memory body as Markdown; do not include an entry header or metadata. As a formatting preference, start body headings at ### and use #### or deeper for subheadings; avoid # and ## headings. Plain text or lists need no heading.", minLength: 1, maxLength: 64000 });
  const kind = Type.Optional(Type.String({ description: "Memory category, e.g. fact, correction, preference. Default: fact on add; preserved on edit.", pattern: "^[a-z][a-z0-9_-]{0,31}$" }));
  const id = Type.String({ description: "Exact mem_… ID in the extra memory, never a skill memory ID.", pattern: "^mem_[a-zA-Z0-9_-]+$" });
  const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
  return defineTool({
    name: MEMORY_TOOL_NAME, label: "管理额外记忆", executionMode: "sequential",
    description: "Manage only the fixed extra agent memory file when the current user explicitly asks. action=add requires content (optional kind), generates ID/timestamps/unknown@email.com; action=edit requires id and content (optional kind), preserves creation metadata; action=delete requires id. Always provide expected_revision. No list/get, caller-selected path, skill-memory writes, or whole-file deletion.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("delete")], { description: "Operation: add, edit, or delete." }),
      id: Type.Optional(id), content: Type.Optional(content), kind, expected_revision: revision,
    }, { additionalProperties: false }),
    execute: async (_id, args, signal) => {
      if (args.action === "add") {
        if (args.id !== undefined || args.content === undefined) throw new Error("memory add requires content, and must not supply id.");
        return result(await store.change({ action: "add", content: args.content, kind: args.kind, expected_revision: args.expected_revision }, signal));
      }
      if (args.action === "edit") {
        if (args.id === undefined || args.content === undefined) throw new Error("memory edit requires id and content.");
        return result(await store.change({ action: "edit", id: args.id, content: args.content, kind: args.kind, expected_revision: args.expected_revision }, signal));
      }
      if (args.id === undefined || args.content !== undefined || args.kind !== undefined) throw new Error("memory delete requires id and must not supply content or kind.");
      return result(await store.change({ action: "delete", id: args.id, expected_revision: args.expected_revision }, signal));
    },
  });
}
