import fs from "node:fs";
import path from "node:path";
import type { ModelConfig } from "../config.js";
import { chatCompactionConfig, type ChatCompactionConfig } from "../agent/compaction-config.js";

export const ONES_READ_TOOLS = [
  "get_issue_activities", "get_issue_code_info", "get_issue_human_readable_keys", "get_issue_details",
  "get_issue_executable_workflows", "get_issue_fields", "get_issue_status", "get_issue_type_hierarchy_configs",
  "get_list_of_issue_comments", "get_onesql_grammar_help", "query_issues_by_onesql", "search_for_issue_field_options",
  "search_for_issue_types", "get_project_details_by_project_id", "get_sprint_details", "search_for_epics",
  "search_for_modules", "search_for_projects", "search_for_releases", "search_for_sprints",
  "get_testcase_details", "get_testcase_library_fields", "search_for_modules_in_testcase_library",
  "search_for_testcases_in_library", "search_for_testcase_libraries", "search_for_users", "who_am_i", "get_user_notices",
  "get_space_details", "get_list_of_space_pages", "search_pages_by_title", "search_for_spaces", "get_page_details",
  "get_page_changes", "get_favorite_or_watch_pages", "get_manhour_mode", "get_manhour_list_in_simple_mode",
  "get_manhour_list_in_summary_mode", "read_attachment_content",
] as const;
export interface OnesSettings {
  tools: string[];
  timeoutMs: number;
  maxModelRequests: number;
  maxToolCalls: number;
  maxDelegations: number;
  maxContextChars: number;
  maxResultBytes: number;
  concurrency: number;
  queueLimit: number;
  compaction: ChatCompactionConfig;
}
export interface OnesOptions { enabled?: boolean; url?: string; token?: string; settings?: Partial<Omit<OnesSettings, "compaction">> & { compaction?: Partial<ChatCompactionConfig> }; }
export interface OnesConfig extends OnesSettings { enabled: boolean; url: string; token: string; prompt: string; }
const defaults: OnesSettings = {
  tools: [...ONES_READ_TOOLS], timeoutMs: 180000, maxModelRequests: 24, maxToolCalls: 48,
  maxDelegations: 3, maxContextChars: 32000, maxResultBytes: 1024 * 1024, concurrency: 2, queueLimit: 8,
  compaction: { enabled: true, triggerTokens: 384000, keepRecentRounds: 5 },
};
function onesSettings(input: unknown, options: OnesOptions): OnesSettings {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaults, k))) throw new Error("Invalid ONES Agent config fields.");
  const file = input as NonNullable<OnesOptions["settings"]>;
  for (const value of [file.compaction, options.settings?.compaction]) {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(defaults.compaction, k)))) throw new Error("Invalid ONES compaction fields.");
  }
  if (options.settings && Object.keys(options.settings).some(k => !Object.hasOwn(defaults, k))) throw new Error("Invalid ONES Agent option fields.");
  const settings = { ...defaults, ...file, ...options.settings };
  for (const name of ["timeoutMs", "maxModelRequests", "maxToolCalls", "maxDelegations", "maxContextChars", "maxResultBytes", "concurrency", "queueLimit"] as const) {
    const n = settings[name];
    if (!Number.isSafeInteger(n) || n < (name === "queueLimit" ? 0 : 1) || n > ({concurrency: 8, queueLimit: 100, timeoutMs: 900000, maxContextChars: 128000, maxResultBytes: 4 * 1024 * 1024}[name as string] ?? 1000)) throw new Error(`Invalid ONES Agent ${name}.`);
  }
  if (!Array.isArray(settings.tools) || !settings.tools.length || settings.tools.some((t: unknown) => typeof t !== "string" || !ONES_READ_TOOLS.includes(t as typeof ONES_READ_TOOLS[number])) || new Set(settings.tools).size !== settings.tools.length) throw new Error("ONES Agent tools must be a unique allowlist of supported read-only tools.");
  const compaction = chatCompactionConfig({ ...defaults.compaction, ...file.compaction, ...options.settings?.compaction }, {});
  return { ...settings, tools: [...settings.tools], compaction };
}

/** The saved profile is available for inspection while the specialist is disabled. */
export function onesProfile(resourcesDir: string, options: OnesOptions = {}): OnesSettings & { prompt: string } {
  const directory = path.join(resourcesDir, "agents/ones");
  const settings = onesSettings(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")), options);
  const prompt = fs.readFileSync(path.join(directory, "system.md"), "utf8");
  if (!prompt.trim()) throw new Error("ONES Agent prompt is empty.");
  return { ...settings, prompt };
}

export function onesConnection(options: OnesOptions = {}, env = process.env) {
  const url = options.url ?? env.ONES_MCP_URL ?? "https://ones.urovo.com:8881/mcp";
  return { url, token: options.token ?? env.ONES_MCP_TOKEN ?? "" };
}

export function validateOnesActivation(settings: OnesSettings, model: ModelConfig, connection: ReturnType<typeof onesConnection>) {
  if (!connection.token.trim() || /[\r\n]/.test(connection.token)) throw new Error("Set a valid ONES_MCP_TOKEN in .env and restart the service.");
  let parsed: URL;
  try { parsed = new URL(connection.url); } catch { throw new Error("Set a valid ONES_MCP_URL in .env and restart the service."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) throw new Error("ONES MCP requires HTTPS without URL credentials, query or fragment.");
  if (!settings.compaction.enabled) throw new Error("ONES Agent requires compaction; configure its independent threshold instead of disabling it.");
  if (settings.compaction.triggerTokens >= model.contextWindow - model.maxTokens - 16384) throw new Error("The ONES compaction threshold must be below CONTEXT_WINDOW - MAX_TOKENS - 16384.");
}

/** Files and explicit options share the same validation; secrets never belong in these files. */
export function onesConfig(resourcesDir: string, model: ModelConfig, options: OnesOptions = {}, env = process.env): OnesConfig {
  const enabled = options.enabled ?? false;
  const connection = onesConnection(options, env);
  const profile = enabled ? onesProfile(resourcesDir, options) : { ...onesSettings({}, options), prompt: "" };
  if (enabled) validateOnesActivation(profile, model, connection);
  return { ...profile, ...connection, enabled };
}
