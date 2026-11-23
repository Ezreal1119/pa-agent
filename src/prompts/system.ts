import fs from "node:fs/promises";
import path from "node:path";

export async function loadSystemPrompt(resourcesDir: string, recallEnabled = false): Promise<string> {
  const prompt = await fs.readFile(path.join(resourcesDir, "prompts", "system.md"), "utf8");
  if (!recallEnabled) return prompt;
  return prompt
    .replace("solely on the injected extra memory file", "solely on the extra memory file")
    .replace(" No list/get memory operations are needed because the full extra memory is injected each run.", "");
}
