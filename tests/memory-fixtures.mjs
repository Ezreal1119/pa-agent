import fs from "node:fs/promises";
import path from "node:path";

export const memoryFixturePath = (dataDir, name = "urovo-product-expert") =>
  name === "urovo-product-expert"
    ? path.join(dataDir, "memory", name, "MEMORY.md")
    : path.join(dataDir, name, "MEMORY.md");

export async function writeMemoryFixture(dataDir, name, text) {
  const file = memoryFixturePath(dataDir, name);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, text);
}
