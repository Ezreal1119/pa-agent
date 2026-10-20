import path from "node:path";

export const MEMORY_SKILL = "urovo-product-expert";
export const MEMORY_DIRECTORY_PARTS = ["memory", MEMORY_SKILL];
export const mainMemoryFile = (dataDir: string, skill = MEMORY_SKILL) =>
  path.join(dataDir, "memory", skill, "MEMORY.md");
export const extraMemoryFile = (dataDir: string) =>
  path.join(dataDir, ...MEMORY_DIRECTORY_PARTS, "MEMORY_EXTRA.md");
