import { boundedSetting } from "../web/run-gate.js";
export interface McpOptions { enabled?: boolean; apiKey?: string; waitMs?: number; taskTimeoutMs?: number; pendingLimit?: number; retainedTaskLimit?: number; }
export function mcpConfig(options: McpOptions = {}, env: Record<string, string | undefined> = process.env) {
  if (env.MCP_ENABLED !== undefined && !["true", "false", "1", "0"].includes(env.MCP_ENABLED)) throw new Error("MCP_ENABLED must be true or false.");
  const apiKey = options.apiKey ?? env.MCP_API_KEY ?? "";
  if (typeof apiKey !== "string" || apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error("MCP_API_KEY must contain only printable ASCII characters without spaces.");
  return {
    apiKey,
    enabled: options.enabled ?? ["true", "1"].includes(env.MCP_ENABLED ?? "false"),
    waitMs: boundedSetting(options.waitMs ?? env.MCP_WAIT_MS, 10000, 0, 25000, "MCP_WAIT_MS"),
    taskTimeoutMs: boundedSetting(options.taskTimeoutMs ?? env.MCP_TASK_TIMEOUT_MS, 900000, 100, 1800000, "MCP_TASK_TIMEOUT_MS"),
    pendingLimit: boundedSetting(options.pendingLimit ?? env.MCP_PENDING_LIMIT, 10, 1, 100, "MCP_PENDING_LIMIT"),
    retainedTaskLimit: boundedSetting(options.retainedTaskLimit, 5000, 1, 10000, "MCP retained task limit"),
  };
}
