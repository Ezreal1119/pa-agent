import fs from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { config, paths } from "../config.js";
import { patrickExtension } from "../extensions/index.js";

export async function createResources(): Promise<ResourceLoader> {
  const systemPrompt = await fs.readFile(
    path.join(paths.resources, "prompts", "system.md"),
    "utf8",
  );

  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: config.agentDir,
    systemPrompt,
    extensionFactories: [{ name: "pi-patrick", factory: patrickExtension }],
    additionalPromptTemplatePaths: [path.join(paths.resources, "prompts", "templates")],
    additionalSkillPaths: [path.join(paths.resources, "skills")],
  });

  await loader.reload();
  return loader;
}

