import fs from "node:fs/promises";
import { constants, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { FILE_EXTENSIONS, OUTPUT_EXTENSIONS, type FileToolConfig } from "./config.js";

export interface ManagedFile { id: string; name: string; path: string; direction: "inputs" | "outputs"; bytes: number; sha256: string; createdAt: string; messageScoped?: boolean; }
const locks = new Map<string, Promise<unknown>>();
const activeJobs = new Set<string>();
export const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
export function safeName(input: string, direction: "inputs" | "outputs" = "inputs"): string {
  const name = input.normalize("NFC").trim();
  if (!name || name.length > 160 || /[/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === ".." || name.startsWith(".")) throw new Error("Invalid file name.");
  if (!(direction === "outputs" ? OUTPUT_EXTENSIONS : FILE_EXTENSIONS).has(path.extname(name).toLowerCase())) throw new Error("Unsupported file type.");
  return name;
}
export async function safeDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("File storage contains an unsafe directory.");
  }
}
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve(); const pending = previous.catch(() => {}).then(work); locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
export class FileStore {
  readonly root: string;
  constructor(readonly config: FileToolConfig) {
    // Resolve trusted storage ancestors (macOS /var is a system symlink), then
    // reject every symlink created beneath this fixed managed storage root.
    let ancestor = config.dataDir;
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    this.root = path.join(realpathSync(ancestor), path.relative(ancestor, config.dataDir), "files");
  }
  directory(sessionId: string): string { if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId)) throw new Error("Invalid file session."); return path.join(this.root, sessionId); }
  async list(sessionId: string): Promise<ManagedFile[]> {
    const dir = this.directory(sessionId); const manifest = path.join(dir, "manifest.json");
    try {
      await this.checkExistingDirectory(dir);
      const stat = await fs.lstat(manifest); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Invalid file manifest.");
      const value: unknown = JSON.parse(await fs.readFile(manifest, "utf8"));
      if (!Array.isArray(value) || value.some(file => !file || typeof file !== "object" || !/^[a-f0-9-]{36}$/.test(file.id) || !["inputs", "outputs"].includes(file.direction) || file.path !== `${file.direction}/${file.id}${path.extname(file.name).toLowerCase()}` || safeName(file.name, file.direction) !== file.name || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("Invalid file manifest.");
      return value as ManagedFile[];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async checkExistingDirectory(directory: string) {
    const absolute = path.resolve(directory); let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe file storage path."); }
  }
  private async writeManifest(sessionId: string, files: ManagedFile[]) {
    const directory = this.directory(sessionId); const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify(files), { flag: "wx", mode: 0o600 }); await fs.rename(temporary, path.join(directory, "manifest.json")); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async upload(sessionId: string, inputName: string, stream: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<ManagedFile> {
    const name = safeName(inputName); return serial(this.directory(sessionId), async () => {
      const files = await this.list(sessionId); if (files.length >= 200) throw new Error("Session file count limit reached.");
      const used = files.reduce((sum, file) => sum + file.bytes, await this.cacheBytes(sessionId)); const id = randomUUID();
      const relative = `inputs/${id}${path.extname(name).toLowerCase()}`; const target = path.join(this.directory(sessionId), relative);
      await safeDirectory(path.dirname(target)); const handle = await fs.open(target, "wx", 0o400); const hash = createHash("sha256"); let bytes = 0; let done = false;
      try {
        for await (const chunk of stream) { if (signal?.aborted) throw new Error("Upload cancelled."); bytes += chunk.length;
          if (bytes > this.config.maxFileBytes || used + bytes > this.config.sessionQuotaBytes) throw new Error("File size or session quota exceeded.");
          hash.update(chunk); await handle.writeFile(chunk);
        }
        if (!bytes) throw new Error("File is empty."); await handle.close();
        const file: ManagedFile = { id, name, path: relative, direction: "inputs", bytes, sha256: hash.digest("hex"), createdAt: new Date().toISOString(), messageScoped: true };
        await this.writeManifest(sessionId, [...files, file]); done = true; return file;
      } finally { await handle.close().catch(() => {}); if (!done) await fs.rm(target, { force: true }); }
    });
  }
  async open(sessionId: string, id: string) {
    const file = (await this.list(sessionId)).find(value => value.id === id); if (!file) throw new Error("File does not belong to this session.");
    const absolute = path.join(this.directory(sessionId), file.path); await this.checkExistingDirectory(path.dirname(absolute));
    const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes) { await handle.close(); throw new Error("Managed file changed unexpectedly."); }
    return { file, handle, absolute };
  }
  async resolve(sessionId: string, requested: string): Promise<{ absolute: string; display: string }> {
    const files = await this.list(sessionId);
    const matches = files.filter(file => file.path === requested || file.id === requested || path.join(this.directory(sessionId), file.path) === requested || file.name === requested);
    if (matches.length > 1) throw new Error("Filename is ambiguous; use the managed file path.");
    if (matches.length) { const opened = await this.open(sessionId, matches[0]!.id); await opened.handle.close(); return { absolute: opened.absolute, display: opened.file.path }; }
    const candidate = path.resolve(requested);
    for (const root of this.config.readRoots) {
      const actualRoot = await fs.realpath(root).catch(() => undefined); if (!actualRoot) continue;
      const actual = await fs.realpath(candidate).catch(() => undefined); if (!actual || !inside(actualRoot, actual)) continue;
      if (!FILE_EXTENSIONS.has(path.extname(actual).toLowerCase())) throw new Error("Only supported binary files may be read by file tools.");
      const stat = await fs.lstat(actual); if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.config.maxFileBytes) throw new Error("Invalid or oversized source file.");
      return { absolute: actual, display: actual };
    }
    throw new Error("File is outside the current session and allowed knowledge roots.");
  }
  async job(sessionId: string, requested: string) {
    const source = await this.resolve(sessionId, requested); const dir = path.join(this.directory(sessionId), "work", randomUUID()); await safeDirectory(dir);
    const input = path.join(dir, `input${path.extname(source.absolute).toLowerCase()}`); activeJobs.add(dir); const hash = createHash("sha256");
    try {
      const handle = await fs.open(source.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.config.maxFileBytes) throw new Error("Invalid source file.");
        const output = await fs.open(input, "wx", 0o400); const buffer = Buffer.alloc(64 * 1024); let total = 0;
        try { while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > this.config.maxFileBytes) throw new Error("Source grew beyond file limit."); const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await output.writeFile(chunk); } }
        finally { await output.close(); }
      }
      finally { await handle.close(); }
      const revision = createHash("sha256").update(hash.digest("hex")).update(path.extname(source.absolute)).update(this.config.markitdown).update(this.config.workerImage || "local").digest("hex"); const cache = path.join(this.directory(sessionId), "cache", `${revision}-md018-v1.md`);
      try { await this.checkExistingDirectory(path.dirname(cache)); const stat = await fs.lstat(cache); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 10 * 1024 * 1024) await fs.copyFile(cache, path.join(dir, "converted.md"), constants.COPYFILE_EXCL); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return { dir, input, output: path.join(dir, "result.xlsx"), display: source.display,
        cache: async () => {
          const converted = path.join(dir, "converted.md"); const stat = await fs.lstat(converted).catch(() => undefined);
          if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 10 * 1024 * 1024) return;
          await serial(this.directory(sessionId), async () => {
            await safeDirectory(path.dirname(cache)); const temporary = `${cache}.${randomUUID()}.tmp`;
            try { await fs.copyFile(converted, temporary, constants.COPYFILE_EXCL); await fs.chmod(temporary, 0o600); await fs.rename(temporary, cache); }
            finally { await fs.rm(temporary, { force: true }); }
            await this.pruneCache(sessionId);
          });
        },
        cleanup: async () => { try { await fs.rm(dir, { recursive: true, force: true }); } finally { activeJobs.delete(dir); } } };
    } catch (error) { activeJobs.delete(dir); await fs.rm(dir, { recursive: true, force: true }); throw error; }
  }
  async creationJob(sessionId: string, extension: string) {
    if (!OUTPUT_EXTENSIONS.has(extension)) throw new Error("Unsupported output type.");
    const dir = path.join(this.directory(sessionId), "work", randomUUID()); await safeDirectory(dir); activeJobs.add(dir);
    return { dir, input: path.join(dir, "no-source"), output: path.join(dir, `result${extension}`), display: "new output",
      cache: async () => {}, cleanup: async () => { try { await fs.rm(dir, { recursive: true, force: true }); } finally { activeJobs.delete(dir); } } };
  }
  async publish(sessionId: string, inputName: string, resultPath: string): Promise<ManagedFile> {
    const name = safeName(inputName, "outputs");
    return serial(this.directory(sessionId), async () => {
      const files = await this.list(sessionId); if (files.length >= 200) throw new Error("Session file count limit reached."); if (files.some(file => file.direction === "outputs" && file.name === name)) throw new Error("Output filename already exists; overwriting is not allowed.");
      const stat = await fs.lstat(resultPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > this.config.maxFileBytes || files.reduce((sum, file) => sum + file.bytes, stat.size + await this.cacheBytes(sessionId)) > this.config.sessionQuotaBytes) throw new Error("Output exceeds file or session quota.");
      const bytes = await fs.readFile(resultPath); const id = randomUUID(); const relative = `outputs/${id}${path.extname(name).toLowerCase()}`; const target = path.join(this.directory(sessionId), relative); await safeDirectory(path.dirname(target));
      await fs.copyFile(resultPath, target, constants.COPYFILE_EXCL); await fs.chmod(target, 0o400);
      const file: ManagedFile = { id, name, path: relative, direction: "outputs", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() };
      try { await this.writeManifest(sessionId, [...files, file]); return file; } catch (error) { await fs.rm(target, { force: true }); throw error; }
    });
  }
  async cleanWork(sessionId: string) { const dir = this.directory(sessionId); await this.checkExistingDirectory(dir).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); await fs.rm(path.join(dir, "work"), { recursive: true, force: true }); }
  async remove(sessionId: string) { const dir = this.directory(sessionId); try { await this.checkExistingDirectory(dir); await fs.rm(dir, { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  private async cacheEntries(sessionId: string) {
    const dir = path.join(this.directory(sessionId), "cache");
    try { await this.checkExistingDirectory(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const output = [];
    for (const entry of entries) { if (!entry.isFile() || !/^[a-f0-9]{64}-md018-v1\.md$/.test(entry.name)) continue; const file = path.join(dir, entry.name); const stat = await fs.lstat(file); if (stat.isFile() && !stat.isSymbolicLink()) output.push({ file, size: stat.size, at: stat.mtimeMs }); }
    return output.sort((a, b) => a.at - b.at);
  }
  private async cacheBytes(sessionId: string) { return (await this.cacheEntries(sessionId)).reduce((sum, entry) => sum + entry.size, 0); }
  private async pruneCache(sessionId: string, now = Date.now()) {
    const entries = await this.cacheEntries(sessionId); let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const used = (await this.list(sessionId)).reduce((sum, file) => sum + file.bytes, 0); const limit = Math.max(0, Math.min(32 * 1024 * 1024, this.config.sessionQuotaBytes - used));
    for (const entry of entries) if (bytes > limit || entry.at < now - 86400000) { await fs.unlink(entry.file); bytes -= entry.size; }
  }
  async touch(sessionId: string) { const dir = this.directory(sessionId); try { await this.checkExistingDirectory(dir); await fs.utimes(dir, new Date(), new Date()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  async cleanup(now = Date.now(), sessionState?: (sessionId: string) => Promise<"active" | "retained" | "missing">) {
    const removed: string[] = [];
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9-]{8,80}$/.test(entry.name)) continue;
      const directory = this.directory(entry.name); if (locks.has(directory) || [...activeJobs].some(job => inside(directory, job))) continue;
      await this.checkExistingDirectory(directory); const stat = await fs.lstat(directory);
      const state = await sessionState?.(entry.name);
      if (state === "active") continue;
      if (state !== "retained" && stat.mtimeMs < now - 30 * 86400000) { await this.remove(entry.name); removed.push(entry.name); continue; }
      await this.pruneCache(entry.name, now);
      const work = path.join(directory, "work"); const exists = await this.checkExistingDirectory(work).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
      const jobs = exists ? await fs.readdir(work, { withFileTypes: true }) : [];
      for (const job of jobs) { const target = path.join(work, job.name); if (!job.isDirectory() || job.isSymbolicLink() || activeJobs.has(target)) continue; const stale = await fs.lstat(target); if (stale.mtimeMs < now - 3600000) await fs.rm(target, { recursive: true }); }
    }
    return removed;
  }
}
