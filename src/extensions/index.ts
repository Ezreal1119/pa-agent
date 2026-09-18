import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../commands/index.js";
import { registerHooks } from "../hooks/index.js";
import { registerTools } from "../tools/index.js";

/** Thin composition layer between application modules and Pi extensions. */
export const agentExtension: ExtensionFactory = async (pi) => {
  registerTools(pi);
  registerCommands(pi);
  await registerHooks(pi);
};
