import { hint as wecomHint, type WecomContext } from "./wecom-sources.js";
import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  applyDeepSeekReasoning,
  isDeepSeekModel,
  type ReasoningMode,
} from "../agent/reasoning.js";
import { sdkTokens } from "../web/run-metrics.js";
import { buildPlan, dependents, resolveHub } from "./validation.js";
import {
  type Decision,
  type Usage,
  type SourceMatch,
  excluded,
  hash,
  relative,
  PlanError,
  SyncError,
} from "./core.js";
/** Rejected finish_sync submissions the agent may repair before the report shows them. */
const MAX_PLAN_REPAIRS = 3;
export type ModelConfig = {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
};
export type AgentInput = {
  base: Map<string, string>;
  markdown: string;
  prompt: string;
  feedback: string;
  deletion?: boolean;
  batch: unknown;
  candidates?: Map<string, string>;
  deletions: unknown;
  timestamp: string;
  signal: AbortSignal;
  usage: Usage;
  update: () => Promise<void>;
  association?: SourceMatch;
  wecom?: WecomContext;
  validate?: (decision: Decision) => Promise<void>;
};
export type AgentResult = { decision: Decision; staged: Map<string, string> };
export type Planner = (input: AgentInput) => Promise<AgentResult>;
export function createPlanner(options: {
  model: ModelConfig;
  effort: ReasoningMode;
  resourcesDir: string;
  workDir: string;
  maxCalls: number;
  acquire: (signal: AbortSignal) => Promise<() => void>;
}): Planner {
  return async (input) => {
    const release = await options.acquire(input.signal);
    let session: AgentSession | undefined;
    let runtime: ModelRuntime | undefined;
    try {
      input.signal.throwIfAborted();
      const model = options.model;
      if (!model.apiKey || !model.baseUrl || !model.modelId)
        throw new SyncError("Configure the model in .env first.");
      await fs.mkdir(options.workDir, { recursive: true, mode: 0o700 });
      runtime = await ModelRuntime.create({
        authPath: path.join(options.workDir, "auth.json"),
        modelsPath: null,
      });
      const deep = isDeepSeekModel(model);
      runtime.registerProvider("sync-provider", {
        name: "Sync model",
        baseUrl: model.baseUrl,
        api: "openai-completions",
        authHeader: true,
        models: [
          {
            id: model.modelId,
            name: model.modelId,
            reasoning: true,
            input: ["text"],
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: deep,
              ...(deep
                ? {
                    thinkingFormat: "deepseek" as const,
                    maxTokensField: "max_tokens" as const,
                    requiresReasoningContentOnAssistantMessages: true,
                  }
                : {}),
            },
          },
        ],
      });
      await runtime.setRuntimeApiKey("sync-provider", model.apiKey);
      const staged = new Map<string, string>();
      const readRanges = new Map<string, Set<number>>();
      function read(key: string, text: string, offset = 0) {
        if (offset % 20000 !== 0)
          throw new Error("Use the supplied nextOffset.");
        const ranges = readRanges.get(key) ?? new Set<number>();
        ranges.add(offset);
        readRanges.set(key, ranges);
        return { ...slice(text, offset), hash: hash(text) };
      }
      function readFully(key: string, text: string) {
        for (let offset = 0; offset < text.length; offset += 20000)
          if (!readRanges.get(key)?.has(offset))
            throw new Error(`Read all segments before submitting: ${key}`);
      }
      let decision: Decision | undefined;
      let rejected: Decision | undefined;
      let rejections = 0;
      const deletion =
        input.deletion ?? input.prompt.startsWith("DELETE PREVIEW");
      const tool = (
        name: string,
        description: string,
        parameters: any,
        run: (args: any) => unknown,
      ): ToolDefinition =>
        defineTool({
          name,
          label: name,
          description,
          parameters,
          execute: async (_id, args) => {
            input.signal.throwIfAborted();
            if (decision) throw new Error("Plan already submitted.");
            const value = await run(args);
            return {
              content: [{ type: "text", text: JSON.stringify(value) }],
              details: {},
            };
          },
        });
      const slice = (text: string, offset = 0) => ({
        text: text.slice(offset, offset + 20000),
        offset,
        nextOffset: offset + 20000 < text.length ? offset + 20000 : null,
        totalCharacters: text.length,
      });
      const fileArgs = Type.Object({
        path: Type.String(),
        candidate: Type.Optional(Type.Boolean()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      });
      function stage(name: string, text: string) {
        if(input.association)throw new Error("Association review is read-only. Submit associate without staged pages; the backend generates additive index changes.");
        relative(name);
        if (
          excluded(name) ||
          !name.startsWith("product-knowledge-vault/") ||
          !name.endsWith(".md")
        )
          throw new Error("Only Vault pages can be staged.");
        if (name === "product-knowledge-vault/log.md")
          throw new Error(
            "The backend appends the log. Submit only logEntry in finish_sync.",
          );
        if (!text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024)
          throw new Error(
            "Candidate knowledge page must contain 1–2 MiB of text.",
          );
        const bytes = [...staged].reduce(
          (sum, [p, t]) => sum + (p === name ? 0 : Buffer.byteLength(t)),
          Buffer.byteLength(text),
        );
        if (bytes > 8 * 1024 * 1024)
          throw new Error(
            "Candidate index text exceeds 8 MiB; narrow the maintenance operation.",
          );
        staged.set(name, text);
        return { staged: name, hash: hash(text) };
      }
      const tools: ToolDefinition[] = [
        tool(
          "list_knowledge",
          "List Markdown paths with paging.",
          Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
          (a) => {
            const all = [...input.base.keys()];
            const start = a.offset ?? 0;
            return {
              paths: all.slice(start, start + 200),
              nextOffset: start + 200 < all.length ? start + 200 : null,
            };
          },
        ),
        tool(
          "read_knowledge",
          "Read the original current Markdown by default, or pass candidate=true to inspect staged text. Continue nextOffset until complete.",
          fileArgs,
          (a) => {
            relative(a.path);
            if (excluded(a.path)) throw new Error("Protected path.");
            const original = !a.candidate && input.base.has(a.path);
            const text = original ? input.base.get(a.path) : staged.get(a.path);
            if (text === undefined) throw new Error("Not found.");
            return read(
              original ? a.path : `@staged:${a.path}`,
              text,
              a.offset,
            );
          },
        ),
        tool(
          "search_knowledge",
          "Literal case-insensitive search of current Markdown; results include paths and snippets.",
          Type.Object({
            query: Type.String({ minLength: 1 }),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
          (a) => {
            const matches = [...input.base].filter(([p, t]) =>
              (p + "\n" + t).toLowerCase().includes(a.query.toLowerCase()),
            );
            const offset = a.offset ?? 0;
            return {
              matches: matches.slice(offset, offset + 30).map(([p, t]) => {
                const at = t.toLowerCase().indexOf(a.query.toLowerCase());
                return {
                  path: p,
                  snippet: t.slice(
                    Math.max(0, at - 150),
                    Math.max(0, at) + 600,
                  ),
                };
              }),
              nextOffset: offset + 30 < matches.length ? offset + 30 : null,
            };
          },
        ),
        tool(
          "read_candidate_source",
          "Read the full converted candidate in bounded segments.",
          Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
          (a) => read("@candidate", input.markdown, a.offset),
        ),
        tool(
          "read_batch_source",
          "Read another converted input in this batch before comparing competing versions.",
          Type.Object({
            id: Type.String(),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
          (a) => {
            const text = input.candidates?.get(a.id);
            if (text === undefined)
              throw new Error("No converted candidate with this ID.");
            return read(`@batch:${a.id}`, text, a.offset);
          },
        ),
        tool(
          "batch_candidates",
          "Get same-batch candidates, decisions and legacy deletion audit. Compare potential competing versions.",
          Type.Object({
            batchOffset: Type.Optional(Type.Integer({ minimum: 0 })),
            auditOffset: Type.Optional(Type.Integer({ minimum: 0 })),
            auditQuery: Type.Optional(Type.String()),
          }),
          (a) => {
            const batch = Array.isArray(input.batch) ? input.batch : [];
            const audits = (
              Array.isArray(input.deletions) ? input.deletions : []
            ).filter(
              (d) =>
                !a.auditQuery ||
                JSON.stringify(d)
                  .toLowerCase()
                  .includes(a.auditQuery.toLowerCase()),
            );
            const b = a.batchOffset ?? 0,
              d = a.auditOffset ?? 0;
            return {
              batch: batch.slice(b, b + 10),
              nextBatchOffset: b + 10 < batch.length ? b + 10 : null,
              legacyDeletions: audits.slice(d, d + 5),
              nextAuditOffset: d + 5 < audits.length ? d + 5 : null,
            };
          },
        ),
        tool(
          "source_dependents",
          "Find pages that directly cite these source paths. Indirect Hub or index citations are not listed.",
          Type.Object({ paths: Type.Array(Type.String()) }),
          (a) => ({ paths: dependents(input.base, a.paths) }),
        ),
        tool(
          "product_hubs",
          "Resolve the exact product Hub path the backend expects for each canonical product directory. Stage these Hubs; never create a duplicate Hub.",
          Type.Object({
            products: Type.Array(Type.String(), { maxItems: 50 }),
          }),
          (a) => ({
            hubs: a.products.map((product: string) => {
              const hub = resolveHub(input.base, product);
              return { product, path: hub, exists: input.base.has(hub) };
            }),
          }),
        ),
        tool(
          "write_candidate",
          "Stage complete text of an affected Vault page. Does not publish.",
          Type.Object({
            path: Type.String(),
            text: Type.String({ minLength: 1, maxLength: 2000000 }),
          }),
          (a) => stage(a.path, a.text),
        ),
        tool(
          "patch_candidate",
          "Stage exact local replacements in a Vault page. Supply the hash from read_knowledge; each before must occur exactly once. Does not publish. Log is appended by backend.",
          Type.Object({
            path: Type.String(),
            expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
            replacements: Type.Array(
              Type.Object({
                before: Type.String({ minLength: 1, maxLength: 2000000 }),
                after: Type.String({ maxLength: 2000000 }),
              }),
              { minItems: 1, maxItems: 100 },
            ),
          }),
          (a) => {
            let text = staged.get(a.path) ?? input.base.get(a.path);
            if (text === undefined || hash(text) !== a.expectedHash)
              throw new Error(
                "Candidate baseline conflict. Read the current candidate and retry.",
              );
            for (const edit of a.replacements) {
              const at = text.indexOf(edit.before);
              if (
                !edit.before ||
                at < 0 ||
                text.indexOf(edit.before, at + 1) >= 0
              )
                throw new Error(
                  "Each replacement must match exactly once; include more surrounding context.",
                );
              text =
                text.slice(0, at) +
                edit.after +
                text.slice(at + edit.before.length);
              if (Buffer.byteLength(text) > 2 * 1024 * 1024)
                throw new Error("Candidate knowledge page exceeds 2 MiB.");
            }
            return stage(a.path, text);
          },
        ),
        tool(
          "finish_sync",
          "Submit the candidate decision. No further tools after this call. Publication is performed by backend checks.",
          Type.Object({
            action: Type.Union(
              ["add", "update", "review", "delete", "associate"].map((v) => Type.Literal(v)),
            ),
            reason: Type.String(),
            summary: Type.String(),
            products: Type.Array(Type.String()),
            slot: Type.String(),
            oldPaths: Type.Array(Type.String()),
            newPath: Type.Optional(Type.String()),
            existingSource: Type.Optional(Type.String()),
            versionEvidence: Type.String(),
            authorizedException: Type.Boolean(),
            reviewedPaths: Type.Array(Type.String()),
            productHubs: Type.Optional(
              Type.Array(
                Type.Object({ product: Type.String(), path: Type.String() }),
              ),
            ),
            logEntry: Type.Optional(
              Type.String({ minLength: 1, maxLength: 16000 }),
            ),
            reviewQuestion: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
            reviewOptions: Type.Optional(Type.Array(Type.Object({
              id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,40}$" }),
              label: Type.String({ minLength: 1, maxLength: 120 }),
              description: Type.String({ minLength: 1, maxLength: 1000 }),
              instructions: Type.String({ minLength: 1, maxLength: 6000 }),
            }), { minItems: 2, maxItems: 8 })),
            suggestedFeedback: Type.Optional(
              Type.String({ minLength: 1, maxLength: 16000 }),
            ),
          }),
          async (a) => {
            if (a.suggestedFeedback || a.reviewOptions?.length) readFully("@candidate", input.markdown);
            if (a.action !== "review") {
              readFully("@candidate", input.markdown);
              for (const p of new Set([
                ...a.oldPaths,
                ...a.reviewedPaths,
                ...staged.keys(),
                ...(input.association ? [input.association.path,...a.products.map((p:string)=>resolveHub(input.base,p))] : []),
              ])) {
                if (p === "product-knowledge-vault/log.md") continue;
                const original = input.base.get(p);
                if (original !== undefined) readFully(p, original);
              }
            }
            try {
              await input.validate?.(a as Decision);
              buildPlan(
                input.base,
                staged,
                a as Decision,
                input.markdown,
                input.feedback,
                deletion,
                input.association,
                input.wecom,
              );
            } catch (error) {
              if (!(error instanceof SyncError)) throw error;
              const problems =
                error instanceof PlanError ? error.problems : [error.message];
              rejected = a as Decision;
              if (++rejections < MAX_PLAN_REPAIRS)
                return {
                  submitted: false,
                  problems,
                  repairsLeft: MAX_PLAN_REPAIRS - rejections,
                  instruction:
                    "The backend rejected this plan. Fix every listed problem with the candidate tools and call finish_sync again. Choose action=review only when a real business decision (product identity, version order, new product, conflicting facts) is required.",
                };
              decision = a as Decision;
              return { submitted: true, problems };
            }
            decision = a as Decision;
            return { submitted: true };
          },
        ),
      ];
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: options.workDir,
        agentDir: options.workDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: await fs.readFile(
          path.join(options.resourcesDir, "knowledge-sync/SYNC.md"),
          "utf8",
        ),
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: options.workDir,
        agentDir: options.workDir,
        modelRuntime: runtime,
        model: runtime.getModel("sync-provider", model.modelId)!,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(options.workDir),
        tools: tools.map((t) => t.name),
        customTools: tools,
        thinkingLevel: "medium",
      }));
      session.agent.onPayload = (payload) => {
        input.signal.throwIfAborted();
        if (++input.usage.requests > options.maxCalls)
          throw new Error("Sync text model request budget exceeded.");
        return deep ? applyDeepSeekReasoning(payload, options.effort) : payload;
      };
      const unsub = session.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          const u = sdkTokens(event.message.usage);
          if (u) {
            input.usage.input += u.input;
            input.usage.output += u.output;
            input.usage.recorded++;
          }
          void input.update().catch(() => {});
        }
      });
      const abort = () => {
        void session?.abort();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt(
          `Operation: ${input.prompt}\nShanghai publication timestamp: ${input.timestamp}\nAdministrator feedback (trusted only for this task): ${input.feedback || "(none)"}\n${input.wecom ? `VERIFIED WECOM SECTION: ${wecomHint(input.wecom)}\nUse action=add if previousSource is absent, otherwise update with exactly that oldPaths entry. The backend will maintain the managed shared index and main catalog link; do not stage those managed shared pages or create competing ones. Maintain the affected product Hubs and relevant fact pages, linking to indexPath. Never replace the complete legacy workbook or product-local accessories. Version metadata is verified evidence, never derive it from directory timestamps.\n` : ""}${input.association ? `ASSOCIATION-ONLY MODE: ${JSON.stringify(input.association)}\nThis source's bytes and existing published Markdown have been verified by the backend. Read the full candidate and existing product Hubs. Decide applicable canonical products from evidence and administrator feedback; identical bytes alone never authorize a new product. Preserve all existing products. Use action=associate, existingSource=${JSON.stringify(input.association.path)}, slot=${JSON.stringify(input.association.slot)}, products=the union of existing and approved products, oldPaths=[], and omit newPath and productHubs. Do not stage/write/patch any pages; the backend generates additive coverage links and requires administrator confirmation for changes. No source contents or versions can change in this mode. If the request could mean moving rather than sharing, or applicability is unclear, use review and ask explicitly.\n` : ""}Candidate characters: ${input.markdown.length}. Read it completely using read_candidate_source before deciding. Inspect the knowledge catalog and batch candidates. Submit using finish_sync.`,
        );
        input.signal.throwIfAborted();
      } finally {
        input.signal.removeEventListener("abort", abort);
        unsub();
      }
      decision ??= rejected;
      if (!decision)
        throw new Error(
          "Agent ended without a structured decision. Inspect configuration or Re-Sync.",
        );
      return { decision, staged };
    } finally {
      session?.dispose();
      release();
      await input.update();
    }
  };
}
