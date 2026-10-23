import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPlanner } from "../dist/knowledge-sync/agent.js";
import { SyncService } from "../dist/knowledge-sync/service.js";
import { emptyUsage, hash, PlanError } from "../dist/knowledge-sync/core.js";

const hub = "product-knowledge-vault/products/DT610.md";
const source = "DT610/others/fixture_202610230001/spec.md";
const existing = "DT610/specs/current_202601010000/spec.md";
const decision = {
  action: "review",
  reason: "Fixture business decision",
  summary: "Fixture",
  products: ["DT610"],
  slot: "others",
  oldPaths: [],
  versionEvidence: "Fixture",
  authorizedException: false,
  reviewedPaths: [],
};
const tool = (name, args = {}) => ({ name, args });
function reply(res, calls, finish) {
  calls = Array.isArray(calls) ? calls : calls ? [calls] : [];
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = calls.length
    ? {
        role: "assistant",
        tool_calls: calls.map((c, i) => ({
          index: i,
          id: `call-${i}-${Math.random()}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }
    : { role: "assistant", content: "No structured result" };
  for (const [part, end] of [
    [delta, null],
    [{}, finish ?? (calls.length ? "tool_calls" : "stop")],
  ])
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: part, finish_reason: end }], ...(end ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}) })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
}
function httpError(res, status) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message: `Fixture upstream HTTP ${status}`,
        type: "fixture_error",
      },
    }),
  );
}
async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-termination-"));
  const requests = [],
    services = [];
  let respond;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const index = requests.length;
    requests.push(JSON.parse(raw));
    if (respond) await respond(res, index);
    else httpError(res, 500);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const service of services) await service.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
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
    workDir: path.join(dataDir, "planner"),
    maxCalls: 64,
    acquire: async () => () => {},
  };
  const f = {
    dataDir,
    options,
    requests,
    set(fn) {
      requests.length = 0;
      respond = fn;
    },
    async run(overrides = {}, maxCalls = 64) {
      const usage = emptyUsage();
      f.usage = usage;
      return createPlanner({ ...options, maxCalls })({
        base: new Map(),
        markdown: "Fixture source",
        prompt: "SYNC fixture",
        feedback: "",
        batch: [],
        deletions: [],
        timestamp: "202610230001",
        signal: AbortSignal.timeout(10000),
        usage,
        update: async () => {},
        ...overrides,
      });
    },
    async service() {
      const service = new SyncService({
        dataDir,
        maxBytes: 30 * 1048576,
        timeoutMs: 10000,
        modelId: () => "fixture",
        redact: (e) => e.message,
        planner: () => createPlanner(options),
        converter: () => async (file) => {
          const bytes = await fs.readFile(file);
          return {
            markdown: bytes.toString("utf8"),
            sourceHash: hash(bytes),
            coverage: ["Fixture complete"],
            visual: emptyUsage(),
            version: 1,
          };
        },
      });
      services.push(service);
      await service.init();
      return service;
    },
  };
  return f;
}
async function done(service, id) {
  for (let n = 0; n < 2000; n++) {
    const value = service.summary(id);
    if (!["queued", "running", "stopping"].includes(value.status))
      return service.get(id);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Fixture did not settle");
}

test("accepted finish stops in the same turn, preserves usage and blocks later writes in the same tool batch", async (t) => {
  const f = await setup(t);
  f.set((res) =>
    reply(res, [
      tool("read_candidate_source"),
      tool("finish_sync", decision),
      tool("write_candidate", {
        path: "product-knowledge-vault/index.md",
        text: "Must never be staged",
      }),
    ]),
  );
  const result = await f.run();
  assert.equal(result.decision.action, "review");
  assert.equal(result.staged.size, 0);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.usage, {
    input: 100,
    output: 10,
    requests: 1,
    recorded: 1,
  });
});

test("valid source publishes and a valid deletion preview confirms through the real planner without an extra inference", async (t) => {
  const f = await setup(t),
    root = path.join(f.dataDir, "urovo-product-expert");
  const write = async (p, text) => {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  };
  await write(existing, "# Independent specs");
  await write(hub, `# DT610\n${existing}`);
  await write("product-knowledge-vault/index.md", "[[products/DT610|DT610]]");
  const service = await f.service();
  const add = {
    ...decision,
    action: "add",
    newPath: source,
    reviewedPaths: [hub],
  };
  const script = [
    tool("read_candidate_source"),
    tool("read_knowledge", { path: hub }),
    tool("write_candidate", {
      path: hub,
      text: `# DT610\n${existing}\n${source}\nConverted; original removed after successful sync`,
    }),
    tool("finish_sync", add),
  ];
  f.set((res, n) => reply(res, script[n]));
  const upload = await service.upload(
    "fixture.md",
    (async function* () {
      yield Buffer.from("Fixture source");
    })(),
  );
  const published = await done(service, (await service.start([upload.id])).id);
  assert.equal(
    published.items[0].status,
    "published",
    published.items[0].reason,
  );
  assert.equal(published.items[0].sourceDeleted, true);
  assert.equal(
    await fs.readFile(path.join(root, source), "utf8"),
    "Fixture source",
  );
  assert.equal(f.requests.length, 4);
  assert.equal(published.items[0].textUsage.requests, 4);
  const deletion = {
    ...decision,
    action: "delete",
    oldPaths: [source],
    reviewedPaths: [hub],
  };
  const remove = [
    tool("read_knowledge", { path: source }),
    tool("read_knowledge", { path: hub }),
    tool("write_candidate", { path: hub, text: `# DT610\n${existing}` }),
    tool("finish_sync", deletion),
  ];
  f.set((res, n) => reply(res, remove[n]));
  const preview = await done(
    service,
    (await service.preview("Delete only the fixture source")).id,
  );
  assert.equal(
    preview.status,
    "awaiting_confirmation",
    preview.items[0].reason,
  );
  assert.equal(f.requests.length, 4);
  assert.equal(
    await fs.readFile(path.join(root, source), "utf8"),
    "Fixture source",
  );
  const final = await done(service, (await service.confirm(preview.id)).id);
  assert.equal(final.items[0].status, "deleted", final.items[0].reason);
  await assert.rejects(fs.stat(path.join(root, source)), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(root, existing), "utf8"),
    "# Independent specs",
  );
  assert.equal(f.requests.length, 4);
});

test("HTTP model errors stop once and retain the upstream status instead of the generic decision error", async (t) => {
  const f = await setup(t);
  for (const status of [400, 402, 429, 500])
    await t.test(String(status), async () => {
      f.set((res) => httpError(res, status));
      await assert.rejects(
        f.run(),
        new RegExp(`Fixture upstream HTTP ${status}`),
      );
      assert.equal(f.requests.length, 1);
      assert.equal(f.usage.requests, 1);
      assert.equal(f.usage.recorded, 0);
    });
});

test("a rejected plan cannot mask later request-budget exhaustion; the blocked request is not counted as sent", async (t) => {
  const f = await setup(t);
  f.set((res, n) =>
    reply(
      res,
      n === 0 ? tool("finish_sync", decision) : tool("read_candidate_source"),
    ),
  );
  await assert.rejects(
    f.run(
      {
        validate: async () => {
          throw new PlanError(["Old rejected validation"]);
        },
      },
      3,
    ),
    (e) =>
      /request budget exceeded \(3\/3 request attempts\)/.test(e.message) &&
      !e.message.includes("Old rejected validation"),
  );
  assert.equal(f.requests.length, 3);
  assert.equal(f.usage.requests, 3);
  assert.equal(f.usage.recorded, 3);
});

test("a rejected plan cannot mask a later upstream failure", async (t) => {
  const f = await setup(t);
  f.set((res, n) =>
    n === 0 ? reply(res, tool("finish_sync", decision)) : httpError(res, 402),
  );
  await assert.rejects(
    f.run({
      validate: async () => {
        throw new PlanError(["Earlier invalid plan"]);
      },
    }),
    /Fixture upstream HTTP 402/,
  );
  assert.equal(f.requests.length, 2);
});

test("repeated plan validation stops on the second equal problem set and preserves its actual error", async (t) => {
  const f = await setup(t);
  f.set((res) => reply(res, tool("finish_sync", decision)));
  let n = 0;
  await assert.rejects(
    f.run({
      validate: async () => {
        throw new PlanError(
          ++n === 1 ? ["Problem A", "Problem B"] : ["Problem B", "Problem A"],
        );
      },
    }),
    (e) => e instanceof PlanError && e.problems.includes("Problem A"),
  );
  assert.equal(f.requests.length, 2);
  assert.equal(f.usage.requests, 2);
});

test("three distinct invalid submissions stop; a valid correction before the limit still succeeds", async (t) => {
  const f = await setup(t);
  let n = 0;
  f.set((res) => reply(res, tool("finish_sync", decision)));
  await assert.rejects(
    f.run({
      validate: async () => {
        throw new PlanError([`Problem ${++n}`]);
      },
    }),
    /Problem 3/,
  );
  assert.equal(f.requests.length, 3);
  n = 0;
  f.set((res) => reply(res, tool("finish_sync", decision)));
  const result = await f.run({
    validate: async () => {
      if (++n === 1) throw new PlanError(["Correctable validation"]);
    },
  });
  assert.equal(result.decision.action, "review");
  assert.equal(f.requests.length, 2);
});

test("exhaustive-read and schema failures are bounded; repeated tool errors cannot burn the entire request budget", async (t) => {
  const f = await setup(t);
  f.set((res) =>
    reply(
      res,
      tool("finish_sync", { ...decision, action: "add", newPath: source }),
    ),
  );
  await assert.rejects(
    f.run(),
    /Read all segments before submitting: @candidate/,
  );
  assert.equal(f.requests.length, 2);
  f.set((res) => reply(res, tool("finish_sync", {})));
  await assert.rejects(f.run(), /arguments|validation|required/i);
  assert.equal(f.requests.length, 2);
  f.set((res) => reply(res, tool("read_knowledge", { path: "MEMORY.md" })));
  await assert.rejects(f.run(), /Protected path/);
  assert.equal(f.requests.length, 2);
});

test("truncated output cannot submit or execute candidate writes and reports the output-token limit", async (t) => {
  const f = await setup(t);
  f.set((res) =>
    reply(
      res,
      [
        tool("write_candidate", {
          path: "product-knowledge-vault/index.md",
          text: "Do not stage",
        }),
        tool("finish_sync", decision),
      ],
      "length",
    ),
  );
  await assert.rejects(f.run(), /output reached its token limit/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.usage.recorded, 1);
});

test("cancellation after a rejected plan remains cancellation, not the old validation failure", async (t) => {
  const f = await setup(t),
    controller = new AbortController();
  f.set((res, n) => {
    if (n === 0) reply(res, tool("finish_sync", decision));
    else {
      controller.abort(new Error("Fixture cancellation"));
      res.end();
    }
  });
  await assert.rejects(
    f.run({
      signal: controller.signal,
      validate: async () => {
        throw new PlanError(["Earlier failed decision"]);
      },
    }),
    /Fixture cancellation/,
  );
  assert.equal(f.requests.length, 2);
});
