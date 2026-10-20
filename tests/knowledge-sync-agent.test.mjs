import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPlanner } from "../dist/knowledge-sync/agent.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";

function reply(res, tool, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const deltas = tool
    ? [
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${Math.random()}`,
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.args),
              },
            },
          ],
        },
      ]
    : [{ role: "assistant", content: "Submitted" }];
  for (const delta of deltas)
    res.write(
      `data: ${JSON.stringify({ id: "test", model: "fixture", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
  res.write(
    `data: ${JSON.stringify({ id: "test", model: "fixture", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
test("real Pi maintenance session exposes only candidate tools, guards exhaustive reads, has independent context and budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-agent-"));
  let server;
  const payloads = [];
  let index = 0;
  t.after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  });
  const decision = {
    action: "add",
    reason: "Fixture",
    summary: "Fixture",
    products: ["DT610"],
    slot: "others",
    oldPaths: [],
    newPath: "DT610/others/test_202610200000/test.md",
    versionEvidence: "Fixture",
    authorizedException: false,
    reviewedPaths: [],
  };
  const calls = [
    { name: "finish_sync", args: decision },
    { name: "read_candidate_source", args: {} },
    { name: "read_candidate_source", args: { offset: 20000 } },
    { name: "read_knowledge", args: { path: "MEMORY.md" } },
    { name: "batch_candidates", args: {} },
    { name: "read_batch_source", args: { id: "other" } },
    {
      name: "write_candidate",
      args: { path: "product-knowledge-vault/index.md", text: "replacement" },
    },
    {
      name: "read_knowledge",
      args: { path: "product-knowledge-vault/index.md", candidate: true },
    },
    { name: "finish_sync", args: decision },
    {
      name: "read_knowledge",
      args: { path: "product-knowledge-vault/index.md" },
    },
    { name: "finish_sync", args: decision },
  ];
  server = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    payloads.push(JSON.parse(text));
    reply(res, calls[index++]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const options = {
    model: {
      apiKey: "fixture-key",
      modelId: "fixture",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      contextWindow: 128000,
      maxTokens: 16384,
    },
    effort: "low",
    resourcesDir: path.resolve("resources"),
    workDir: root,
    maxCalls: 20,
    acquire: async () => () => {},
  };
  const usage = emptyUsage();
  const input = {
    base: new Map([["product-knowledge-vault/index.md", "ORIGINAL INDEX"]]),
    markdown: "A".repeat(25000),
    prompt: "SYNC fixture",
    feedback: "",
    batch: [],
    candidates: new Map([["other", "other document"]]),
    deletions: [],
    timestamp: "202610200000",
    signal: new AbortController().signal,
    usage,
    update: async () => {},
  };
  const result = await createPlanner(options)(input);
  assert.equal(result.decision.action, "add");
  assert.ok(usage.input > 0);
  assert.ok(usage.requests >= 7);
  const names = payloads[0].tools.map((t) => t.function.name);
  assert.ok(names.includes("read_batch_source"));
  for (const name of ["bash", "read", "write", "memory", "search", "fetch"])
    assert.ok(!names.includes(name));
  const all = JSON.stringify(payloads);
  assert.match(all, /Read all segments before submitting/);
  assert.match(all, /Protected path/);
  assert.match(
    all,
    /Read all segments before submitting: product-knowledge-vault\/index.md/,
  );
  assert.ok(!all.includes("Extra agent memory"));
  index = 0;
  await assert.rejects(
    createPlanner({ ...options, maxCalls: 1 })({
      ...input,
      usage: emptyUsage(),
    }),
    /without a structured decision|budget/,
  );
});
