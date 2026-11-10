import { boundedSetting } from "../web/run-gate.js";
import type { McpOptions } from "../mcp/config.js";
export type HttpApiOptions = McpOptions;
export function httpApiConfig(options: HttpApiOptions = {}, env: Record<string, string | undefined> = process.env) {
  if (env.AGENT_API_ENABLED !== undefined && !["true", "false", "1", "0"].includes(env.AGENT_API_ENABLED)) throw new Error("AGENT_API_ENABLED must be true or false.");
  const apiKey = options.apiKey ?? env.AGENT_API_KEY ?? "";
  if (typeof apiKey !== "string" || apiKey && (apiKey.length < 32 || !/^[\x21-\x7e]+$/.test(apiKey))) throw new Error("AGENT_API_KEY must be at least 32 printable ASCII characters without spaces.");
  return {
    apiKey,
    enabled: options.enabled ?? ["true", "1"].includes(env.AGENT_API_ENABLED ?? "false"),
    waitMs: boundedSetting(options.waitMs ?? env.AGENT_API_WAIT_MS, 10000, 0, 25000, "AGENT_API_WAIT_MS"),
    taskTimeoutMs: boundedSetting(options.taskTimeoutMs ?? env.AGENT_API_TASK_TIMEOUT_MS, 900000, 100, 1800000, "AGENT_API_TASK_TIMEOUT_MS"),
    pendingLimit: boundedSetting(options.pendingLimit ?? env.AGENT_API_PENDING_LIMIT, 12, 1, 100, "AGENT_API_PENDING_LIMIT"),
    retainedTaskLimit: boundedSetting(options.retainedTaskLimit, 5000, 1, 10000, "HTTP API retained task limit"),
  };
}
