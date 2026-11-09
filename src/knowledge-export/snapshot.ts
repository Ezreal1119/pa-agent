import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { knowledgeLock, safePath } from "../knowledge-sync/core.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const MAX_ENTRIES = 20000;
const MAIN_MEMORY = "memory/urovo-product-expert/MEMORY.md";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const excluded = (name: string) => name.startsWith(".") || name === "newly_added";
const markdown = (name: string) => /\.md$/i.test(name) && !/^MEMORY(?:_EXTRA)?\.md$/i.test(name);

export class ExportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type SourceFile = { path: string; bytes: number; stamp: string };
export type ExportManifest = {
  formatVersion: 1;
  version: string;
  createdAt: string;
  totalFiles: number;
  totalBytes: number;
  files: { path: string; bytes: number; sha256: string }[];
};
export type ExportSnapshot = { manifest: ExportManifest; bytes: Buffer; sha256: string; etag: string };
const unavailable = () => new ExportError(503, "Business knowledge is unavailable or contains unsafe files. Check the server data directory.");

function compress(zip: JSZip, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const stream = zip.generateInternalStream({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let finished = false;
    const cleanup = () => { finished = true; signal.removeEventListener("abort", abort); };
    const abort = () => {
      if (finished) return;
      // Pause the JSZip worker chain rather than throwing from an event callback.
      stream.pause(); chunks.length = 0; cleanup(); reject(unavailable());
    };
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", data => { if (finished) stream.pause(); else chunks.push(data); });
    stream.on("error", error => { if (!finished) { cleanup(); reject(error); } });
    stream.on("end", () => {
      if (finished) return;
      cleanup();
      try { resolve(Buffer.concat(chunks)); } catch (error) { reject(error); }
    });
    stream.resume();
  });
}

/** One process owns the knowledge directory, just as for publication and memory edits. */
export class KnowledgeSnapshots {
  private cached?: { inventory: string; snapshot: ExportSnapshot };
  private pending?: Promise<ExportSnapshot>;
  constructor(private readonly dataDir: string) {}

  get(): Promise<ExportSnapshot> {
    if (!this.pending) {
      this.pending = this.build().catch(error => {
        if (error instanceof ExportError) throw error;
        throw unavailable(); // Do not disclose absolute filesystem paths or raw OS errors.
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  private async info(relative: string): Promise<SourceFile> {
    const file = await safePath(this.dataDir, relative);
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw unavailable();
    if (stat.size > BigInt(MAX_FILE_BYTES)) throw new ExportError(413, "A business file exceeds the 32 MiB export limit.");
    return { path: relative, bytes: Number(stat.size),
      stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  }

  private async inventory(signal: AbortSignal): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    const names = new Set<string>();
    let visited = 0;
    let total = 0;
    const add = async (relative: string) => {
      const file = await this.info(relative);
      total += file.bytes;
      if (files.length >= MAX_FILES || total > MAX_TOTAL_BYTES) {
        throw new ExportError(413, "Business knowledge exceeds the 10000-file or 64 MiB export limit.");
      }
      files.push(file);
    };
    const visit = async (relative: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 32) throw unavailable();
      const directory = await safePath(this.dataDir, relative);
      if (!(await fs.lstat(directory)).isDirectory()) throw unavailable();
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (++visited > MAX_ENTRIES) throw new ExportError(413, "Business knowledge exceeds the export directory-entry limit.");
        if (excluded(item.name)) continue;
        if (!item.isDirectory() && !markdown(item.name)) continue;
        if (/[\\\x00-\x1f\x7f]/.test(item.name)) throw unavailable();
        const name = `${relative}/${item.name}`;
        const key = name.normalize("NFC").toLowerCase();
        if (names.has(key)) throw unavailable();
        names.add(key);
        if (item.isSymbolicLink()) throw unavailable();
        if (item.isDirectory()) await visit(name, depth + 1);
        else await add(name);
      }
    };
    await visit("urovo-product-expert", 0);
    const ums = await fs.lstat(path.join(this.dataDir, "ums-expert")).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (ums) await visit("ums-expert", 0);
    await add(MAIN_MEMORY);
    for (const required of ["urovo-product-expert/SKILL.md", MAIN_MEMORY, ...(ums ? ["ums-expert/SKILL.md"] : [])]) {
      if (!files.find(file => file.path === required)?.bytes) throw unavailable();
    }
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  private async read(source: SourceFile): Promise<Buffer> {
    const file = await safePath(this.dataDir, source.path);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat({ bigint: true });
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (!stat.isFile() || stat.nlink !== 1n || stamp !== source.stamp) throw unavailable();
      // Bound allocations and reads even if an out-of-process writer grows a file.
      const buffer = Buffer.alloc(source.bytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== source.bytes) throw unavailable();
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }

  private async build(): Promise<ExportSnapshot> {
    const signal = AbortSignal.timeout(30000);
    const release = await knowledgeLock(path.join(this.dataDir, "urovo-product-expert")).read(signal);
    let inventory: string;
    const contents: { path: string; bytes: Buffer }[] = [];
    try {
      const before = await this.inventory(signal);
      signal.throwIfAborted();
      inventory = sha256(JSON.stringify(before));
      if (this.cached?.inventory === inventory) return this.cached.snapshot;
      for (const file of before) {
        signal.throwIfAborted();
        contents.push({ path: file.path, bytes: await this.read(file) });
      }
      if (sha256(JSON.stringify(await this.inventory(signal))) !== inventory) {
        throw new ExportError(409, "Business knowledge changed while exporting. Retry after maintenance finishes.");
      }
      signal.throwIfAborted();
    } finally { release(); }
    // Immutable buffers are complete; compression and slow downloads do not hold up publication.
    const files = contents.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) }));
    const version = sha256(JSON.stringify(files));
    if (this.cached?.snapshot.manifest.version === version) {
      this.cached.inventory = inventory;
      return this.cached.snapshot;
    }
    const manifest: ExportManifest = { formatVersion: 1, version, createdAt: new Date().toISOString(),
      totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
    const zip = new JSZip();
    const zipOptions = { date: new Date("1980-01-01T00:00:00Z"), unixPermissions: 0o100600, createFolders: false };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2) + "\n", zipOptions);
    for (const file of contents) zip.file(file.path, file.bytes, zipOptions);
    const bytes = await compress(zip, signal);
    signal.throwIfAborted();
    const hash = sha256(bytes);
    const snapshot = { manifest, bytes, sha256: hash, etag: `"${hash}"` };
    this.cached = { inventory, snapshot };
    return snapshot;
  }
}
