import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ExportAccess } from "./access.js";
import { ExportError, KnowledgeSnapshots } from "./snapshot.js";

export const KNOWLEDGE_EXPORT_PATH = "/api/knowledge/export";

export class KnowledgeExportHttp {
  private active = 0;
  private readonly snapshots: KnowledgeSnapshots;
  constructor(dataDir: string, private readonly access: ExportAccess) {
    this.snapshots = new KnowledgeSnapshots(dataDir);
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.access.configured) throw new ExportError(404, "Knowledge export is disabled.");
    const authorizations = req.rawHeaders.filter((_, index, headers) => index % 2 === 0 && headers[index]?.toLowerCase() === "authorization");
    if (authorizations.length !== 1 || !this.access.authenticated(req.headers.authorization)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="product-expert-knowledge-export"');
      throw new ExportError(401, "A valid knowledge download token is required.");
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      throw new ExportError(405, "Knowledge export supports GET only.");
    }
    if (url.search || req.headers["transfer-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0") {
      throw new ExportError(400, "Knowledge export accepts no query parameters or request body.");
    }
    if (this.active >= 4) {
      res.setHeader("Retry-After", "5");
      throw new ExportError(429, "Too many active knowledge downloads. Retry shortly.");
    }
    this.active++;
    try {
      const snapshot = await this.snapshots.get();
      if (res.destroyed) return;
      res.setHeader("ETag", snapshot.etag);
      res.setHeader("X-Knowledge-Version", snapshot.manifest.version);
      res.setHeader("X-Knowledge-SHA256", snapshot.sha256);
      if (req.headers["if-none-match"]?.split(",").some(value => [snapshot.etag, `W/${snapshot.etag}`, "*"].includes(value.trim()))) {
        res.writeHead(304); res.end(); return;
      }
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="knowledge-${snapshot.manifest.version.slice(0, 16)}.zip"`,
        "Content-Length": snapshot.bytes.length,
      });
      await pipeline(Readable.from([snapshot.bytes]), res, { signal: AbortSignal.timeout(120000) });
    } finally { this.active--; }
  }
}
