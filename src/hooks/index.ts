import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const memoryPath = path.join(
  packageRoot,
  "resources/skills/urovo-product-skill/MEMORY.md",
);

/** Load product memory once for each session and inject it before the agent starts. */
export async function registerHooks(pi: ExtensionAPI): Promise<void> {
  const memory = (await fs.readFile(memoryPath, "utf8")).trim();

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n<product_memory>\n${memory}\n</product_memory>`,
  }));
}
