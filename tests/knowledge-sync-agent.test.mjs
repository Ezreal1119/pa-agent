import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPlanner } from "../dist/knowledge-sync/agent.js";
import { emptyUsage, hash } from "../dist/knowledge-sync/core.js";

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
    { name: "finish_sync", args: { ...decision, action: "review" } },
  ];
  calls.splice(
    calls.length - 2,
    0,
    {
      name: "patch_candidate",
      args: {
        path: "product-knowledge-vault/index.md",
        expectedHash: "0".repeat(64),
        replacements: [{ before: "replacement", after: "bad" }],
      },
    },
    {
      name: "patch_candidate",
      args: {
        path: "product-knowledge-vault/index.md",
        expectedHash: hash("replacement"),
        replacements: [{ before: "e", after: "bad" }],
      },
    },
    {
      name: "patch_candidate",
      args: {
        path: "product-knowledge-vault/index.md",
        expectedHash: hash("replacement"),
        replacements: [{ before: "replacement", after: "patched" }],
      },
    },
    {
      name: "write_candidate",
      args: {
        path: "product-knowledge-vault/log.md",
        text: "overwrite history",
      },
    },
  );
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
  assert.equal(result.decision.action, "review");
  assert.equal(
    result.staged.get("product-knowledge-vault/index.md"),
    "patched",
  );
  assert.ok(!result.staged.has("product-knowledge-vault/log.md"));
  assert.ok(usage.input > 0);
  assert.ok(usage.requests >= 7);
  const names = payloads[0].tools.map((t) => t.function.name);
  assert.ok(names.includes("read_batch_source"));
  for (const name of ["bash", "read", "write", "memory", "search", "fetch"])
    assert.ok(!names.includes(name));
  const all = JSON.stringify(payloads);
  assert.ok(all.includes("review_required"));
  assert.match(all, /Protected path/);
  assert.match(all, /Candidate baseline conflict/);
  assert.match(all, /Each replacement must match exactly once/);
  assert.match(all, /backend appends the log/);
  // finish_sync validates in-tool and returns every problem for repair.
  assert.match(all, /submitted\\":false/);
  assert.match(all, /New products require administrator feedback/);
  assert.ok(names.includes("product_hubs"));
  assert.ok(all.includes("requiredReads") && all.includes("ORIGINAL INDEX"));
  assert.ok(!all.includes("Extra agent memory"));
  index = 0;
  await assert.rejects(
    createPlanner({ ...options, maxCalls: 1 })({
      ...input,
      usage: emptyUsage(),
    }),
    /without a structured decision|budget/,
  );
  const suggestion =
    "这是新产品 T5000，允许创建产品目录。将这份修改记录放入 T5000/others，并创建产品 Hub、更新相关索引。";
  const review = {
    ...decision,
    action: "review",
    products: ["T5000"],
    suggestedFeedback: suggestion,
  };
  calls.splice(
    0,
    calls.length,
    { name: "finish_sync", args: review },
    { name: "read_candidate_source", args: {} },
    { name: "read_candidate_source", args: { offset: 20000 } },
    { name: "finish_sync", args: review },
  );
  index = 0;
  payloads.length = 0;
  const reviewed = await createPlanner(options)({
    ...input,
    usage: emptyUsage(),
  });
  assert.equal(reviewed.decision.suggestedFeedback, suggestion);
  const finish = payloads[0].tools.find(
    (t) => t.function.name === "finish_sync",
  );
  assert.equal(
    finish.function.parameters.properties.suggestedFeedback.maxLength,
    16000,
  );
  assert.ok(!finish.function.parameters.required.includes("suggestedFeedback"));
  assert.match(JSON.stringify(payloads), /Read all segments before submitting/);
  assert.match(
    JSON.stringify(payloads),
    /NEVER administrator feedback or permission/,
  );
  const source = "i9600/others/release_202610220001/changes.md",
    hub = "product-knowledge-vault/products/i9600.md",
    miniHub = "product-knowledge-vault/products/i9600-Mini.md",
    markdown = "# Firmware release notes\nRevision 3";
  const base = new Map([
    [source, markdown], [hub, `# i9600\n${source}`],
    ["i9600 Mini/specs/current_202601010000/spec.md", "Independent Mini specs"],
    [miniHub, "# Mini\ni9600 Mini/specs/current_202601010000/spec.md"],
  ]);
  const associate = {
    ...decision, action: "associate", products: ["i9600", "i9600 Mini"],
    newPath: undefined, existingSource: source, oldPaths: [],
  };
  calls.splice(0, calls.length,
    { name: "finish_sync", args: associate },
    { name: "write_candidate", args: { path: hub, text: "Remove i9600 facts" } },
    { name: "finish_sync", args: associate },
  );
  index = 0; payloads.length = 0;
  const linked = await createPlanner(options)({
    ...input, base, markdown, candidates: new Map(), usage: emptyUsage(),
    feedback: "同时适用于 i9600 和 i9600 Mini，保留 i9600 并补 Mini。",
    association: { path: source, markdownHash: hash(markdown), products: ["i9600"], coveredProducts: ["i9600"], inputNames: ["changes.xlsx"], slot: "others" },
  });
  assert.equal(linked.decision.action, "associate");
  assert.equal(linked.staged.size, 0, "association planner cannot write candidates");
  const wire = JSON.stringify(payloads);
  assert.match(wire, /ASSOCIATION-ONLY MODE/);
  assert.match(wire, /Association review is read-only/);
  assert.ok(wire.includes("requiredReads") && wire.includes(miniHub) && wire.includes("review_required"));
  assert.equal(base.get(hub), `# i9600\n${source}`);
});
