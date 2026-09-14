import path from "node:path";

export function getPromptTemplatePaths(resourcesDir: string): string[] {
  return [path.join(resourcesDir, "prompts", "templates")];
}
