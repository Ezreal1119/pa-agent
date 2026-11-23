import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ExtraMemoryStore } from "../agent/extra-memory.js";
import { memoryEntries, type MemorySnapshot } from "../memory-recall/retrieve.js";

export const MEMORY_TOOL_NAME = "memory";
export interface MemoryWriteAccess {
  hasEntry(id: string): boolean;
  revision(): string | undefined;
  updateRevision(revision: string): void;
}
interface MemoryToolOptions {
  snapshot?: () => MemorySnapshot | undefined;
  writeAccess?: MemoryWriteAccess;
  readOnly?: boolean;
}
export function createMemoryTool(dataDir: string, {snapshot, writeAccess: access, readOnly}: MemoryToolOptions = {}): ToolDefinition {
  const store = new ExtraMemoryStore(dataDir);
  const revision = Type.String({ description: "Latest extra memory Revision from the injected context or a successful memory tool result.", pattern: "^[a-f0-9]{64}$" });
  const content = Type.String({ description: "The memory body as Markdown; do not include an entry header or metadata. As a formatting preference, start body headings at ### and use #### or deeper for subheadings; avoid # and ## headings. Plain text or lists need no heading.", minLength: 1, maxLength: 64000 });
  const kind = Type.Optional(Type.String({ description: "Memory category, e.g. fact, correction, preference. Default: fact on add; preserved on edit.", pattern: "^[a-z][a-z0-9_-]{0,31}$" }));
  const id = Type.String({
    description: snapshot ? "Exact mem_… ID. Edits and deletions apply to extra memory only." : "Exact mem_… ID in the extra memory, never a skill memory ID.",
    pattern: "^mem_[a-zA-Z0-9_-]+$",
  });
  const source = Type.Union([Type.Literal("main"), Type.Literal("extra")], {description: "Source of the recalled entry. Required for get only."});
  const writeActions = [Type.Literal("add"), Type.Literal("edit"), Type.Literal("delete")];
  const action = readOnly ? Type.Literal("get") : snapshot ? Type.Union([Type.Literal("get"), ...writeActions]) : Type.Union(writeActions, { description: "Operation: add, edit, or delete." });
  const readDescription = "For action=get, pass the exact id and source from recall_memory to read one full entry from this turn's snapshot. Get has no revision requirement. Use it when an excerpt leaves a condition or conflict unresolved.";
  const writeDescription = "Only write to the fixed extra memory when the current user explicitly asks. Add takes content and optional kind. Edit takes id, content and optional kind. Delete takes id. All writes require expected_revision.";
  const legacyDescription = "Manage only the fixed extra agent memory file when the current user explicitly asks. action=add requires content (optional kind), generates ID/timestamps/unknown@email.com; action=edit requires id and content (optional kind), preserves creation metadata; action=delete requires id. Always provide expected_revision. No list/get, caller-selected path, skill-memory writes, or whole-file deletion.";
  const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
  return defineTool({
    name: MEMORY_TOOL_NAME, label: snapshot ? "业务记忆" : "管理额外记忆", executionMode: "sequential",
    description: snapshot ? (readOnly ? readDescription : `${readDescription} ${writeDescription}`) : legacyDescription,
    parameters: Type.Object({
      action,
      id: readOnly ? id : Type.Optional(id),
      ...(snapshot && {source: readOnly ? source : Type.Optional(source)}),
      ...(!readOnly && {content: Type.Optional(content), kind, expected_revision: snapshot ? Type.Optional(revision) : revision}),
    }, { additionalProperties: false }),
    execute: async (_id, args, signal) => {
      if (args.action === "get") {
        if (!args.id || (args.source !== "main" && args.source !== "extra")) throw new Error("Memory get requires an exact id and source.");
        if (args.content !== undefined || args.kind !== undefined || args.expected_revision !== undefined) throw new Error("Memory get only accepts id and source.");
        signal?.throwIfAborted();
        const current = snapshot?.();
        if (!current) throw new Error("Memory get requires a current turn with memory recall enabled.");
        const entry = memoryEntries(current, args.source).find(entry => entry.id === args.id);
        if (!entry) throw new Error("Memory ID was not found in this source. Check the id and source from recall_memory.");
        const {id, kind, updated, content} = entry;
        return { ...result({id, source: args.source, kind, updated, content}), details: {memoryRead: true, id, source: args.source} };
      }
      if (readOnly) throw new Error("Memory writes are unavailable in this session.");
      const {expected_revision, content, kind} = args;
      if (args.source !== undefined || typeof expected_revision !== "string") throw new Error("Memory writes require expected_revision and do not take source.");
      if (kind !== undefined && typeof kind !== "string") throw new Error("Memory kind must be text.");
      if (access && expected_revision !== access.revision()) throw new Error("Memory revision changed. Start a new turn to verify the latest entries before editing.");
      const change = async (input: Parameters<ExtraMemoryStore["change"]>[0]) => {
        const saved = await store.change(input, signal, Boolean(access));
        access?.updateRevision(saved.revision);
        return result(saved);
      };
      if (args.action === "add") {
        if (args.id !== undefined || typeof content !== "string") throw new Error("memory add requires content, and must not supply id.");
        return change({ action: "add", content, kind, expected_revision });
      }
      if (access && (!args.id || !access.hasEntry(args.id))) throw new Error("Use recall_memory to locate the exact extra memory entry before editing or deleting it.");
      if (args.action === "edit") {
        if (args.id === undefined || typeof content !== "string") throw new Error("memory edit requires id and content.");
        return change({ action: "edit", id: args.id, content, kind, expected_revision });
      }
      if (args.id === undefined || content !== undefined || kind !== undefined) throw new Error("memory delete requires id and must not supply content or kind.");
      return change({ action: "delete", id: args.id, expected_revision });
    },
  });
}
