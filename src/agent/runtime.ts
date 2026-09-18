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

// ModelRuntime uses this ID to connect the provider, model, and API key.
const PROVIDER_ID = "openai-compatible";

// Prepares a shared model environment and uses it to create independent AgentSessions.
// 1. static async create() -> returns Promise<AgentRuntime> which encapsulates the AgentConfig & ModelRuntime.
// 2. async createSession() -> returns Promise<AgentSession> which includes "SessionManager", "ResourceLoader", "Model"&"ModelRuntime"
export class AgentRuntime {
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
  ) {}

  // Resolves configuration and initializes a ready-to-use runtime.
  static async create(options: AgentConfigOptions = {}): Promise<AgentRuntime> {
    // Combines caller options, .env values, and defaults into complete configuration.
    const config = resolveConfig(options);

    // Ensures the session and agent data directories exist.
    await fs.mkdir(config.sessionsDir, { recursive: true });
    await fs.mkdir(config.agentDir, { recursive: true });

    // Creates Agent Model manager.
    const modelRuntime = await ModelRuntime.create({
      // SDK credential file; the API key set below stays in process memory.
      authPath: path.join(config.agentDir, "auth.json"),
      // Skips models.json because the model is registered below.
      modelsPath: null,
    });

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
            supportsReasoningEffort: false,
          },
        },
      ],
    });

    // Assigns the API key from configuration to this provider.
    await modelRuntime.setRuntimeApiKey(PROVIDER_ID, config.model.apiKey);

    // The model environment is now ready and can be shared by multiple sessions.
    return new AgentRuntime(config, modelRuntime);
  }

  // Creates an independent session using the shared model environment.
  // Creates a new session by default when no SessionManager is provided.
  async createSession(
    sessionManager = SessionManager.create(
      this.config.cwd,
      this.config.sessionsDir,
    ),
  ): Promise<AgentSession> {
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
      // Automatically summarizes old context before the model's context window fills up.
      compaction: {
        enabled: true,
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
      appendSystemPrompt: [], // Append extra system prompts after the main system prompt, not very meaningful.
      extensionFactories: [{ name: "agent-core", factory: agentExtension }], // All tools, commands, and hooks are registered in this extension.
      additionalSkillPaths: [path.join(this.config.resourcesDir, "skills")], // The specified path of skills discovery is resources/skills
    });

    // Loads the configured resources from disk.
    await resourceLoader.reload();

    // Gives the model, resources, and session manager to Agent Core to create the session.
    // Composition of the Prompts: System + User&Assistant... + Tools
    // 1. System: systemPrompt(system.md) + appendSystemPrompt(appendSystemPrompt) + AGENTS.md(contextFile) + SKILLS_LIST + CWD
    // 2. User&Assistant...: User -> Assistant(tool_calling_results + final_llm_response) -> User -> ...
    // 3. Tools: read, bash, edit, write, ...
    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      agentDir: this.config.agentDir,
      model,
      modelRuntime: this.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      // Enables only read-only filesystem tools for product knowledge retrieval.
      tools: ["read", "grep", "find", "ls"],
      // Uses the SDK's default reasoning level, clamped when the model supports less.
      thinkingLevel: "medium",
    });

    // Returns Pi's AgentSession directly without another wrapper.
    return session;
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
  return runtime.createSession();
}
