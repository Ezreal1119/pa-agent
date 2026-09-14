import { loadSystemPrompt } from "./system.js";
import { getPromptTemplatePaths } from "./templates.js";

export interface PromptResources {
  systemPrompt: string;
  templatePaths: string[];
}

export async function loadPromptResources(resourcesDir: string): Promise<PromptResources> {
  return {
    systemPrompt: await loadSystemPrompt(resourcesDir),
    templatePaths: getPromptTemplatePaths(resourcesDir),
  };
}

export { loadSystemPrompt } from "./system.js";
export { getPromptTemplatePaths } from "./templates.js";
