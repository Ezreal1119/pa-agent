import path from "node:path";
import {
  DefaultResourceLoader,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { PatrickConfig } from "../config.js";
import { patrickExtension } from "../extensions/index.js";
import { loadPromptResources } from "../prompts/index.js";

export async function createResources(config: PatrickConfig): Promise<ResourceLoader> {
  const prompts = await loadPromptResources(config.resourcesDir);

  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: config.agentDir,
    systemPrompt: prompts.systemPrompt,
    extensionFactories: [{ name: "pi-patrick", factory: patrickExtension }],
    additionalPromptTemplatePaths: prompts.templatePaths,
    additionalSkillPaths: [path.join(config.resourcesDir, "skills")],
  });

  await loader.reload();
  return loader;
}
