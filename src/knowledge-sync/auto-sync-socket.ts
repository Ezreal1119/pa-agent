import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { safePath } from "./core.js";

export const autoSyncSocketPath = (dataDir: string) => path.join(dataDir, "knowledge-sync", "auto-sync.sock");

/** Private, owner-only dispatch. No network route, credentials, filenames,
 * decisions, deletion operations or model parameters are accepted here. */
export class AutoSyncSocket {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  private owned?: { dev: number; ino: number };
  private note?: string;
  constructor(private file: string, private trigger: () => Promise<unknown>) {}
  status() { return { available: !!this.server?.listening, ...(this.note ? { note: this.note } : {}) }; }
  async listen() {
    try {
      const directory = path.dirname(this.file);
      await safePath(directory);
      const dir = await fs.lstat(directory);
      if (!dir.isDirectory() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid()))
        throw Error("Auto-sync requires a private, owner-only knowledge-sync directory.");
      const existing = await fs.lstat(this.file).catch(e => { if (e.code !== "ENOENT") throw e; });
      if (existing) {
        if (!existing.isSocket() || existing.isSymbolicLink() || (process.getuid && existing.uid !== process.getuid()))
          throw Error("Unsafe Auto-sync socket path; inspect it before restarting.");
        const stale = await new Promise<boolean>((resolve, reject) => {
          const probe = net.createConnection(this.file);
          probe.setTimeout(1000, () => { probe.destroy(); reject(Error("Auto-sync socket is busy.")); });
          probe.on("connect", () => { probe.destroy(); resolve(false); });
          probe.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve(true) : reject(error));
        });
        if (!stale) throw Error("Another Web process owns the Auto-sync socket.");
        const current = await fs.lstat(this.file);
        if (current.dev !== existing.dev || current.ino !== existing.ino) throw Error("Auto-sync socket changed during recovery.");
        await fs.unlink(this.file);
      }
      const server = net.createServer({ allowHalfOpen: true }, socket => {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => this.sockets.delete(socket));
        socket.setTimeout(120000, () => socket.destroy());
        let input = "";
        socket.on("data", chunk => {
          input += chunk;
          if (Buffer.byteLength(input) > 1024) socket.destroy();
        });
        socket.on("end", () => {
          if (socket.destroyed) return;
          void (async () => {
            try {
              const request = JSON.parse(input);
              if (!request || Array.isArray(request) || Object.keys(request).length !== 1 || request.operation !== "run")
                throw Error("Auto-sync accepts only the fixed run operation.");
              const result = await this.trigger();
              socket.end(JSON.stringify({ ok: true, result }) + "\n");
            } catch (error) {
              // The runner supplies already-redacted errors; avoid leaking raw
              // filesystem/provider failures over this transport.
              socket.end(JSON.stringify({ ok: false, error: "Auto-sync dispatch failed. Check its status in Sync settings." }) + "\n");
            }
          })();
        });
      });
      this.server = server;
      server.listen(this.file);
      await once(server, "listening");
      await fs.chmod(this.file, 0o600);
      const stat = await fs.lstat(this.file);
      this.owned = { dev: stat.dev, ino: stat.ino };
      server.on("error", () => { this.note = "Auto-sync socket failed. Restart the Web service and inspect its journal."; });
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Auto-sync socket unavailable.";
      await this.close();
    }
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
    const stat = await fs.lstat(this.file).catch(() => undefined);
    if (stat && this.owned && stat.dev === this.owned.dev && stat.ino === this.owned.ino) await fs.unlink(this.file);
    this.owned = undefined;
  }
}

export function dispatchAutoSync(file: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let response = "";
    socket.setTimeout(120000, () => socket.destroy(Error("Auto-sync dispatch timed out. Check Sync reports before retrying.")));
    socket.on("connect", () => socket.end('{"operation":"run"}\n'));
    socket.on("data", chunk => {
      response += chunk;
      if (Buffer.byteLength(response) > 65536) socket.destroy(Error("Invalid Auto-sync response."));
    });
    socket.on("error", () => reject(Error("Auto-sync dispatch failed. Check product-expert.service and Sync settings.")));
    socket.on("end", () => {
      try {
        const result = JSON.parse(response);
        if (result.ok !== true) throw Error(result.error || "Auto-sync dispatch failed.");
        resolve(result.result);
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
  });
}
