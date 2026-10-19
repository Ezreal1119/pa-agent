import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { createMemoryTool, MEMORY_TOOL_NAME } from "./memory.js";

export { createLibraryLinkTool, LIBRARY_LINK_TOOL_NAME } from "./library-link.js";

export { createWebTools } from "../web-tools/tools.js";

/** Register agent tools here. */
export function registerTools(_pi: ExtensionAPI): void {}
