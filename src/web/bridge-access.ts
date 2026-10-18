import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const hash = (text: string) => createHash("sha256").update(text).digest();

/** Dedicated credential and durable ownership; never grants access to browser sessions/settings. */
export class BridgeAccess {
  private sessions = new Set<string>();
  private writes = Promise.resolve();
  private readonly file: string;
  constructor(dataDir: string, private readonly token: string) {
    this.file = path.join(dataDir, "wecom", "api-sessions.json");
    if (token && token.length < 32) throw new Error("WECOM_API_TOKEN must contain at least 32 characters.");
  }
  async load() {
    if (!this.token) return;
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !/^[\w-]{8,80}$/.test(id))) throw new Error("Invalid WeCom session registry.");
      this.sessions = new Set(value);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  authenticated(header: string | undefined) {
    return Boolean(this.token && header?.startsWith("Bearer ") && timingSafeEqual(hash(header.slice(7)), hash(this.token)));
  }
  owns(id: string) { return this.sessions.has(id); }
  async register(id: string) { this.sessions.add(id); await this.save(); }
  async remove(id: string) { if (this.sessions.delete(id)) await this.save(); }
  private save() {
    const work = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tmp, JSON.stringify([...this.sessions]), { mode: 0o600, flag: "wx" }); await fs.rename(tmp, this.file); }
      finally { await fs.rm(tmp, { force: true }); }
    });
    this.writes = work.catch(() => {});
    return work;
  }
}
