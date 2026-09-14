import type { IncomingMessage, ServerResponse } from "node:http";
import type { PatrickRuntime } from "../agent/index.js";
import { errorMessage } from "../utils/index.js";
import type { EventStream } from "./stream.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function handleApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: PatrickRuntime,
  stream: EventStream,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    response.end();
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    stream.add(response);
    try {
      stream.send(response, { type: "state", state: await runtime.getState() });
    } catch (error) {
      runtime.emitError(error);
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    try {
      json(response, 200, await runtime.getState());
    } catch (error) {
      json(response, 503, { error: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    try {
      const body = await readJson(request);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        json(response, 400, { error: "Message text is required" });
        return true;
      }

      void runtime.prompt(text).catch((error) => runtime.emitError(error));
      json(response, 202, { accepted: true });
    } catch (error) {
      json(response, 400, { error: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/abort") {
    try {
      await runtime.abort();
      json(response, 200, { aborted: true });
    } catch (error) {
      json(response, 500, { error: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/session/new") {
    try {
      json(response, 201, await runtime.newSession());
    } catch (error) {
      json(response, 500, { error: errorMessage(error) });
    }
    return true;
  }

  return false;
}
