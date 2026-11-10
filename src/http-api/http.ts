import type { IncomingMessage, ServerResponse } from "node:http";
import { McpAccess } from "../mcp/auth.js";
import { McpService } from "../mcp/service.js";
import { TaskRequestError } from "../mcp/errors.js";
import { uuid } from "../mcp/store.js";

export const HTTP_API_PREFIX = "/api/v1";
const pending = (status: string) => status === "queued" || status === "running";
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new TaskRequestError(415, "Use Content-Type: application/json.");
  if (Number(req.headers["content-length"] ?? 0) > 65536) { req.resume(); throw new TaskRequestError(413, "Request body exceeds 64 KiB."); }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 65536) { req.resume(); throw new TaskRequestError(413, "Request body exceeds 64 KiB."); }
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return value as Record<string, unknown>;
  } catch { throw new TaskRequestError(400, "Provide a JSON object encoded as UTF-8."); }
}
function emptyRequest(req: IncomingMessage) {
  if (req.headers["transfer-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0") throw new TaskRequestError(400, "This operation accepts no request body.");
}
/** Bearer-only text adapter. Its task store is separate from Web/WeCom/MCP. */
export class ExpertHttpApi {
  private readonly access: McpAccess;
  constructor(private readonly enabled: boolean, key: string, private readonly service: McpService, private readonly redact: (error: unknown) => string) { this.access = new McpAccess(key); }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      if (!this.enabled) throw new TaskRequestError(404, "HTTP question API is disabled.");
      const count = req.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === "authorization").length;
      if (count !== 1 || !this.access.authenticated(req.headers.authorization)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="product-expert-api"');
        throw new TaskRequestError(401, "A valid AGENT_API_KEY is required.");
      }
      if (url.search) throw new TaskRequestError(400, "Query parameters are not supported. Send credentials only in the Authorization header.");
      let result: Awaited<ReturnType<McpService["result"]>> & { cancellation_requested?: boolean };
      if (url.pathname === `${HTTP_API_PREFIX}/ask`) {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); throw new TaskRequestError(405, "Use POST to submit a question."); }
        const args = await body(req);
        if (Object.keys(args).some(k => !["question", "conversation_id", "request_id"].includes(k)) ||
            typeof args.question !== "string" || !args.question.trim() || args.question.length > 12000 ||
            args.conversation_id !== undefined && !uuid(args.conversation_id) || args.request_id !== undefined && !uuid(args.request_id))
          throw new TaskRequestError(400, "Provide question (1–12000 characters), optional conversation_id and request_id (UUIDs). No other fields are accepted.");
        result = await this.service.ask({ question: args.question, ...(args.conversation_id ? { conversation_id: args.conversation_id as string } : {}), ...(args.request_id ? { request_id: args.request_id as string } : {}) });
      } else {
        const match = /^\/api\/v1\/tasks\/([a-f0-9-]+)(\/cancel)?$/.exec(url.pathname);
        if (!match) throw new TaskRequestError(404, "API route not found.");
        if (!uuid(match[1])) throw new TaskRequestError(400, "Invalid task_id.");
        const method = match[2] ? "POST" : "GET";
        if (req.method !== method) { res.setHeader("Allow", method); throw new TaskRequestError(405, `Use ${method} for this operation.`); }
        emptyRequest(req);
        result = match[2] ? await this.service.cancel(match[1]) : await this.service.result(match[1]);
      }
      // Admission failure in the shared run gate never invokes a model.
      const status = req.method === "POST" && result.error_code === "capacity_exceeded" ? 429 : req.method === "POST" && pending(result.status) ? 202 : 200;
      if (pending(result.status) || status === 429) res.setHeader("Retry-After", "2");
      if (result.error) result.error = this.redact(result.error).replace(/\bMCP\b/g, "API");
      json(res, status, result);
    } catch (error) {
      const status = error instanceof TaskRequestError ? error.status : 500;
      if (status === 429) res.setHeader("Retry-After", "2");
      if (status === 500) console.error("HTTP question API:", this.redact(error));
      json(res, status, { error: status === 500 ? "API request failed." : this.redact(error).replace(/\bMCP\b/g, "API") });
    }
  }
}
