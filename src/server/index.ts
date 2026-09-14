import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import type { PatrickRuntime } from "../agent/index.js";
import { config, paths } from "../config.js";
import { handleApiRoute } from "./routes.js";
import { EventStream } from "./stream.js";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveWeb(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const requestedPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const normalized = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = path.join(paths.webDist, normalized);

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    try {
      const content = await fs.readFile(path.join(paths.webDist, "index.html"));
      response.writeHead(200, { "Content-Type": mimeTypes[".html"] });
      response.end(content);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Web build not found. Run `npm run dev` for development.");
    }
  }
}

export async function startServer(runtime: PatrickRuntime): Promise<void> {
  const stream = new EventStream();
  runtime.subscribe((event) => stream.publish(event));

  const server = createServer(async (request, response) => {
    try {
      if (await handleApiRoute(request, response, runtime, stream)) return;
      await serveWeb(request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Internal server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(`Pi Patrick server: http://${config.host}:${config.port}`);
}

