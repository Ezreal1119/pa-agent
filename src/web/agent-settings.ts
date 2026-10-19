import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isReasoningMode, type ReasoningMode } from "../agent/reasoning.js";
import { FILE_TOOL_NAMES, type FileToolName } from "../file-tools/config.js";
import { safeDirectory } from "../file-tools/store.js";

import { defaultWebToolSettings, WEB_TOOL_NAMES, type WebToolName } from "../web-tools/config.js";

export interface WebAgentSettings {
  effort: ReasoningMode;
  libraryLinks: { enabled: boolean };
  webTools: { tools: Record<WebToolName, boolean> };
  fileTools: { tools: Record<FileToolName, boolean> };
}
/** Legacy enabled=false becomes all-off; current preferences have no master switches. */
function toolPreferences<T extends string>(input: unknown, names: readonly T[], label: string): { tools: Record<T, boolean> } {
  const value = input as { enabled?: boolean; tools?: Record<T, boolean> };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["enabled", "tools"].includes(key)) || value.enabled !== undefined && typeof value.enabled !== "boolean" || !value.tools || typeof value.tools !== "object" || Array.isArray(value.tools) || Object.keys(value.tools).length !== names.length || names.some(name => typeof value.tools![name] !== "boolean")) throw new Error(`Provide a boolean switch for every ${label} tool.`);
  return { tools: Object.fromEntries(names.map(name => [name, value.enabled !== false && value.tools![name]])) as Record<T, boolean> };
}
export function validateAgentSettings(input: unknown): WebAgentSettings {
  const value = input as WebAgentSettings;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["effort", "fileTools", "libraryLinks", "webTools"].includes(key)) || !isReasoningMode(value.effort)) throw new Error("Select a valid reasoning level.");
  const fileTools = toolPreferences(value.fileTools, FILE_TOOL_NAMES, "file");
  const links = value.libraryLinks;
  // Settings saved before the library switch existed retain their enabled behavior.
  if (links !== undefined && (!links || typeof links !== "object" || Array.isArray(links) || Object.keys(links).some(key => key !== "enabled") || typeof links.enabled !== "boolean")) throw new Error("Provide a valid library link tool switch.");
  const webTools = value.webTools === undefined ? defaultWebToolSettings() : toolPreferences(value.webTools, WEB_TOOL_NAMES, "online");
  return { effort: value.effort, webTools, libraryLinks: { enabled: links?.enabled ?? true }, fileTools };
}
export class AgentSettingsStore {
  readonly file: string;
  constructor(dataDir: string) {
    let ancestor = path.resolve(dataDir);
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    this.file = path.join(realpathSync(ancestor), path.relative(ancestor, path.resolve(dataDir)), "web-agent-settings.json");
  }
  private async check() {
    const stat = await fs.lstat(this.file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192)) throw new Error("Agent settings must be stored in a regular file.");
  }
  async load(fallback: WebAgentSettings): Promise<WebAgentSettings> {
    await this.check();
    try { return validateAgentSettings(JSON.parse(await fs.readFile(this.file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return validateAgentSettings(fallback); throw error; }
  }
  async save(settings: WebAgentSettings): Promise<void> {
    await safeDirectory(path.dirname(this.file)); await this.check();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(validateAgentSettings(settings), null, 2) + "\n", { mode: 0o600, flag: "wx" }); await fs.rename(temporary, this.file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
