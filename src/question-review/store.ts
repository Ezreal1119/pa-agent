import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ReviewError, publicRun, type ReviewRun } from "./types.js";

export async function safe(file: string) {
  let current = path.parse(path.resolve(file)).root;
  for (const component of path.resolve(file).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(current) && await fs.realpath(current).catch(() => "") === `/private${current}`;
    if (stat && (stat.isSymbolicLink() && !systemAlias || stat.isFile() && stat.nlink !== 1)) throw new ReviewError(400, "Linked review paths are not allowed");
  }
  return file;
}
export async function read<T>(file: string, fallback?: T): Promise<T> {
  await safe(file);
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback; throw new ReviewError(503, "Review checkpoint unreadable; original retained"); }
}
export async function write(file: string, value: unknown) {
  await safe(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    const stream = await fs.open(temp, "wx", 0o600);
    try { await stream.writeFile(JSON.stringify(value)); await stream.sync(); } finally { await stream.close(); }
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await fs.unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}
export class ReviewStore {
  readonly root: string;
  constructor(dataDir: string) { this.root = path.join(dataDir, "question-review"); }
  async init() { await safe(this.root); await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(this.root, "runs"), { recursive: true, mode: 0o700 }); }
  file(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new ReviewError(400, "Invalid review ID"); return path.join(this.root, "runs", id + ".json"); }
  async get(id: string) {
    const run = await read<ReviewRun | null>(this.file(id), null);
    if (!run) throw new ReviewError(404, "Review not found");
    if (run.version !== 1 || run.id !== id || !Array.isArray(run.questions) || !Array.isArray(run.processed) || !run.coverage) throw new ReviewError(503, "Invalid review checkpoint; original retained");
    return run;
  }
  async save(run: ReviewRun) { await write(this.file(run.id), run); }
  async all() {
    const names = await fs.readdir(path.join(this.root, "runs"));
    return Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => this.get(n.slice(0, -5))));
  }
  async list() { return (await this.all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun); }
}
