import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isReasoningMode, type ReasoningMode } from "../agent/reasoning.js";
import { FILE_TOOL_NAMES, type FileToolName } from "../file-tools/config.js";
import { safeDirectory } from "../file-tools/store.js";

export interface WebAgentSettings {
  effort: ReasoningMode;
  fileTools: { enabled: boolean; tools: Record<FileToolName, boolean> };
}
export function validateAgentSettings(input: unknown): WebAgentSettings {
  const value = input as WebAgentSettings;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["effort", "fileTools"].includes(key)) || !isReasoningMode(value.effort)) throw new Error("请选择有效的全局思考强度。");
  const files = value.fileTools;
  if (!files || typeof files !== "object" || Object.keys(files).some(key => !["enabled", "tools"].includes(key)) || typeof files.enabled !== "boolean" || !files.tools || typeof files.tools !== "object" || Object.keys(files.tools).length !== FILE_TOOL_NAMES.length || FILE_TOOL_NAMES.some(name => typeof files.tools[name] !== "boolean")) throw new Error("请提供文件工具总开关和六个独立开关。");
  return { effort: value.effort, fileTools: { enabled: files.enabled, tools: Object.fromEntries(FILE_TOOL_NAMES.map(name => [name, files.tools[name]])) as Record<FileToolName, boolean> } };
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
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192)) throw new Error("Agent 设置文件必须为普通文件。");
  }
  async load(fallback: WebAgentSettings): Promise<WebAgentSettings> {
    await this.check();
    try { return validateAgentSettings(JSON.parse(await fs.readFile(this.file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(fallback); throw error; }
  }
  async save(settings: WebAgentSettings): Promise<void> {
    await safeDirectory(path.dirname(this.file)); await this.check();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(validateAgentSettings(settings), null, 2) + "\n", { mode: 0o600, flag: "wx" }); await fs.rename(temporary, this.file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
