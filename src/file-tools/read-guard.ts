import fs from "node:fs/promises";
import path from "node:path";
import { FILE_EXTENSIONS } from "./config.js";
import { inside } from "./store.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Enabled-module boundary only; disabled sessions retain their original read behavior. */
export function guardNativeReads(session: AgentSession, roots: string[], cwd: string) {
  const transform = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (call, signal) => {
    const prior = await transform?.(call, signal); if (prior?.block) return prior;
    if (!["read", "grep", "find", "ls"].includes(call.toolCall.name)) return prior;
    try {
      const args = call.args as { path?: string };
      const requested = path.resolve(cwd, args.path ?? "."); const real = await fs.realpath(requested);
      const allowed = await Promise.all(roots.map(root => fs.realpath(root).catch(() => undefined)));
      if (!allowed.some(root => root && inside(root, real))) throw new Error("Read path is outside the current session, skills and knowledge roots.");
      if (path.basename(real).startsWith(".")) throw new Error("Hidden configuration files are not readable.");
      if (call.toolCall.name === "read" && FILE_EXTENSIONS.has(path.extname(real).toLowerCase())) throw new Error("Use the dedicated file tool for this binary document or image.");
      return prior;
    } catch (error) { return { block: true, reason: error instanceof Error ? error.message : "Read path denied." }; }
  };
}
