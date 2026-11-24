import fs from "node:fs";
import path from "node:path";

export const WINDOWS_READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const windowsWorkspace = (dataDir: string) => path.join(dataDir, "windows-tools", "workspace");
export function windowsToolsPrompt(resourcesDir: string) {
  const prompt = fs.readFileSync(path.join(resourcesDir, "agents/windows-tools/system.md"), "utf8");
  if (!prompt.trim()) throw new Error("The Windows Tools system prompt is empty.");
  return prompt;
}

export function readyWindowsWorkspace(workspace: string) {
  const root = fs.realpathSync(workspace);
  const parent = fs.realpathSync(path.dirname(path.dirname(workspace)));
  if (root !== path.join(parent, "windows-tools", "workspace") || !fs.statSync(root).isDirectory()) throw new Error("Invalid workspace directory.");
  for (const tool of ["PCTool", "SNTool"]) {
    const readme = path.join(root, tool, "README.md");
    if (fs.realpathSync(readme) !== readme || !fs.statSync(readme).isFile()) throw new Error("Missing snapshot README.");
    fs.accessSync(readme, fs.constants.R_OK);
  }
  return root;
}

export function windowsToolsConfig(resourcesDir: string, dataDir: string, enabled = false) {
  return {
    enabled, workspace: windowsWorkspace(dataDir),
    prompt: enabled ? windowsToolsPrompt(resourcesDir) : "",
    timeoutMs: 120000, concurrency: 2, queueLimit: 8,
    maxModelRequests: 15, maxToolCalls: 30, maxDelegations: 2, maxContextChars: 32000,
  };
}
