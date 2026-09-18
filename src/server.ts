import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntime, type AgentRuntime } from "./agent/runtime.js";

const SKILL_NAME = "urovo-product-expert";
const MAX_BODY_BYTES = 64 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isAuthorized(request: IncomingMessage, apiKey: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function queryProduct(runtime: AgentRuntime, query: string): Promise<string> {
  const session = await runtime.createSession(
    SessionManager.inMemory(runtime.config.cwd),
  );

  try {
    const hasSkill = session.resourceLoader
      .getSkills()
      .skills.some((skill) => skill.name === SKILL_NAME);
    if (!hasSkill) throw new Error(`Skill ${SKILL_NAME} was not loaded`);

    await session.prompt(`/skill:${SKILL_NAME} ${query}`, {
      expandPromptTemplates: true,
      source: "rpc",
    });

    const answer = session.getLastAssistantText();
    if (!answer) throw new Error("The agent returned no answer");
    return answer;
  } finally {
    session.dispose();
  }
}

const apiKey = requiredEnv("PRODUCT_API_KEY");
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const runtime = await createAgentRuntime();

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/product/query") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (!isAuthorized(request, apiKey)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body" });
    return;
  }

  const query =
    typeof body === "object" && body !== null && "query" in body
      ? body.query
      : undefined;
  if (typeof query !== "string" || !query.trim()) {
    sendJson(response, 400, { error: "query must be a non-empty string" });
    return;
  }

  try {
    const answer = await queryProduct(runtime, query.trim());
    sendJson(response, 200, { answer });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Product query failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Product API listening on http://${host}:${port}`);
});
