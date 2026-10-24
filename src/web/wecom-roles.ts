import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safePath } from "../knowledge-sync/core.js";
import type { Observation } from "./wecom-contacts.js";

export type WecomScope = [string, "single" | "group", string];
export function roleScope(value: unknown): WecomScope {
  if (!Array.isArray(value) || value.length !== 3 || !["single", "group"].includes(value[1]) ||
      [value[0], value[2]].some(id => typeof id !== "string" || !id || id.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(id))) {
    throw new Error("Invalid WeCom conversation scope.");
  }
  return value as WecomScope;
}
export function senderScope(sender: Observation): WecomScope {
  return roleScope([sender.botId, sender.chatType, sender.chatType === "group" ? sender.chatId : sender.userId]);
}
const validText = (text: unknown): text is string => typeof text === "string" && Boolean(text.trim()) && text.length <= 12000 && !text.includes("\0");
type Database = { version: 1; roles: Record<string, string> };

/** Backend-only writer. Preferences outlive sessions and never enter shared memory. */
export class WecomRoles {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(dataDir: string) { this.directory = path.join(dataDir, "wecom"); }
  private key(scope: WecomScope) { return createHash("sha256").update(JSON.stringify(roleScope(scope))).digest("hex"); }
  private async read(): Promise<Database> {
    const file = await safePath(this.directory, "roles.json");
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Invalid WeCom role store.");
      const data = JSON.parse(await fs.readFile(file, "utf8"));
      if (data?.version !== 1 || !data.roles || typeof data.roles !== "object" || Array.isArray(data.roles) ||
          Object.entries(data.roles).some(([id, text]) => !/^[a-f0-9]{64}$/u.test(id) || !validText(text))) throw new Error("Invalid WeCom role store; preferences were not reset.");
      return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, roles: {} }; throw error; }
  }
  async get(scope: WecomScope): Promise<string | undefined> { await this.tail; return (await this.read()).roles[this.key(scope)]; }
  set(scope: WecomScope, text: string | undefined): Promise<void> {
    const key = this.key(scope);
    if (text !== undefined && !validText(text)) return Promise.reject(new Error("Role must be nonblank text of at most 12000 characters."));
    const work = this.tail.then(async () => {
      const data = await this.read();
      if (text === undefined) delete data.roles[key]; else data.roles[key] = text;
      const bytes = JSON.stringify(data);
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error("WeCom role store is full.");
      const file = await safePath(this.directory, "roles.json");
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(tmp, "wx", 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(tmp, file);
      } finally { await fs.rm(tmp, { force: true }); }
    });
    this.tail = work.catch(() => {}); return work;
  }
}
