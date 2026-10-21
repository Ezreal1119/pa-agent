import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, hash, knowledgeLock, relative, safePath, SyncError } from "./core.js";

export const LIBRARY_MAX_EDIT_BYTES = 2 * 1024 * 1024;
const editableExtensions = new Set([".md", ".txt"]);
// systemd mounts these read-only; the inbox only changes through upload/Sync.
const readOnlyNames = /^(?:SKILL|SYNC|SYNC_PROMPT)\.md$/i;

export type LibraryEntry = {
  path: string;
  bytes: number;
  modified: string;
  editable: boolean;
  note?: string;
};

function editability(name: string, bytes: number): string | undefined {
  if (name.split("/")[0] === "newly_added")
    return "Inbox files change only through upload and Sync.";
  if (readOnlyNames.test(path.posix.basename(name)))
    return "Protected file.";
  if (!editableExtensions.has(path.posix.extname(name).toLowerCase()))
    return "Only Markdown and text files can be edited.";
  if (bytes > LIBRARY_MAX_EDIT_BYTES) return "File exceeds the 2 MiB edit limit.";
  return undefined;
}

/** Administrator browser/editor for the live product knowledge directory. */
export class KnowledgeLibrary {
  constructor(
    readonly root: string,
    readonly dataDir: string,
    private readonly busy: () => boolean,
  ) {}
  async tree(): Promise<LibraryEntry[]> {
    const entries: LibraryEntry[] = [];
    const visit = async (dir: string) => {
      const items = await fs
        .readdir(await safePath(this.root, dir), { withFileTypes: true })
        .catch((e) => {
          if (e.code === "ENOENT") return [];
          throw e;
        });
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith(".")) continue;
        const name = dir ? `${dir}/${item.name}` : item.name;
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await visit(name);
        else if (item.isFile()) {
          const stat = await fs.stat(path.join(this.root, name));
          const note = editability(name, stat.size);
          entries.push({
            path: name,
            bytes: stat.size,
            modified: stat.mtime.toISOString(),
            editable: !note,
            ...(note ? { note } : {}),
          });
        }
      }
    };
    await visit("");
    return entries;
  }
  private async file(name: string) {
    if (typeof name !== "string" || name.split("/").some((s) => s.startsWith(".")))
      throw new SyncError("Invalid library path.");
    relative(name);
    const file = await safePath(this.root, name);
    const stat = await fs.stat(file).catch((e) => {
      if (e.code === "ENOENT") throw new SyncError("File not found.", 404);
      throw e;
    });
    if (!stat.isFile()) throw new SyncError("Not a file.", 400);
    return { file, stat };
  }
  async read(name: string) {
    const { file, stat } = await this.file(name);
    const note = editability(name, stat.size);
    const textual = editableExtensions.has(path.posix.extname(name).toLowerCase());
    if (!textual || stat.size > LIBRARY_MAX_EDIT_BYTES)
      return { path: name, bytes: stat.size, editable: false, note, text: null, hash: null };
    const bytes = await fs.readFile(file);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { path: name, bytes: stat.size, editable: false, note: "File is not valid UTF-8.", text: null, hash: null };
    }
    return { path: name, bytes: stat.size, editable: !note, ...(note ? { note } : {}), text, hash: hash(bytes) };
  }
  async save(name: unknown, text: unknown, expectedHash: unknown) {
    if (typeof name !== "string" || typeof text !== "string" || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash))
      throw new SyncError("Provide path, text and the hash of the version you opened.");
    if (Buffer.byteLength(text) > LIBRARY_MAX_EDIT_BYTES)
      throw new SyncError("File exceeds the 2 MiB edit limit.", 413);
    if (this.busy())
      throw new SyncError("A maintenance task is running. Save after it finishes.", 409);
    const { file, stat } = await this.file(name);
    const note = editability(name, stat.size);
    if (note) throw new SyncError(note, 403);
    // Chat runs hold read locks; give up rather than queue indefinitely behind them.
    const release = await knowledgeLock(this.root)
      .write(AbortSignal.timeout(60000))
      .catch(() => {
        throw new SyncError("The library is in use by running answers. Try again shortly.", 503);
      });
    try {
      const before = await fs.readFile(file);
      if (hash(before) !== expectedHash)
        throw new SyncError("This file changed after you opened it. Reload and reapply your edits.", 409);
      const after = Buffer.from(text);
      if (before.equals(after)) return { path: name, hash: expectedHash, changed: false };
      const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const backup = await safePath(this.dataDir, `maintenance-backups/library-edits/${stamp}/${name}`);
      await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await fs.writeFile(backup, before, { flag: "wx", mode: 0o600 });
      await atomic(file, text);
      await fs.appendFile(
        await safePath(this.dataDir, "maintenance-backups/library-edits/edits.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), path: name, before: expectedHash, after: hash(after), backup: path.relative(this.dataDir, backup) }) + "\n",
        { mode: 0o600 },
      );
      return { path: name, hash: hash(after), changed: true, backup: path.relative(this.dataDir, backup) };
    } finally {
      release();
    }
  }
}
