import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  resolvePatrickConfig,
  type PatrickConfig,
  type PatrickConfigOptions,
} from "../config.js";
import { createResources } from "./resources.js";
import { PatrickSession } from "./session.js";

const PROVIDER_ID = "patrick-openai-compatible";

export type SessionTarget =
  | { type: "new" }
  | { type: "continue-recent" }
  | { type: "open"; path: string };

export interface CreatePatrickSessionOptions {
  target?: SessionTarget;
}

export class PatrickRuntime {
  private constructor(
    readonly config: PatrickConfig,
    private readonly modelRuntime: ModelRuntime,
  ) {}

  static async create(options: PatrickConfigOptions = {}): Promise<PatrickRuntime> {
    const config = resolvePatrickConfig(options);
    await fs.mkdir(config.sessionsDir, { recursive: true });
    await fs.mkdir(config.agentDir, { recursive: true });

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(config.agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });

    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "Patrick OpenAI Compatible",
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
    await modelRuntime.setRuntimeApiKey(PROVIDER_ID, config.model.apiKey);

    return new PatrickRuntime(config, modelRuntime);
  }

  async createSession(options: CreatePatrickSessionOptions = {}): Promise<PatrickSession> {
    const target = options.target ?? { type: "new" };
    const sessionManager = this.createSessionManager(target);
    const model = this.modelRuntime.getModel(PROVIDER_ID, this.config.model.modelId);
    if (!model) throw new Error(`Model ${this.config.model.modelId} was not registered`);

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      agentDir: this.config.agentDir,
      model,
      modelRuntime: this.modelRuntime,
      resourceLoader: await createResources(this.config),
      sessionManager,
    });

    return new PatrickSession(session);
  }

  private createSessionManager(target: SessionTarget): SessionManager {
    if (target.type === "continue-recent") {
      return SessionManager.continueRecent(this.config.cwd, this.config.sessionsDir);
    }
    if (target.type === "open") {
      return SessionManager.open(target.path, this.config.sessionsDir, this.config.cwd);
    }
    return SessionManager.create(this.config.cwd, this.config.sessionsDir);
  }
}

export async function createPatrickRuntime(
  options: PatrickConfigOptions = {},
): Promise<PatrickRuntime> {
  return PatrickRuntime.create(options);
}

export async function createPatrickAgent(
  options: PatrickConfigOptions = {},
): Promise<PatrickSession> {
  const runtime = await PatrickRuntime.create(options);
  return runtime.createSession();
}
