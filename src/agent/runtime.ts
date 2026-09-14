import fs from "node:fs/promises";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { config, paths } from "../config.js";
import { userFacingError } from "../utils/index.js";
import { createResources } from "./resources.js";
import { type AppEvent, type SessionState } from "./events.js";
import { PatrickSession, type AppEventListener } from "./session.js";

export class PatrickRuntime {
  private current?: PatrickSession;
  private modelRuntime?: ModelRuntime;
  private initializing?: Promise<PatrickSession>;
  private readonly listeners = new Set<AppEventListener>();

  async initialize(): Promise<PatrickSession> {
    if (this.current) return this.current;
    if (this.initializing) return this.initializing;

    this.initializing = this.createSession(true);
    try {
      this.current = await this.initializing;
      return this.current;
    } finally {
      this.initializing = undefined;
    }
  }

  subscribe(listener: AppEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<SessionState> {
    return (await this.initialize()).getState();
  }

  async prompt(text: string): Promise<void> {
    const session = await this.initialize();
    await session.prompt(text);
  }

  async abort(): Promise<void> {
    if (this.current) await this.current.abort();
  }

  async newSession(): Promise<SessionState> {
    this.current?.dispose();
    this.current = await this.createSession(false);
    const state = this.current.getState();
    this.emit({ type: "state", state });
    return state;
  }

  private async createSession(
    continueRecent: boolean,
  ): Promise<PatrickSession> {
    // To create file storage path if not exists
    await fs.mkdir(paths.sessions, { recursive: true });

    this.modelRuntime ??= await ModelRuntime.create();

    const sessionManager = continueRecent
      ? SessionManager.continueRecent(config.cwd, paths.sessions)
      : SessionManager.create(config.cwd, paths.sessions);

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      modelRuntime: this.modelRuntime,
      resourceLoader: await createResources(),
      sessionManager,
    });

    const wrapped = new PatrickSession(session);
    wrapped.subscribe((event) => this.emit(event));

    if (modelFallbackMessage) {
      this.emit({
        type: "error",
        message: userFacingError(modelFallbackMessage),
      });
    }

    return wrapped;
  }

  private emit(event: AppEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  emitError(error: unknown): void {
    this.emit({ type: "error", message: userFacingError(error) });
  }
}
