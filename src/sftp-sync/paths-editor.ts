import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, hash, safePath, SyncError } from "../knowledge-sync/core.js";
import { parsePaths } from "./config.js";

export const MAX_PATHS_BYTES = 4 * 1048576;
export function checkPaths(text: unknown) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_PATHS_BYTES)
    throw new SyncError("The JSONL editor accepts UTF-8 text up to 4 MiB.");
  try {
    const entries = parsePaths(text, true);
    const errors = entries
      .filter((e) => e.error)
      .map((e) => ({ line: e.line, message: e.error! }));
    return {
      valid: errors.length === 0,
      count: entries.filter((e) => !e.error).length,
      errors,
    };
  } catch (error) {
    return {
      valid: false,
      count: 0,
      errors: [{ line: 0, message: (error as Error).message }],
    };
  }
}

/** Only the configured path list is addressable; callers cannot choose a file. */
export class SftpPathsEditor {
  constructor(
    readonly file: string,
    readonly stateDir: string,
  ) {}
  async read() {
    if (!this.file.endsWith(".jsonl"))
      throw new SyncError(
        "SFTP_PATHS_FILE must name a .jsonl file for editing.",
      );
    await safePath(path.dirname(this.file), path.basename(this.file));
    const stat = await fs.stat(this.file).catch((e) => {
      if (e.code === "ENOENT") return;
      throw e;
    });
    if (stat && (!stat.isFile() || stat.size > MAX_PATHS_BYTES))
      throw new SyncError(
        "The configured list must be a regular file up to 4 MiB.",
      );
    const bytes = stat ? await fs.readFile(this.file) : undefined;
    if (bytes && bytes.length > MAX_PATHS_BYTES)
      throw new SyncError("The configured list exceeds 4 MiB.");
    let text: string;
    try {
      text = bytes
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : "";
    } catch {
      throw new SyncError("The configured list is not valid UTF-8.");
    }
    return {
      file: this.file,
      text,
      revision: hash(bytes ?? "missing"),
      exists: !!bytes,
      check: checkPaths(text),
    };
  }
  // The service holds its existing cross-process import lock while saving.
  async save(text: unknown, revision: unknown) {
    const checked = checkPaths(text);
    if (!checked.valid)
      throw new SyncError(
        checked.errors
          .map((e) => `${e.line ? `Line ${e.line}: ` : ""}${e.message}`)
          .join("\n"),
      );
    const before = await this.read();
    if (revision !== before.revision)
      throw new SyncError(
        "The path list changed elsewhere. Reload paths and check your edits again.",
        409,
      );
    if (text === before.text) return before;
    if (before.exists) {
      const dir = await safePath(this.stateDir, "path-backups");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await atomic(path.join(dir, `${randomUUID()}.jsonl`), before.text);
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await atomic(this.file, text as string);
    return this.read();
  }
}
