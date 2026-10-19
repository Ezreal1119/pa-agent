export const WEB_TOOL_NAMES = ["search", "fetch"] as const;
export type WebToolName = typeof WEB_TOOL_NAMES[number];
export interface WebToolOptions { enabled?: boolean; tools?: readonly WebToolName[]; apiKey?: string; }
export interface WebToolConfig { enabled: boolean; tools: WebToolName[]; apiKey: string; }
export const defaultWebToolSettings = () => ({ tools: { search: false, fetch: false } });

export function webToolConfig(options: WebToolOptions = {}, model: { apiKey: string; baseUrl: string }, env: Record<string, string | undefined> = process.env): WebToolConfig {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") throw new Error("联网工具总开关必须为布尔值。");
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.some(name => !WEB_TOOL_NAMES.includes(name)) || new Set(options.tools).size !== options.tools.length)) throw new Error("联网工具仅支持 search 和 fetch。");
  let official = false;
  try { const url = new URL(model.baseUrl); official = url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.username && !url.password; } catch { /* An unconfigured/other provider cannot supply DeepSeek credentials. */ }
  const apiKey = options.apiKey ?? env.DEEPSEEK_API_KEY ?? (official ? model.apiKey : "");
  return { enabled: options.enabled ?? false, tools: [...(options.tools ?? WEB_TOOL_NAMES)], apiKey: apiKey.trim() };
}
