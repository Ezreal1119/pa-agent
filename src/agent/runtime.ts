import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  resolveConfig,
  type AgentConfig,
  type AgentConfigOptions,
} from "../config.js";
import { agentExtension } from "../extensions/index.js";
import { loadSystemPrompt } from "../prompts/index.js";
import { capabilityGuidance, promptSkillPaths, promptTools, staticPromptSections, attachmentSection } from "../prompts/composition.js";
import { loadRunKnowledge } from "./knowledge.js";
import { SessionRetention } from "./retention.js";
import { installSessionPolicy } from "./session-policy.js";
import { isDeepSeekModel } from "./reasoning.js";
import { registerGeneratedFile } from "../file-tools/outputs.js";
import { FileTools } from "../file-tools/index.js";
import { installMessageAttachments, messageAttachments, attachmentReadInfo } from "./message-attachments.js";
import { FileStore } from "../file-tools/store.js";
import { knowledgeLock } from "../knowledge-sync/core.js";
import { guardNativeReads } from "../file-tools/read-guard.js";

// ModelRuntime uses this ID to connect the provider, model, and API key.
const PROVIDER_ID = "openai-compatible";

// Prepares a shared model environment and uses it to create independent AgentSessions.
// 1. static async create() -> returns Promise<AgentRuntime> which encapsulates the AgentConfig & ModelRuntime.
// 2. async createSession() -> returns Promise<AgentSession> which includes "SessionManager", "ResourceLoader", "Model"&"ModelRuntime"
export class AgentRuntime {
  private readonly retention: SessionRetention;
  readonly files?: FileTools;
  private fileCleanupTimer?: NodeJS.Timeout;
  // The constructor is private so callers must finish async setup through create().
  private constructor(
    // 1. Static Configuration of the Agent.
    // - Contains: rootDir, cwd, dataDir, agentDir, sessionsDir, resourcesDir, model. Normally they are:
    // rootDir: "/Users/patrickxu/pi-patrick", // The path of the whole Agent Core.
    // cwd: "/Users/patrickxu/pi-patrick", // The working directory of the Agent Core.
    // dataDir: "/Users/patrickxu/pi-patrick/.data", // The data storage directory.
    // agentDir: "/Users/patrickxu/pi-patrick/.data/agent", // The data of the SDK. No need to care normally.
    // sessionsDir: "/Users/patrickxu/pi-patrick/.data/sessions", // Where the Session history is stored.
    // resourcesDir: "/Users/patrickxu/pi-patrick/resources", // Where the resources are stored.
    // model: { baseUrl, modelId, apiKey, contextWindow, maxTokens }
    readonly config: AgentConfig, // Can be read from outside, but read-only.

    // 2. Model Configuration of the Agent.
    // ModelRuntime.create() -> to Create instance of Agent's Model Manager.
    // modelRuntime.registerProvider() -> to Register the LLM Model via Model Manager.
    // modelRuntime.setRuntimeApiKey() -> to Set API_KEY of the LLM via Model Manager.
    // createAgentSession({ modelRuntime: this.modelRuntime }) -> Need this Model Manager while creating a new AgentSession.
    private readonly modelRuntime: ModelRuntime, // Can't be read from outside, but read-only.
  ) {
    if (config.fileTools.enabled) {
      this.files = new FileTools(config.fileTools);
      this.fileCleanupTimer = setInterval(() => { void this.cleanupFiles().catch(console.error); }, 3600000);
      this.fileCleanupTimer.unref();
    }
    this.retention = new SessionRetention(config.sessionsDir, console.error, async id => { await new FileStore(config.fileTools).remove(id); });
    this.retention.start();
  }

  // Resolves configuration and initializes a ready-to-use runtime.
  static async create(options: AgentConfigOptions = {}): Promise<AgentRuntime> {
    // Combines caller options, .env values, and defaults into complete configuration.
    const config = resolveConfig(options);

    if (config.webTools.enabled && config.webTools.tools.length && !config.webTools.apiKey) throw new Error("联网工具需要 DeepSeek API Key：直连 DeepSeek 时复用 API_KEY，否则请配置 DEEPSEEK_API_KEY。");

    // Ensures the session and agent data directories exist.
    await fs.mkdir(config.sessionsDir, { recursive: true });
    await fs.mkdir(config.agentDir, { recursive: true });

    // Validate required expert resources before starting a runtime.
    await loadRunKnowledge(config.dataDir);
    await new SessionRetention(config.sessionsDir, console.error, async id => { await new FileStore(config.fileTools).remove(id); }).cleanup();

    // Creates Agent Model manager.
    const modelRuntime = await ModelRuntime.create({
      // SDK credential file; the API key set below stays in process memory.
      authPath: path.join(config.agentDir, "auth.json"),
      // Skips models.json because the model is registered below.
      modelsPath: null,
    });

    const deepseek = isDeepSeekModel(config.model);

    // Registers the OpenAI-compatible provider and its model.
    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "OpenAI Compatible",
      baseUrl: config.model.baseUrl,
      api: "openai-completions",
      authHeader: true,
      models: [
        {
          id: config.model.modelId,
          name: config.model.modelId,
          reasoning: true,
          ...(deepseek ? { thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max" } } : {}),
          input: ["text"],
          contextWindow: config.model.contextWindow,
          maxTokens: config.model.maxTokens,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: deepseek,
            ...(deepseek ? { thinkingFormat: "deepseek" as const, maxTokensField: "max_tokens" as const, requiresReasoningContentOnAssistantMessages: true } : {}),
          },
        },
      ],
    });

    // Assigns the API key from configuration to this provider.
    await modelRuntime.setRuntimeApiKey(PROVIDER_ID, config.model.apiKey);

    // The model environment is now ready and can be shared by multiple sessions.
    const runtime = new AgentRuntime(config, modelRuntime);
    try { await runtime.cleanupFiles(); return runtime; }
    catch (error) { runtime.dispose(); throw error; }
  }

  // Creates an independent session using the shared model environment.
  // Creates a new session by default when no SessionManager is provided.
  async createSession(
    sessionManager = SessionManager.create(
      this.config.cwd,
      this.config.sessionsDir,
    ),
    options: { textOnly?: boolean; userRoleStyle?: () => string | undefined } = {},
  ): Promise<AgentSession> {
    const files = options.textOnly ? undefined : this.files;
    const sessionFile = sessionManager.getSessionFile();
    if (sessionFile) {
      const relative = path.relative(this.config.sessionsDir, sessionFile);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Sessions must be stored under this runtime's sessionsDir for retention management.");
      }
    }
    const release = await this.retention.activate(sessionFile);
    release();
    await this.retention.cleanup();
    // Gets the model registered during create().
    const model = this.modelRuntime.getModel(
      PROVIDER_ID,
      this.config.model.modelId,
    );
    if (!model)
      throw new Error(`Model ${this.config.model.modelId} was not registered`);

    // Loads only the system prompt explicitly maintained by this project.
    const systemPrompt = await loadSystemPrompt(this.config.resourcesDir);

    // Keeps session behavior independent from global or project settings files.
    const settingsManager = SettingsManager.inMemory({
      // Old rounds must leave context, including their summaries.
      compaction: {
        enabled: false,
        // Leaves this many tokens available for the compaction summary and the next response.
        reserveTokens: 16_384,
        // Keeps this many tokens from the most recent conversation without summarizing them.
        keepRecentTokens: 20_000,
      },
      // Controls summaries created when navigating away from a branch of session history.
      branchSummary: {
        // Maximum token budget reserved while generating a branch summary.
        reserveTokens: 16_384,
        // Allows the SDK to generate a summary instead of skipping the summarization request.
        skipPrompt: false,
      },
      // Retries transient agent failures such as rate limits and temporary server errors.
      retry: {
        enabled: true,
        // Maximum number of automatic retries for one failed agent operation.
        maxRetries: 3,
        // Initial retry delay; later retries use exponential backoff.
        baseDelayMs: 2_000,
        provider: {
          // Maximum delay allowed between retries performed by the model provider layer.
          maxRetryDelayMs: 60_000,
        },
      },
      // Aborts a provider request after five minutes without receiving any data.
      httpIdleTimeoutMs: 300_000,
    });

    // Disables automatic resource discovery while retaining explicit resources.
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.config.cwd, // Where the Agent is working at.
      agentDir: this.config.agentDir, // Where the Agent's configuration is loaded
      settingsManager,

      noExtensions: true, // Won't check ".pi/extensions" anymore. Already manually import Extension in `extensionFactories: [{ name: "agent-core", factory: agentExtension }]`
      noSkills: true, // Won't check ".pi/skills" anymore. Imported using `additionalSkillPaths`.
      noPromptTemplates: true, // The shortcut command that represents a fixed long text. e.g., "/review". Not very useful.
      noThemes: true, // Won't check ".pi/themes" anymore.
      noContextFiles: true, // Won't check AGENTS.md anymore.

      systemPrompt, // The original main prompt. In resources/prompts/system.md
      appendSystemPrompt: capabilityGuidance(this.config, !!options.textOnly),
      extensionFactories: [{ name: "agent-core", factory: agentExtension }], // All tools, commands, and hooks are registered in this extension.
      additionalSkillPaths: await promptSkillPaths(this.config, !!options.textOnly),
    });

    // Loads the configured resources from disk.
    await resourceLoader.reload();

    let boundSession: AgentSession | undefined;
    const preparedTools = promptTools(this.config, !!options.textOnly, files, sessionManager.getSessionId(), () => {
      const message = boundSession?.messages.findLast(message => message.role === "user");
      if (!message) return undefined;
      return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("");
    }, (file, userId, toolId) => registerGeneratedFile(sessionManager, userId, toolId, file));

    // Gives the model, resources, and session manager to Agent Core to create the session.
    // Composition of the Prompts: System + User&Assistant... + Tools
    // 1. System: shared prompt composition, with fresh per-run instructions and knowledge.
    // 2. User&Assistant...: User -> Assistant(tool_calling_results + final_llm_response) -> User -> ...
    // 3. Shared tool factories also supply the administrator preview.
    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      agentDir: this.config.agentDir,
      model,
      modelRuntime: this.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      // No shell or general file mutation tools, including in resumed sessions.
      // The memory tool can only mutate memory/urovo-product-expert/MEMORY_EXTRA.md; unpublished inputs are excluded.
      tools: preparedTools.names,
      customTools: preparedTools.custom,
      // Uses the SDK's default reasoning level, clamped when the model supports less.
      thinkingLevel: "medium",
    });

    boundSession = session;
    try {
      await installSessionPolicy(session, this.config.dataDir, this.retention, {
        sections: await staticPromptSections(this.config, !!options.textOnly),
        userRoleStyle: options.textOnly ? undefined : options.userRoleStyle,
        attachments: files ? async () => {
          await files.store.touch(session.sessionId);
          const boundIds = new Set(messageAttachments(session).flatMap(record => record.files.map(file => file.id)));
          const catalog = (await files.store.list(session.sessionId)).filter(file => file.direction === "outputs" || !file.messageScoped || boundIds.has(file.id)).map(file => ({ name: file.name, path: file.path, direction: file.direction, bytes: file.bytes, ...attachmentReadInfo(file, files.store.directory(session.sessionId)) }));
          return attachmentSection(catalog);
        } : undefined,
      });
      const prompt = session.prompt.bind(session);
      const abort = session.abort.bind(session);
      let waitingOrRunning: AbortController | undefined;
      session.abort = async () => { waitingOrRunning?.abort(); await abort(); };
      session.prompt = async (text, options) => {
        if (waitingOrRunning) throw new Error("A prompt is already running in this session.");
        const controller = new AbortController(); waitingOrRunning = controller;
        let release: (() => void) | undefined;
        try {
          release = await knowledgeLock(path.join(this.config.dataDir, "urovo-product-expert")).read(controller.signal);
          controller.signal.throwIfAborted();
          return await prompt(text, options);
        } finally { release?.(); waitingOrRunning = undefined; }
      };
      if (!files && !options.textOnly) guardNativeReads(session, [], this.config.cwd, false);
      installMessageAttachments(session, files?.store.directory(session.sessionId));
      if (options.textOnly) guardNativeReads(session, [path.join(this.config.dataDir, "urovo-product-expert"), path.join(this.config.dataDir, "ums-expert"), path.join(this.config.resourcesDir, "skills")], this.config.cwd);
      if (files) {
        const sessionId = session.sessionId;
        guardNativeReads(session, [...this.config.fileTools.readRoots, files.store.directory(sessionId), path.join(this.config.resourcesDir, "skills"), path.join(this.config.resourcesDir, "file-skills")], this.config.cwd);
      }
    } catch (error) {
      session.dispose();
      throw error;
    }
    return session;
  }
  private async cleanupFiles(): Promise<void> {
    if (!this.files) return;
    const sessions = await SessionManager.list(this.config.cwd, this.config.sessionsDir);
    const byId = new Map(sessions.map(session => [session.id, session]));
    await this.files.store.cleanup(Date.now(), async id => {
      const session = byId.get(id);
      return session && this.retention.isActive(session.path) ? "active" : session ? "retained" : "missing";
    });
  }
  /** Run explicitly for maintenance; startup and hourly sweeps also run automatically. */
  async cleanupSessions(): Promise<string[]> {
    const removed = await this.retention.cleanup(); await this.cleanupFiles(); return removed;
  }

  /** Stop the housekeeping timer after disposing all sessions. */
  dispose(): void {
    this.retention.dispose();
    if (this.fileCleanupTimer) clearInterval(this.fileCleanupTimer);
  }
}

// Function-style shortcut for AgentRuntime.create().
export async function createAgentRuntime(
  options: AgentConfigOptions = {},
): Promise<AgentRuntime> {
  return AgentRuntime.create(options);
}

// Creates a runtime and one new session for simple single-session use.
export async function createAgent(
  options: AgentConfigOptions = {},
): Promise<AgentSession> {
  const runtime = await AgentRuntime.create(options);
  try {
    const session = await runtime.createSession();
    const dispose = session.dispose.bind(session);
    session.dispose = () => { dispose(); runtime.dispose(); };
    return session;
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}
