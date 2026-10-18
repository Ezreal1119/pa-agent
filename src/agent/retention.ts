import fs from "node:fs/promises";
import path from "node:path";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Shared across runtimes within this process. One service process owns a sessions directory.
const runningFiles = new Set<string>();

/** Only SDK JSONL files inside this runtime's sessions directory are eligible. */
export class SessionRetention {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<string[]>;
  constructor(readonly sessionsDir: string, private readonly onError: (error: unknown) => void = console.error, private readonly onExpire?: (sessionId: string) => Promise<void>) {}

  isActive(file: string): boolean { return runningFiles.has(path.resolve(file)); }

  start(): void {
    this.timer ??= setInterval(() => { void this.cleanup().catch(this.onError); }, 60 * 60 * 1000);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async activate(file: string | undefined): Promise<() => void> {
    if (!file) return () => {};
    const resolved = path.resolve(file);
    if (runningFiles.has(resolved)) throw new Error("This session is already running.");
    runningFiles.add(resolved);
    try {
      const stat = await fs.lstat(resolved).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("Session must be a regular file.");
      if (stat && stat.mtimeMs < Date.now() - RETENTION_MS) throw new Error("Session has expired after 30 days of inactivity. Start a new session.");
      if (stat) await fs.utimes(resolved, new Date(), new Date());
    } catch (error) {
      runningFiles.delete(resolved);
      throw error;
    }
    return () => { runningFiles.delete(resolved); };
  }

  cleanup(now = Date.now()): Promise<string[]> {
    if (this.pending) return this.pending;
    this.pending = this.sweep(now).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async sweep(now: number): Promise<string[]> {
    const deleted: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await visit(file); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl") || runningFiles.has(file)) continue;
        const handle = await fs.open(file, "r").catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!handle) continue;
        let eligible = false; let sessionId: string | undefined;
        let identity: Awaited<ReturnType<typeof handle.stat>>;
        try {
          identity = await handle.stat();
          if (identity.mtimeMs >= now - RETENTION_MS) continue;
          const buffer = Buffer.alloc(8192);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
          try {
            const header = JSON.parse(firstLine);
            eligible = header.type === "session" && typeof header.id === "string";
            if (eligible && /^[a-zA-Z0-9-]{8,80}$/.test(header.id)) sessionId = header.id;
          } catch { /* An unknown file is never a deletion target. */ }
        } finally { await handle.close(); }
        if (!eligible || runningFiles.has(file)) continue;
        const current = await fs.lstat(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!current || current.isSymbolicLink() || current.ino !== identity!.ino || current.mtimeMs !== identity!.mtimeMs || runningFiles.has(file)) continue;
        // Hold the shared lock across async attachment removal so a new prompt
        // cannot start between the last activity check and deletion.
        runningFiles.add(file);
        try {
          // If attachment removal fails, keep the log so maintenance can retry.
          if (sessionId) await this.onExpire?.(sessionId);
          await fs.unlink(file);
          deleted.push(file);
        } finally { runningFiles.delete(file); }
      }
    };
    await visit(path.resolve(this.sessionsDir));
    return deleted;
  }
}
