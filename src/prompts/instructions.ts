import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { safePath, atomic, SyncError } from "../knowledge-sync/core.js";

export function validateInstructions(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 100 ||
    input.some(
      (s) =>
        typeof s !== "string" ||
        !s.trim() ||
        s.length > 2000 ||
        /[\x00-\x1f\x7f-\x9f]/.test(s),
    )
  )
    throw new SyncError(
      "Provide at most 100 non-empty instructions, each at most 2000 characters without control characters.",
    );
  if (Buffer.byteLength(input.join("\n")) > 65536)
    throw new SyncError("Instructions exceed 64 KiB.");
  return [...input];
}
const serialize = (instructions: string[]) =>
  JSON.stringify({ version: 1, instructions });
const snapshot = (instructions: string[]) => ({
  instructions,
  revision: createHash("sha256").update(serialize(instructions)).digest("hex"),
});

/** Administrator configuration; only this fixed path is readable/writable. */
export class PromptInstructionsStore {
  readonly file: string;
  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "prompt-instructions.json");
  }
  async load() {
    await safePath(this.dataDir, "prompt-instructions.json");
    let handle;
    try {
      handle = await fs.open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return snapshot([]);
      throw e;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144)
        throw new SyncError(
          "Prompt instructions must be an ordinary file of at most 256 KiB.",
        );
      const bytes = await handle.readFile();
      if (bytes.length > 262144)
        throw new SyncError("Prompt instructions file is too large.");
      let parsed;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new SyncError(
          "Prompt instructions are damaged. Restore the configuration before running the agent.",
        );
      }
      if (
        !parsed ||
        parsed.version !== 1 ||
        Object.keys(parsed).some(
          (k) => !["version", "instructions"].includes(k),
        )
      )
        throw new SyncError("Invalid prompt instructions configuration.");
      return snapshot(validateInstructions(parsed.instructions));
    } finally {
      await handle.close();
    }
  }
  async save(input: unknown, revision: unknown) {
    const instructions = validateInstructions(input);
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision))
      throw new SyncError("A prompt revision is required.");
    await safePath(this.dataDir, "prompt-instructions.json");
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let release;
    try {
      release = await lockfile.lock(this.file, { realpath: false, retries: 0 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ELOCKED")
        throw new SyncError(
          "Prompt instructions are being saved. Retry after refreshing.",
          409,
        );
      throw e;
    }
    try {
      if ((await this.load()).revision !== revision)
        throw new SyncError(
          "Prompt instructions changed. Refresh before saving your changes.",
          409,
        );
      await atomic(this.file, serialize(instructions) + "\n");
      return snapshot(instructions);
    } finally {
      await release();
    }
  }
}
export function renderInstructions(instructions: string[]) {
  return instructions.length
    ? "## Administrator-provided instructions\n\nPay attention to the following administrator-provided instructions when responding.\n\n" +
        instructions.map((s) => `- ${s}`).join("\n")
    : "";
}
