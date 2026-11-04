import type { IncomingMessage, ServerResponse } from "node:http";
import type { QuestionReviewService } from "./service.js";
import { ReviewError } from "./types.js";
export async function questionReviewRoute(req: IncomingMessage, res: ServerResponse, url: URL, service: QuestionReviewService, readBody: (req: IncomingMessage, max?: number) => Promise<unknown>) {
  const route = url.pathname.slice("/api/question-review".length), method = req.method;
  const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (route === "/settings" && method === "GET") return json(service.status());
  if (route === "/settings" && method === "PUT") return json(await service.configure(await readBody(req, 16000)));
  if (route === "/runs" && method === "GET") return json({ runs: await service.list() });
  if (route === "/runs" && method === "POST") return json(await service.start(await readBody(req, 16000)), 202);
  const match = route.match(/^\/runs\/([a-f0-9-]{36})(?:\/(cancel|export))?$/);
  if (!match) throw new ReviewError(404, "Review endpoint not found");
  const id = match[1]!;
  if (!match[2] && method === "GET") return json(await service.get(id));
  if (match[2] === "cancel" && method === "POST") {
    const body = await readBody(req, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new ReviewError(400, "Cancellation accepts an empty object");
    return json(await service.cancel(id));
  }
  if (match[2] === "export" && method === "GET") {
    const format = url.searchParams.get("format") ?? "markdown";
    if (!["json", "markdown"].includes(format)) throw new ReviewError(400, "Invalid export format");
    const text = await service.export(id, format as "json" | "markdown");
    res.writeHead(200, { "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="question-review-${id}.${format === "json" ? "json" : "md"}"`, "Cache-Control": "no-store" }); res.end(text); return;
  }
  throw new ReviewError(404, "Review endpoint not found");
}
