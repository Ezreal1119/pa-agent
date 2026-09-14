import fs from "node:fs/promises";
import path from "node:path";

export async function loadSystemPrompt(resourcesDir: string): Promise<string> {
  return fs.readFile(path.join(resourcesDir, "prompts", "system.md"), "utf8");
}
