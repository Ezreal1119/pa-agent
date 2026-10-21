import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const protectedName = (p: string) =>
  /^(?:SKILL|MEMORY|SYNC|SYNC_PROMPT)\.md$/i.test(path.basename(p));
export const excluded = (p: string) =>
  p.split(/[\\/]/).some((s) => s === "newly_added" || s.startsWith(".")) ||
  protectedName(p);
export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function relative(p: string) {
  if (
    !p ||
    p.includes("\\") ||
    p.includes("\0") ||
    path.isAbsolute(p) ||
    p.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw new SyncError("Invalid relative path.");
  return p;
}
/** Check every component, including missing write parents. Never follow a symlink. */
export async function safePath(root: string, name = ""): Promise<string> {
  const absolute = path.resolve(root);
  const target = name ? path.join(absolute, relative(name)) : absolute;
  const parts = target.split(path.sep).filter(Boolean);
  let current = path.parse(target).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    const systemAlias =
      process.platform === "darwin" &&
      ["/var", "/tmp", "/etc"].includes(current) &&
      (await fs.realpath(current).catch(() => "")) === `/private${current}`;
    if (
      (stat?.isSymbolicLink() && !systemAlias) ||
      (stat?.isFile() && stat.nlink > 1)
    )
      throw new SyncError("Linked paths are not allowed.");
  }
  return target;
}
export async function atomic(file: string, text: string) {
  await safePath(path.dirname(file), path.basename(file));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  await safePath(path.dirname(file), path.basename(file));
  return fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === "ENOENT") return fallback;
      throw e;
    });
}
export async function catalog(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(dir: string) {
    const entries = await fs
      .readdir(await safePath(root, dir), { withFileTypes: true })
      .catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
    for (const entry of entries) {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (excluded(name)) continue;
      if (entry.isSymbolicLink())
        throw new SyncError(`Linked knowledge path: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && name.endsWith(".md")) {
        const file = await safePath(root, name);
        const stat = await fs.stat(file);
        if (stat.size > 32 * 1024 * 1024)
          throw new SyncError(`Knowledge file exceeds 32 MiB: ${name}`);
        files.set(name, await fs.readFile(file, "utf8"));
      }
    }
  }
  await visit("");
  return files;
}
export function fingerprint(files: Map<string, string>) {
  return hash(
    JSON.stringify(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, t]) => [p, hash(t)]),
    ),
  );
}
export function timestamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .replace(/\D/g, "");
}

/** Writer preference prevents endless Q&A traffic from starving a publication. */
export class KnowledgeLock {
  private readers = 0;
  private writer = false;
  private fault?: Error;
  private waiters: {
    write: boolean;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  fail(error: Error) {
    this.fault = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  read(signal?: AbortSignal) {
    return this.acquire(false, signal);
  }
  write(signal?: AbortSignal) {
    return this.acquire(true, signal);
  }
  private acquire(write: boolean, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (this.fault) {
        reject(this.fault);
        return;
      }
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const waiter = {
        write,
        reject,
        resolve: (release: () => void) => {
          signal?.removeEventListener("abort", abort);
          resolve(release);
        },
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason);
        this.pump();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }
  private pump() {
    if (this.writer) return;
    while (this.waiters.length) {
      const next = this.waiters[0]!;
      if (next.write && this.readers) return;
      this.waiters.shift();
      if (next.write) this.writer = true;
      else this.readers++;
      let done = false;
      next.resolve(() => {
        if (done) return;
        done = true;
        if (next.write) this.writer = false;
        else this.readers--;
        this.pump();
      });
      if (next.write) return;
    }
  }
}
const locks = new Map<string, KnowledgeLock>();
export function knowledgeLock(root: string) {
  const key = path.resolve(root);
  let lock = locks.get(key);
  if (!lock) {
    lock = new KnowledgeLock();
    locks.set(key, lock);
  }
  return lock;
}
export type Change = {
  path: string;
  before: string | null;
  after: string | null;
};
export type Usage = {
  input: number;
  output: number;
  requests: number;
  recorded: number;
};
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  requests: 0,
  recorded: 0,
});
export type Conversion = {
  markdown: string;
  coverage: string[];
  visual: Usage;
  sourceHash: string;
  version: number;
};
export type Decision = {
  suggestedFeedback?: string;
  action: "add" | "update" | "review" | "delete";
  reason: string;
  summary: string;
  products: string[];
  slot: string;
  oldPaths: string[];
  newPath?: string;
  versionEvidence: string;
  authorizedException: boolean;
  reviewedPaths: string[];
};
export type Plan = { decision: Decision; changes: Change[]; baseline: string };
export type Item = {
  id: string;
  name: string;
  sourceHash: string;
  bytes: number;
  status: string;
  stage: string;
  feedback: string;
  previous?: string;
  started?: string;
  finished?: string;
  elapsedMs?: number;
  reason?: string;
  summary?: string;
  coverage?: string[];
  plan?: Plan;
  sourceDeleted?: boolean;
  publishedHash?: string;
  deletedSources?: { path: string; hash: string; preview: string }[];
  cleanupError?: string;
  textUsage: Usage;
  visualUsage: Usage;
  model?: string;
};
export type Job = {
  id: string;
  kind: "sync" | "delete";
  created: string;
  status: string;
  items: Item[];
  prompt?: string;
  confirmed?: boolean;
  finished?: string;
};
export const terminal = (s: string) =>
  !["queued", "running", "stopping", "waiting_to_publish"].includes(s);
