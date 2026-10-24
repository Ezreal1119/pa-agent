import fs from "node:fs/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { recentRounds } from "./context-window.js";
import { loadRunKnowledgeSections } from "./knowledge.js";
import { PromptInstructionsStore } from "../prompts/instructions.js";
import { composePrompt, type PromptSection } from "../prompts/composition.js";
import type { SessionRetention } from "./retention.js";

/** Enforce at the SDK boundary rather than depending on optional model tool calls. */
export async function installSessionPolicy(session: AgentSession, dataDir: string, retention: SessionRetention, promptOptions?: { sections: PromptSection[]; attachments?: () => Promise<PromptSection>; userRoleStyle?: () => string | undefined }): Promise<void> {
  type Snapshot = { knowledge: string[]; instructions: string[]; userRoleStyle?: string };
  const store = new PromptInstructionsStore(dataDir);
  const load = async (): Promise<Snapshot> => {
    const [knowledge, state] = await Promise.all([loadRunKnowledgeSections(dataDir), store.load()]);
    return { knowledge, instructions: state.instructions, userRoleStyle: promptOptions?.userRoleStyle?.() };
  };
  let snapshot: Promise<Snapshot> | undefined;
  let nextSnapshot: Promise<Snapshot> | undefined;
  let busy = false;
  let knownFile = session.sessionManager.getSessionFile();
  let persisted = knownFile ? await exists(knownFile) : false;
  const unsubscribe = session.agent.subscribe(event => {
    if (event.type === "agent_start" && nextSnapshot) {
      snapshot = nextSnapshot;
      nextSnapshot = undefined;
    }
  });
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) =>
    recentRounds(transform ? await transform(messages, signal) : messages);

  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    // Read failures stop this request before any inference. SDK extension hook errors
    // are normally swallowed, so required resources are loaded here instead.
    const state = await (snapshot ??= load());
    const composed = composePrompt(promptOptions?.sections ?? [{id:"base",title:"Base system prompt",content:context.systemPrompt ?? ""}],
      state.instructions, state.knowledge, await promptOptions?.attachments?.());
    return stream(model, { ...context, systemPrompt: composed.system + (state.userRoleStyle === undefined ? "" : `\n\n# User Role & Style\n${state.userRoleStyle}`) }, options);
  };

  const prompt = session.prompt.bind(session);
  session.prompt = async (text, options) => {
    // Includes asynchronous preflight, before the SDK marks the agent as streaming.
    if (busy || session.isStreaming) throw new Error("This session is already running. Wait for completion before the next prompt.");
    busy = true;
    let release: (() => void) | undefined;
    const file = session.sessionManager.getSessionFile();
    try {
      if (file !== knownFile) {
        knownFile = file;
        persisted = file ? await exists(file) : false;
      }
      release = await retention.activate(file);
      if (file && persisted && !await exists(file)) throw new Error("Session has been cleaned up. Start a new session.");
      // One fresh snapshot per user run, shared by all of its tool/inference steps.
      nextSnapshot = Promise.resolve(await load());
      await prompt(text, options);
    } finally {
      nextSnapshot = undefined;
      try {
        if (release && file && await exists(file)) {
          persisted = true;
          await fs.utimes(file, new Date(), new Date());
        }
      } finally {
        release?.();
        busy = false;
      }
    }
  };

  const dispose = session.dispose.bind(session);
  session.dispose = () => { unsubscribe(); dispose(); };
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
