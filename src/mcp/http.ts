import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod";
import { McpService } from "./service.js";

/** Stateless protocol transport; business tasks continue independently of HTTP connections. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, service: McpService) {
  const server = new McpServer({ name: "urovo-product-expert", version: "1.0.0" }, { instructions: "Text-only UROVO product/UMS expert. ask_product_expert returns an immediate answer or a durable task_id. For queued/running tasks, wait at least poll_after_ms before get_task_result. Reuse conversation_id only for a follow-up; omit it for a new topic. Do not submit the same question again to poll. A random request_id makes ask retries idempotent. No file uploads or memory writes are supported. Authentication is handled by the HTTP endpoint." });
  const id = z.uuid();
  const result = (data: Awaited<ReturnType<McpService["result"]>>) => ({ content: [{ type: "text" as const, text: data.answer || JSON.stringify(data) }], structuredContent: data, ...(["failed", "cancelled", "interrupted"].includes(data.status) ? { isError: true } : {}) });
  const safely = async (fn: () => Promise<ReturnType<typeof result>>) => { try { return await fn(); } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "MCP request failed." }] }; } };
  server.registerTool("ask_product_expert", {
    title: "Ask the UROVO product expert", description: "Ask a text question about UROVO products, model comparisons, selection, specifications, or UMS. Returns a text answer when ready, otherwise a task_id for later retrieval. Follow up with the returned conversation_id. Never send files, local paths to read, or instructions to change shared memories. This calls a separate agent and consumes its configured model tokens.",
    inputSchema: z.object({ question: z.string().min(1).max(12000), conversation_id: id.optional(), request_id: id.optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => safely(async () => result(await service.ask(args))));
  server.registerTool("get_task_result", {
    title: "Get expert task result", description: "Retrieve a previously submitted task, its final text answer, timing, and recorded token usage. For pending tasks wait poll_after_ms before querying again. This never starts a model request or adds token usage. Task IDs are opaque handles; no listing of other callers' tasks is available.",
    inputSchema: z.object({ task_id: id }).strict(), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, args => safely(async () => result(await service.result(args.task_id))));
  server.registerTool("cancel_task", {
    title: "Cancel expert task", description: "Request cancellation of a pending/running expert task. Cancellation is cooperative; query its result to see final status and recorded tokens. Repeated cancellation does not start new model work.",
    inputSchema: z.object({ task_id: id }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, args => safely(async () => result(await service.cancel(args.task_id))));
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
  await server.connect(transport);
  try { await transport.handleRequest(req, res); }
  finally { await server.close(); }
}
