import net from "node:net";
import fs from "node:fs/promises";
import { safe } from "./store.js";
import { ReviewError } from "./types.js";

export class ReviewSocket {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  private owned?: { ino: number; dev: number };
  constructor(readonly file: string, private dispatch: (input: unknown) => Promise<unknown>) {}
  async listen() {
    await safe(this.file);
    const existing = await fs.lstat(this.file).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
    if (existing) {
      if (!existing.isSocket() || process.getuid && existing.uid !== process.getuid()) throw new Error("Unsafe review socket");
      const busy = await new Promise<boolean>((resolve, reject) => {
        const probe = net.createConnection(this.file); probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Review socket probe timed out")); });
        probe.on("connect", () => { probe.destroy(); resolve(true); }); probe.on("error", (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED" ? resolve(false) : reject(e));
      });
      if (busy) throw new Error("Review socket already active");
      const stat = await fs.lstat(this.file); if (stat.ino !== existing.ino || stat.dev !== existing.dev) throw new Error("Review socket changed");
      await fs.unlink(this.file);
    }
    this.server = net.createServer({ allowHalfOpen: true }, socket => {
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); socket.on("error", () => {});
      socket.setTimeout(30000, () => socket.destroy()); let body = "";
      socket.on("data", part => { body += part; if (Buffer.byteLength(body) > 16384) socket.destroy(); });
      socket.on("end", () => { if (!socket.destroyed) void (async () => {
        try { socket.end(JSON.stringify({ ok: true, value: await this.dispatch(JSON.parse(body)) })); }
        catch (e) { socket.end(JSON.stringify({ ok: false, status: e instanceof ReviewError ? e.status : 500, error: "Question review request was not completed; check arguments, availability and limits." })); }
      })(); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.file, () => { this.server!.removeListener("error", reject); resolve(); }); });
    await fs.chmod(this.file, 0o600);
    const stat = await fs.lstat(this.file); this.owned = { ino: stat.ino, dev: stat.dev };
  }
  async close() {
    this.sockets.forEach(s => s.destroy());
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.owned) {
      const stat = await fs.lstat(this.file).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
      if (stat?.isSocket() && stat.ino === this.owned.ino && stat.dev === this.owned.dev) await fs.unlink(this.file);
    }
  }
}
export async function requestReview(file: string, input: unknown) {
  await safe(file);
  const stat = await fs.stat(file);
  if (!stat.isSocket() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new ReviewError(403, "Unsafe review socket permissions");
  return new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(file); let body = "";
    socket.setTimeout(30000, () => socket.destroy(new Error("Review control timeout")));
    socket.on("connect", () => socket.end(JSON.stringify(input))); socket.on("error", reject);
    socket.on("data", part => { body += part; if (Buffer.byteLength(body) > 16 * 1024 * 1024) socket.destroy(new Error("Review response exceeds limit")); });
    socket.on("end", () => { try { const response = JSON.parse(body); if (!response.ok) throw new ReviewError(response.status, response.error); resolve(response.value); } catch (e) { reject(e); } });
  });
}
