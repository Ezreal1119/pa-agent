import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Type } from "typebox";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import type { ModelConfig } from "../config.js";
import { applyDeepSeekReasoning, isDeepSeekModel } from "../agent/reasoning.js";
import { meterSession, usageScope } from "../usage/ledger.js";
import { scrub } from "./privacy.js";
import { ReviewKnowledge } from "./knowledge.js";
import type { ReviewRun } from "./types.js";

export interface AgentOptions {
  dataDir: string; resourcesDir: string; model: ModelConfig; run: ReviewRun; signal: AbortSignal;
  save: () => Promise<void>; knowledge: ReviewKnowledge;
}
export class ReviewAgent {
  private initialCalls: number;
  constructor(private options: AgentOptions) { this.initialCalls = options.run.modelRequests; }
  async call<T>(phase: "review" | "privacy" | "generalize" | "merge", input: unknown, schema: z.ZodType<T>): Promise<T> {
    const { dataDir, resourcesDir, model, run, signal, save, knowledge } = this.options;
    signal.throwIfAborted();
    const work = path.join(dataDir, "question-review", "runtime", randomUUID());
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    let runtime: ModelRuntime | undefined, session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let submitted = false, result: T | undefined, failed = false, calls = 0;
    let reads = 0;
    const count = (key: string) => { (run.diagnostics ??= {})[key] = (run.diagnostics?.[key] ?? 0) + 1; };
    const tool = (name: string, description: string, args: z.ZodType, execute: (a: any) => Promise<unknown>) => defineTool({
      name, label: name, description, parameters: Type.Unsafe<any>(z.toJSONSchema(args, { io: "input" })),
      execute: async (_id, raw) => {
        signal.throwIfAborted();
        if (submitted) throw new Error("Already submitted");
        count(`${phase}.tool.${name}`);
        if (name !== "submit_review" && ++reads > 4) return { content: [{ type: "text" as const, text: "Read budget used. Submit the complete review now; state limited evidence rather than searching more." }], details: {} };
        try { const value = await execute(args.parse(raw)); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }
        catch (error) {
          count(`${phase}.tool_error.${name}`);
          const issues = error instanceof z.ZodError ? error.issues.map(issue => ({ code: issue.code, path: issue.path.map(p => typeof p === "number" ? p : ["reviewed", "candidates", "category", "question", "products", "versions", "explanation", "evidence", "cases", "decisions", "index", "safe", "candidate", "groups"].includes(String(p)) ? p : "field").join(".") })) : [];
          for (const issue of issues) count(`${phase}.validation.${issue.path}.${issue.code}`);
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid or unavailable review tool input; correct the structured fields and submit. A failed read is not evidence of missing knowledge.", issues }) }], details: {}, isError: true };
        }
      },
    });
    try {
      runtime = await ModelRuntime.create({ authPath: path.join(work, "auth.json"), modelsPath: null, refreshOnCreate: false });
      const deep = isDeepSeekModel(model);
      runtime.registerProvider("question-review", { name: "Question Review", baseUrl: model.baseUrl, api: "openai-completions", authHeader: true,
        models: [{ id: model.modelId, name: model.modelId, reasoning: true, input: ["text"], contextWindow: model.contextWindow, maxTokens: Math.min(model.maxTokens, 8192),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, ...(deep ? { supportsReasoningEffort: true, thinkingFormat: "deepseek" as const, maxTokensField: "max_tokens" as const, requiresReasoningContentOnAssistantMessages: true } : {}) } }] });
      await runtime.setRuntimeApiKey("question-review", model.apiKey);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const system = await fs.readFile(path.join(resourcesDir, "question-review", phase + ".md"), "utf8");
      const loader = new DefaultResourceLoader({ cwd: work, agentDir: work, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: system });
      await loader.reload();
      const tools = [tool("submit_review", "Submit the complete structured result for this review phase; do not quote source messages.", schema, async value => { result = value; submitted = true; return { accepted: true }; })];
      if (phase === "review") tools.push(
        tool("search_review_knowledge", "Read-only, paginated search of current formal knowledge. This is not an exhaustive historical snapshot.", z.object({ query: z.string().min(1).max(120), offset: z.number().int().min(0).default(0) }).strict(), async a => knowledge.search(a.query, a.offset)),
        tool("read_review_knowledge", "Read formal knowledge only. No arbitrary paths, source conversations, inbox, edits or external network tools.", z.object({ root: z.enum(["products", "memory", "ums"]), file: z.string().max(512), offset: z.number().int().min(0).default(0) }).strict(), async a => { const v = await knowledge.read(a.root, a.file, a.offset); return { ...v, text: scrub(v.text) }; }),
      );
      ({ session } = await createAgentSession({ cwd: work, agentDir: work, modelRuntime: runtime, model: runtime.getModel("question-review", model.modelId)!, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(work), tools: tools.map(t => t.name), customTools: tools, thinkingLevel: "low" }));
      meterSession(session, dataDir, "question-review", model);
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (m, c, o) => stream(m, c, { ...o, maxRetries: 0 });
      session.agent.toolExecution = "sequential";
      session.agent.shouldStopAfterTurn = () => submitted || calls >= (phase === "review" ? 8 : 2);
      session.agent.onPayload = async payload => {
        signal.throwIfAborted();
        if (run.modelRequests - this.initialCalls >= run.settings.maxModelRequests) throw new Error("review_request_limit");
        const value = deep ? applyDeepSeekReasoning(payload, "low") : { ...(payload as Record<string, unknown>) };
        if (phase === "review" && (calls >= 3 || reads >= 4) && Array.isArray(value.tools)) value.tools = value.tools.filter((t: any) => t.function?.name === "submit_review");
        if (Buffer.byteLength(JSON.stringify(value)) + 10000 > model.contextWindow) throw new Error("review_context_limit");
        run.modelRequests++; calls++; count(`${phase}.model_requests`); await save(); return value;
      };
      session.subscribe(event => {
        if (event.type === "tool_execution_end" && event.isError && ["submit_review", "search_review_knowledge", "read_review_knowledge"].includes(event.toolName)) count(`${phase}.sdk_tool_error.${event.toolName}`);
        if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") { failed = true; count(`${phase}.model_error`); }
      });
      const abort = () => { void session?.abort(); }; signal.addEventListener("abort", abort, { once: true });
      try { await usageScope({ kind: "question-review", id: run.id }, () => session!.prompt(JSON.stringify(input))); }
      finally { signal.removeEventListener("abort", abort); }
      signal.throwIfAborted();
      if (failed || !submitted || result === undefined) throw new Error("review_model_incomplete");
      return result;
    } finally { session?.dispose(); await fs.rm(work, { recursive: true, force: true }); }
  }
}
