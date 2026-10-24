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
import { sourceKey, hint } from "../dist/knowledge-sync/wecom-sources.js";

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
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
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
    tool("source_dependents", { paths: [source] }),
    tool("read_next_deletion_batch"),
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

test("automatic original reads still lead to bounded business/schema failures and repeated tool errors", async (t) => {
  const f = await setup(t);
  f.set((res) =>
    reply(
      res,
      tool("finish_sync", { ...decision, action: "add", newPath: source }),
    ),
  );
  await assert.rejects(
    f.run(),
    /New products require administrator feedback/,
  );
  assert.equal(f.requests.length, 3); // Read phase, then two actual validation rejections.
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

test("deletion missing reads list every original segment; automatic batches repair the same plan without rereading or following indirect references", async (t) => {
  const f = await setup(t);
  const index = "product-knowledge-vault/shared/fixture.md";
  const note = "product-knowledge-vault/shared/retirement-note.md";
  const indirect = "product-knowledge-vault/products/UNRELATED.md";
  const original = "# Source\n" + "原文".repeat(12000);
  const indexText = `# Shared reference\n${source}\n` + "索引".repeat(21000);
  const hubText = `# DT610\n${existing}\n${source}\n${index}`;
  const base = new Map([
    [source, original],
    [existing, "# Independent specs"],
    [hub, hubText],
    [index, indexText],
    [note, "# Relevant retirement note"],
    [indirect, `# Unrelated\n${hub}`],
  ]);
  const plan = {
    ...decision,
    action: "delete",
    oldPaths: [source],
    reviewedPaths: [hub, index, note],
  };
  const script = [
    tool("source_dependents", { paths: [source] }),
    tool("read_knowledge", { path: source }),
    tool("write_candidate", {
      path: hub,
      text: `# DT610\n${existing}\n${index}`,
    }),
    tool("write_candidate", {
      path: index,
      text: "# Shared reference\nIndependent material retained",
    }),
    tool("read_knowledge", { path: index, candidate: true }),
    tool("finish_sync", plan),
  ];
  const seen = new Set([`${source}:0`]);
  let checklist,
    validated = 0,
    batches = 0,
    complete = false;
  const output = () =>
    JSON.parse(
      f.requests
        .at(-1)
        .messages.filter((m) => m.role === "tool")
        .at(-1).content,
    );
  f.set((res, n) => {
    assert.ok(!f.requests[n].tools.some(t => t.function.name === "read_next_sync_batch"));
    if (n < script.length) return reply(res, script[n]);
    if (n === script.length) {
      checklist = output();
      assert.equal(checklist.submitted, false);
      assert.equal(checklist.repairsLeft, 2);
      assert.equal(checklist.nextTool, "read_next_deletion_batch");
      const missing = Object.fromEntries(
        checklist.missingReads.map((m) => [m.path, m.offsets]),
      );
      assert.deepEqual(missing[source], [20000]);
      assert.deepEqual(missing[index], [0, 20000, 40000]);
      assert.deepEqual(missing[hub], [0]);
      assert.deepEqual(missing[note], [0]); // Additional declared pages join the same queue at finish.
      assert.deepEqual(missing["@candidate"], [0]);
      assert.ok(!missing[indirect]);
    } else {
      const batch = output();
      batches++;
      assert.ok(batch.segments.length <= 4);
      assert.ok(
        batch.segments.reduce((sum, s) => sum + s.text.length, 0) <= 40000,
      );
      for (const segment of batch.segments) {
        const key = `${segment.path}:${segment.offset}`;
        assert.ok(!seen.has(key), `Duplicate segment ${key}`);
        seen.add(key);
        assert.equal(
          segment.hash,
          hash(
            segment.path === "@candidate"
              ? "Fixture source"
              : base.get(segment.path),
          ),
        );
        const expected = (
          segment.path === "@candidate"
            ? "Fixture source"
            : base.get(segment.path)
        ).slice(segment.offset, segment.offset + 20000);
        assert.equal(
          segment.text.length,
          expected.length,
          `${key}: original segment length`,
        );
        assert.equal(
          hash(segment.text),
          hash(expected),
          `${key}: original segment content`,
        );
      }
      if (batch.complete) {
        assert.deepEqual(batch.missingReads, []);
        complete = true;
        return reply(res, tool("finish_sync", plan));
      }
    }
    reply(res, tool("read_next_deletion_batch"));
  });
  const result = await f.run({
    base,
    deletion: true,
    validate: async () => {
      validated++;
    },
  });
  assert.equal(result.decision.action, "delete");
  assert.equal(validated, 1);
  assert.ok(complete && batches >= 2);
  assert.equal(seen.size, 8);
  assert.ok(!result.staged.has(indirect));
  assert.equal(base.get(source), original);
  assert.equal(base.get(index), indexText);
  assert.equal(f.requests.length, script.length + batches + 1); // No inference after accepted finish.
  assert.ok(
    JSON.stringify(f.requests[0].messages).includes("DELETION READ PLAN"),
  );
});

test("deletion batch completion is idempotent, rejects protected or unknown targets, and remains cancellation-aware", async (t) => {
  const f = await setup(t);
  const base = new Map([
    [source, "# Fixture"],
    ["MEMORY.md", "PRIVATE_MEMORY_SENTINEL"],
  ]);
  const script = [
    tool("source_dependents", { paths: [source, "MEMORY.md"] }),
    tool("read_next_deletion_batch"), // Failed registration must not register even the valid target.
    tool("read_next_deletion_batch"),
    tool("source_dependents", { paths: ["missing.md"] }),
    tool("read_next_deletion_batch"),
    tool("finish_sync", decision),
  ];
  f.set((res, n) => {
    if (n === 2 || n === 3 || n === 5) {
      const value = JSON.parse(
        f.requests
          .at(-1)
          .messages.filter((m) => m.role === "tool")
          .at(-1).content,
      );
      assert.equal(value.complete, true);
      assert.deepEqual(value.missingReads, []);
      if (n === 2)
        assert.deepEqual(
          value.segments.map((s) => s.path),
          ["@candidate"],
        );
      else assert.deepEqual(value.segments, []);
    }
    reply(res, script[n]);
  });
  await f.run({ base, deletion: true });
  assert.ok(!JSON.stringify(f.requests).includes("PRIVATE_MEMORY_SENTINEL"));
  const controller = new AbortController();
  f.set((res, n) => {
    if (n === 0) reply(res, tool("source_dependents", { paths: [source] }));
    else {
      controller.abort(new Error("Fixture queued read cancellation"));
      reply(res, tool("read_next_deletion_batch"));
    }
  });
  await assert.rejects(
    f.run({ base, deletion: true, signal: controller.signal }),
    /queued read cancellation/,
  );
});

test("normal SYNC does not expose automatic deletion reads or change source-dependency results", async (t) => {
  const f = await setup(t);
  f.set((res, n) => {
    assert.ok(
      !f.requests[n].tools.some(
        (t) => t.function.name === "read_next_deletion_batch",
      ),
    );
    if (n === 0)
      return reply(res, tool("source_dependents", { paths: [source] }));
    const value = JSON.parse(
      f.requests[n].messages.filter((m) => m.role === "tool").at(-1).content,
    );
    assert.deepEqual(value, { paths: [hub] });
    reply(res, tool("finish_sync", decision));
  });
  await f.run({
    base: new Map([
      [source, "# Source"],
      [hub, `# DT610\n${source}`],
    ]),
  });
});

test("normal SYNC lists every missing original segment and bounded batches recover a multi-Hub publication", async (t) => {
  const f = await setup(t), root = path.join(f.dataDir, "urovo-product-expert");
  const rtHub = "product-knowledge-vault/products/RT40S.md";
  const rtSpec = "RT40S/specs/current_202601010000/spec.md";
  const index = "product-knowledge-vault/index.md";
  const shared = "product-knowledge-vault/shared/screen-fixture.md";
  const added = "_shared/others/fixture_202610240001/screen.md";
  const unrelated = "product-knowledge-vault/products/UNRELATED.md";
  const markdown = "输入".repeat(20001).slice(0, 40001);
  const base = new Map([
    [rtHub, `# RT40S\n${rtSpec}\n` + "原文".repeat(13889)],
    [hub, `# DT610\n${existing}\n` + "资料".repeat(11000)],
    [index, "[[products/RT40S]]\n[[products/DT610]]\n" + "目录".repeat(20500)],
    [rtSpec, "# RT40S independent specs"],
    [existing, "# DT610 independent specs"],
    [unrelated, `# Unrelated\n${rtHub}`],
  ]);
  const nextRt = base.get(rtHub) + "\n[[shared/screen-fixture]]";
  const nextHub = base.get(hub) + "\n[[shared/screen-fixture]]";
  const nextIndex = base.get(index) + "\n[[shared/screen-fixture]]";
  for (const [p, text] of base) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
  const service = await f.service();
  const plan = {
    ...decision, action: "add", products: ["RT40S", "DT610"], newPath: added,
    reviewedPaths: [rtHub, hub, index],
  };
  const script = [
    tool("read_next_sync_batch"), // No speculative registration or full-library discovery.
    tool("read_candidate_source"),
    tool("read_knowledge", { path: rtHub }),
    tool("write_candidate", { path: rtHub, text: nextRt }),
    tool("read_knowledge", { path: rtHub, candidate: true, offset: 20000 }),
    tool("write_candidate", { path: hub, text: nextHub }),
    tool("write_candidate", { path: index, text: nextIndex }),
    tool("write_candidate", { path: shared, text: `# Screens\n${added}\n[[products/RT40S]]\n[[products/DT610]]` }),
    tool("finish_sync", plan),
  ];
  const seen = new Set(["@candidate:0", `${rtHub}:0`]);
  let batches = 0, emptyChecked = false;
  f.set(async (res, n) => {
    if (n === 1) assert.deepEqual(latestToolValue(f), { segments: [], complete: true, missingReads: [] });
    if (n < script.length) return reply(res, script[n]);
    if (n === script.length) {
      const checklist = latestToolValue(f);
      assert.equal(checklist.submitted, false);
      assert.equal(checklist.phase, "reading");
      assert.equal(checklist.repairsLeft, undefined); // Reading precedes validation.
      assert.equal(checklist.nextTool, "read_next_sync_batch");
      const missing = Object.fromEntries(checklist.requiredReads.map(m => [m.path, m.offsets]));
      assert.deepEqual(missing, {
        "@candidate": [20000, 40000], [rtHub]: [20000],
        [hub]: [0, 20000], [index]: [0, 20000, 40000],
      });
    }
    const batch = latestToolValue(f);
    if (emptyChecked) {
      assert.deepEqual(batch, { segments: [], complete: true, missingReads: [] });
      return reply(res, tool("finish_sync", plan));
    }
    batches++;
    assert.ok(batch.segments.length <= 4);
    assert.ok(batch.segments.reduce((sum, s) => sum + s.text.length, 0) <= 40000);
    for (const segment of batch.segments) {
      const key = `${segment.path}:${segment.offset}`;
      assert.ok(!seen.has(key), `Duplicate segment ${key}`);
      seen.add(key);
      const original = segment.path === "@candidate" ? markdown : base.get(segment.path);
      assert.notEqual(original, undefined);
      assert.equal(segment.text, original.slice(segment.offset, segment.offset + 20000));
      assert.equal(segment.hash, hash(original));
      assert.ok(![unrelated, rtSpec, existing, shared].includes(segment.path));
    }
    if (batch.complete) {
      assert.deepEqual(batch.missingReads, []);
      assert.equal(await fs.readFile(path.join(root, rtHub), "utf8"), base.get(rtHub));
      await assert.rejects(fs.stat(path.join(root, added)), { code: "ENOENT" });
      emptyChecked = true;
    }
    reply(res, tool("read_next_sync_batch"));
  });
  const file = await service.upload("screen-fixture.md", (async function* () { yield Buffer.from(markdown); })());
  const report = await done(service, (await service.start([file.id])).id);
  assert.equal(report.items[0].status, "published", report.items[0].reason);
  assert.ok(emptyChecked && batches >= 3);
  assert.equal(seen.size, 10);
  assert.equal(f.requests.length, script.length + batches + 1);
  assert.equal(await fs.readFile(path.join(root, added), "utf8"), markdown);
  assert.equal(await fs.readFile(path.join(root, rtHub), "utf8"), nextRt);
  assert.equal(await fs.readFile(path.join(root, hub), "utf8"), nextHub);
  for (const p of [unrelated, existing, rtSpec])
    assert.equal(await fs.readFile(path.join(root, p), "utf8"), base.get(p));
});

test("backend advances multiple batches even if the model keeps submitting; overall budget remains enforced", async (t) => {
  const f = await setup(t), text = `# DT610\n${existing}\n` + "原".repeat(27777);
  const plan = { ...decision, action: "add", newPath: source, reviewedPaths: [hub] };
  let validated = 0, batches = 0;
  f.set((res, n) => {
    if (n > 1) {
      const batch = latestToolValue(f);
      assert.equal(batch.submitted, false);
      assert.equal(batch.requestedToolExecuted, false);
      assert.ok(batch.segments.length > 0);
      assert.ok(batch.segments.reduce((sum, s) => sum + s.text.length, 0) <= 40000);
      batches++;
    }
    reply(res, n ? tool("finish_sync", plan) : tool("write_candidate", { path: hub, text: text + "\n" + source }));
  });
  const result = await f.run({
    markdown: "x".repeat(200001), base: new Map([[hub, text], [existing, "# Specs"]]),
    validate: async () => { validated++; },
  });
  assert.equal(result.decision.action, "add");
  assert.equal(validated, 1);
  assert.ok(batches > 3);
  assert.equal(f.requests.length, batches + 2);
  f.set((res, n) => reply(res, n ? tool("read_next_sync_batch") : tool("finish_sync", plan)));
  await assert.rejects(f.run({ markdown: "x".repeat(200001) }, 3), /budget exceeded \(3\/3 request attempts\)/);
  assert.equal(f.requests.length, 3);
});

test("normal SYNC batch registration follows the latest declared scope, preserves protection and cancellation", async (t) => {
  const f = await setup(t);
  const a = "product-knowledge-vault/shared/a.md", b = "product-knowledge-vault/shared/b.md";
  const plan = { ...decision, action: "add", newPath: source, reviewedPaths: [a] };
  const script = [
    tool("finish_sync", plan),
    tool("finish_sync", { ...plan, reviewedPaths: [b, "MEMORY.md", "product-knowledge-vault/log.md"] }),
    tool("read_next_sync_batch"),
    tool("finish_sync", decision),
  ];
  f.set((res, n) => {
    if (n === 1) assert.deepEqual(latestToolValue(f).segments.map(s => s.path), ["@candidate", a]);
    if (n === 2) assert.deepEqual(latestToolValue(f).segments.map(s => s.path), [b]);
    if (n === 3) {
      const batch = latestToolValue(f);
      assert.deepEqual(batch.segments, []);
      assert.equal(batch.complete, true);
    }
    reply(res, script[n]);
  });
  await f.run({ base: new Map([[a, "# A"], [b, "# B"], ["MEMORY.md", "PRIVATE_SYNC_BATCH"], ["product-knowledge-vault/log.md", "PRIVATE_LOG_BATCH"]]) });
  const payload = JSON.stringify(f.requests);
  assert.ok(!payload.includes("PRIVATE_SYNC_BATCH"));
  assert.ok(!payload.includes("PRIVATE_LOG_BATCH"));
  const controller = new AbortController();
  f.set((res, n) => {
    if (n) controller.abort(new Error("Fixture sync batch cancellation"));
    reply(res, n ? tool("read_next_sync_batch") : tool("finish_sync", plan));
  });
  await assert.rejects(f.run({ base: new Map([[a, "x".repeat(100001)]]), signal: controller.signal }), /sync batch cancellation/);
  assert.equal(f.requests.length, 2);
});

test("normal SYNC batches read replaced sources but do not bypass dependency validation", async (t) => {
  const f = await setup(t), dependent = "product-knowledge-vault/shared/old-dependent.md";
  const plan = {
    ...decision, action: "update", oldPaths: [existing], newPath: source,
    reviewedPaths: [hub, dependent],
  };
  const script = [
    tool("write_candidate", { path: hub, text: `# DT610\n${source}` }),
    tool("finish_sync", plan),
    tool("read_next_sync_batch"),
    tool("finish_sync", plan),
    tool("write_candidate", { path: dependent, text: `# Current source\n${source}` }),
    tool("finish_sync", plan),
  ];
  f.set((res, n) => {
    if (n === 2) {
      const missing = latestToolValue(f).requiredReads.map(m => m.path);
      assert.deepEqual(missing, ["@candidate", existing, hub, dependent]);
    }
    if (n === 3) assert.equal(latestToolValue(f).complete, true);
    if (n === 4) {
      const rejected = latestToolValue(f);
      assert.equal(rejected.submitted, false);
      assert.equal(rejected.repairsLeft, 2);
      assert.ok(rejected.problems.includes(`Old source reference remains: ${dependent}`));
    }
    reply(res, script[n]);
  });
  const result = await f.run({ base: new Map([
    [existing, "# Previous revision"], [hub, `# DT610\n${existing}`],
    [dependent, `# Current source\n${existing}`],
  ]) });
  assert.equal(result.decision.action, "update");
  assert.equal(result.staged.get(dependent), `# Current source\n${source}`);
  assert.equal(f.requests.length, script.length);
});

test("UPad tail is supplied automatically and same-turn writes or submissions wait for fresh model review", async (t) => {
  const f = await setup(t);
  const page = "product-knowledge-vault/products/UPad.md";
  const spec = "UPad/specs/current_202601010000/spec.md";
  const added = "UPad/others/fixture_202610240001/updates.md";
  const original = `# UPad\n${spec}\n` + "原".repeat(22000) + "ORIGINAL_TAIL_SENTINEL";
  const candidate = original + "\n" + added;
  const plan = { ...decision, action: "add", products: ["UPad"], newPath: added, reviewedPaths: [page], reason: "Before reading the tail" };
  const fresh = { ...plan, reason: "Revised after reviewing the supplied original tail" };
  let validated = 0;
  f.set((res, n) => {
    if (n === 0) return reply(res, [
      tool("read_candidate_source"), tool("read_knowledge", { path: page }),
      tool("write_candidate", { path: page, text: candidate }),
    ]);
    if (n === 1) return reply(res, [
      tool("finish_sync", plan),
      tool("write_candidate", { path: page, text: "POISON_WRITE" }),
      tool("patch_candidate", { path: page, expectedHash: hash(candidate), replacements: [{ before: "# UPad", after: "POISON_PATCH" }] }),
      tool("finish_sync", plan),
      tool("read_knowledge", { path: "MEMORY.md" }),
    ]);
    if (n === 2) {
      const results = f.requests.at(-1).messages.filter(m => m.role === "tool").slice(-5)
        .map(m => JSON.parse(m.content));
      assert.equal(results[0].segments.length, 1);
      assert.equal(results[0].segments[0].offset, 20000);
      assert.equal(results[0].segments[0].text, original.slice(20000));
      assert.equal(results[0].segments[0].hash, hash(original));
      for (const r of results) {
        assert.equal(r.phase, "review_required");
        assert.equal(r.submitted, false);
        assert.equal(r.requestedToolExecuted, false);
      }
      for (const r of results.slice(1)) assert.deepEqual(r.segments, []);
      assert.equal(validated, 0);
      return reply(res, tool("read_knowledge", { path: page, candidate: true }));
    }
    assert.equal(latestToolValue(f).text, candidate.slice(0, 20000));
    reply(res, tool("finish_sync", fresh));
  });
  const result = await f.run({
    base: new Map([[page, original], [spec, "# Independent specs"], ["MEMORY.md", "PRIVATE_PHASE_MEMORY"]]),
    validate: async d => { validated++; assert.equal(d.reason, fresh.reason); },
  });
  assert.equal(validated, 1);
  assert.equal(result.decision.reason, fresh.reason);
  assert.equal(result.staged.get(page), candidate);
  assert.equal(f.requests.length, 4);
  assert.ok(!JSON.stringify(f.requests).includes("PRIVATE_PHASE_MEMORY"));
});

test("read phase cannot accept an old proposal after missing fresh submission or hide an upstream error", async (t) => {
  const f = await setup(t);
  const base = new Map([[hub, `# DT610\n${existing}`], [existing, "# Specs"]]);
  const plan = { ...decision, action: "add", newPath: source, reviewedPaths: [hub] };
  const initial = [
    tool("write_candidate", { path: hub, text: `# DT610\n${existing}\n${source}` }),
    tool("finish_sync", plan),
  ];
  f.set((res, n) => reply(res, n ? null : initial));
  await assert.rejects(f.run({ base }), /without a structured decision/);
  assert.equal(f.requests.length, 2);
  f.set((res, n) => n ? httpError(res, 402) : reply(res, initial));
  await assert.rejects(f.run({ base, markdown: "x".repeat(100001) }), /Fixture upstream HTTP 402/);
  assert.equal(f.requests.length, 2);
});

test("automatic read progress does not reset genuine plan rejection counters", async (t) => {
  const f = await setup(t);
  const plan = { ...decision, action: "add", newPath: source, reviewedPaths: [hub] };
  const script = [
    tool("finish_sync", decision),
    tool("write_candidate", { path: hub, text: `# DT610\n${existing}\n${source}` }),
    tool("finish_sync", plan), // Original delivery, not plan acceptance or a counter reset.
    tool("finish_sync", plan),
  ];
  let validated = 0;
  f.set((res, n) => reply(res, script[n]));
  await assert.rejects(f.run({
    base: new Map([[hub, `# DT610\n${existing}`], [existing, "# Specs"]]),
    validate: async () => { validated++; throw new PlanError(["Fixture unresolved business constraint"]); },
  }), /Fixture unresolved business constraint/);
  assert.equal(validated, 2);
  assert.equal(f.requests.length, 4);
});

function latestToolValue(f) {
  const text = f.requests
    .at(-1)
    .messages.filter((m) => m.role === "tool")
    .at(-1).content;
  return JSON.parse(text.slice(text.indexOf("{")));
}

test("missing knowledge diagnostics distinguish targets and guide recovery through actual publication", async (t) => {
  const f = await setup(t), root = path.join(f.dataDir, "urovo-product-expert");
  for (const [p, text] of [
    [existing, "# Independent specs"],
    [hub, `# DT610\n${existing}`],
    ["product-knowledge-vault/index.md", "[[products/DT610]]"],
  ]) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
  const service = await f.service();
  const missingA = "product-knowledge-vault/products/DT610-old.md";
  const missingB = "products/DT610.md";
  const stagedText = `# DT610\n${existing}\n${source}`;
  const script = [
    tool("read_candidate_source"),
    tool("read_knowledge", { path: missingA }),
    tool("read_knowledge", { path: missingB }),
    tool("read_knowledge", { path: missingB, candidate: true }),
    null,
    tool("product_hubs", { products: ["DT610"] }),
    tool("read_knowledge", { path: hub, candidate: true }),
    null,
    tool("write_candidate", { path: hub, text: stagedText }),
    tool("read_knowledge", { path: hub, candidate: true }),
    tool("finish_sync", {
      ...decision, action: "add", newPath: source, reviewedPaths: [hub],
    }),
  ];
  f.set((res, n) => {
    if ([2, 3, 4].includes(n)) {
      const e = latestToolValue(f);
      assert.equal(e.code, "KNOWLEDGE_NOT_FOUND");
      assert.equal(e.path, n === 2 ? missingA : missingB);
      assert.equal(e.requestedView, n === 4 ? "candidate" : "original");
      assert.equal(e.originalExists, false);
      assert.equal(e.candidateExists, false);
      assert.equal(e.nextRead, null);
      assert.deepEqual(e.nextTools[1], { tool: "list_knowledge", args: { offset: 0 } });
      if (n === 4) return reply(res, tool(e.nextTools[0].tool, e.nextTools[0].args));
    }
    if (n === 5) assert.ok(latestToolValue(f).matches.some(m => m.path === hub));
    if (n === 6) assert.deepEqual(latestToolValue(f).hubs, [{ product: "DT610", path: hub, exists: true }]);
    if (n === 7) {
      const e = latestToolValue(f);
      assert.equal(e.path, hub);
      assert.equal(e.requestedView, "candidate");
      assert.equal(e.originalExists, true);
      assert.equal(e.candidateExists, false);
      assert.deepEqual(e.nextRead, {
        tool: "read_knowledge", args: { path: hub, candidate: false, offset: 0 },
      });
      assert.deepEqual(e.nextTools, []);
      return reply(res, tool(e.nextRead.tool, e.nextRead.args));
    }
    if (n === 8) assert.equal(latestToolValue(f).text, `# DT610\n${existing}`);
    if (n === 10) assert.equal(latestToolValue(f).text, stagedText);
    reply(res, script[n]);
  });
  const upload = await service.upload("missing-page-recovery.md", (async function* () {
    yield Buffer.from("Fixture source");
  })());
  const report = await done(service, (await service.start([upload.id])).id);
  assert.equal(report.items[0].status, "published", report.items[0].reason);
  assert.equal(f.requests.length, script.length);
  assert.equal(await fs.readFile(path.join(root, source), "utf8"), "Fixture source");
  assert.equal(await fs.readFile(path.join(root, existing), "utf8"), "# Independent specs");
  assert.equal(await fs.readFile(path.join(root, hub), "utf8"), stagedText);
  for (const p of [missingA, missingB])
    await assert.rejects(fs.stat(path.join(root, p)), { code: "ENOENT" });
});

test("same missing target stops after two errors even when offset or default-view spelling changes", async (t) => {
  const f = await setup(t);
  f.set((res, n) => reply(res, tool("read_knowledge", {
    path: hub, ...(n ? { candidate: false, offset: 20000 } : {}),
  })));
  await assert.rejects(f.run(), e => {
    const d = JSON.parse(e.message.slice(e.message.indexOf("{")));
    assert.equal(d.code, "KNOWLEDGE_NOT_FOUND");
    assert.equal(d.path, hub);
    assert.equal(d.requestedView, "original");
    assert.equal(d.requestedOffset, 20000);
    return true;
  });
  assert.equal(f.requests.length, 2);
});

test("missing-target stop rules also apply within one sequential tool batch", async (t) => {
  const f = await setup(t);
  f.set(res => reply(res, [
    tool("read_knowledge", { path: hub }),
    tool("read_knowledge", { path: hub, candidate: true }),
    tool("read_knowledge", { path: "product-knowledge-vault/shared/missing.md" }),
    tool("finish_sync", decision),
  ]));
  assert.equal((await f.run()).decision.action, "review");
  assert.equal(f.requests.length, 1);
  f.set(res => reply(res, [
    tool("read_knowledge", { path: hub }),
    tool("read_knowledge", { path: hub, offset: 20000 }),
    tool("finish_sync", decision),
  ]));
  await assert.rejects(f.run(), /KNOWLEDGE_NOT_FOUND/);
  assert.equal(f.requests.length, 1);
});

test("successful reads reset missing-target errors; original and staged read semantics remain unchanged", async (t) => {
  const f = await setup(t), original = "# Original", staged = "# Candidate";
  const missing = "product-knowledge-vault/shared/missing.md";
  const fresh = "product-knowledge-vault/shared/fresh.md";
  const script = [
    tool("read_knowledge", { path: missing }),
    tool("read_knowledge", { path: hub }),
    tool("read_knowledge", { path: missing }),
    tool("write_candidate", { path: hub, text: staged }),
    tool("read_knowledge", { path: hub }),
    tool("write_candidate", { path: fresh, text: staged }),
    tool("read_knowledge", { path: fresh }),
    tool("finish_sync", decision),
  ];
  f.set((res, n) => {
    if ([2, 5].includes(n)) assert.equal(latestToolValue(f).text, original);
    if (n === 7) assert.equal(latestToolValue(f).text, staged);
    reply(res, script[n]);
  });
  await f.run({ base: new Map([[hub, original]]) });
  assert.equal(f.requests.length, script.length);
});

test("distinct missing paths still hit the unchanged overall request budget", async (t) => {
  const f = await setup(t);
  f.set((res, n) => reply(res, tool("read_knowledge", {
    path: `product-knowledge-vault/products/missing-${n}.md`,
  })));
  await assert.rejects(f.run({}, 4), /budget exceeded \(4\/4 request attempts\)/);
  assert.equal(f.requests.length, 4);
});

test("candidate reads still require backend original delivery and protected-path availability stays private", async (t) => {
  const f = await setup(t);
  const script = [
    tool("read_candidate_source"),
    tool("read_knowledge", { path: hub, candidate: true }),
    tool("write_candidate", { path: hub, text: `# DT610\n${existing}\n${source}` }),
    tool("read_knowledge", { path: hub, candidate: true }),
    tool("finish_sync", { ...decision, action: "add", newPath: source, reviewedPaths: [hub] }),
    tool("finish_sync", { ...decision, action: "add", newPath: source, reviewedPaths: [hub] }),
  ];
  f.set((res, n) => {
    if (n === 5) {
      const batch = latestToolValue(f);
      assert.equal(batch.submitted, false);
      assert.equal(batch.phase, "review_required");
      assert.equal(batch.segments[0].path, hub);
      assert.equal(batch.segments[0].text, `# DT610\n${existing}`);
    }
    reply(res, script[n]);
  });
  assert.equal((await f.run({ base: new Map([[hub, `# DT610\n${existing}`], [existing, "# Spec"]]) })).decision.action, "add");
  assert.equal(f.requests.length, script.length);
  const secret = "PRIVATE_READ_SENTINEL";
  for (const p of ["MEMORY.md", "product-knowledge-vault/MEMORY.md", "../private.md", "/tmp/private.md", "newly_added/private.md"]) {
    f.set((res, n) => reply(res, n ? tool("finish_sync", decision) : tool("read_knowledge", { path: p, candidate: true })));
    await f.run({ base: new Map([[p, secret]]) });
    const payload = JSON.stringify(f.requests.flatMap(r => r.messages.filter(m => m.role === "tool")));
    assert.ok(!payload.includes(secret));
    assert.ok(!payload.includes(hash(secret)));
    assert.ok(!payload.includes("originalExists"));
    assert.ok(!payload.includes("candidateExists"));
  }
});

test("patch diagnostics distinguish absent, repeated, overlapping, stale, missing and sequential-batch failures without saving partial edits", async (t) => {
  const f = await setup(t);
  const cases = [
    {
      name: "absent",
      text: "# 中文\n正确文字\n",
      before: "不存在的文字",
      code: "PATCH_NO_MATCH",
      count: 0,
    },
    {
      name: "repeated",
      text: "# 中文\n" + "重复片段\n".repeat(12),
      before: "重复片段",
      code: "PATCH_MULTIPLE_MATCHES",
      count: 12,
    },
    {
      name: "overlapping",
      text: "aaa",
      before: "aa",
      code: "PATCH_MULTIPLE_MATCHES",
      count: 2,
    },
    {
      name: "stale",
      text: "# Current original",
      before: "Current",
      code: "PATCH_BASELINE_CONFLICT",
      stale: true,
    },
    {
      name: "missing",
      text: undefined,
      before: "none",
      code: "PATCH_FILE_NOT_FOUND",
      stale: true,
    },
    {
      name: "sequential",
      text: "# Alpha\n",
      before: "absent",
      code: "PATCH_NO_MATCH",
      count: 0,
      sequential: true,
    },
  ];
  for (const c of cases)
    await t.test(c.name, async () => {
      const replacements = [
        ...(c.sequential ? [{ before: "Alpha", after: "Beta" }] : []),
        { before: c.before, after: "CHANGED" },
      ];
      const base = new Map(c.text === undefined ? [] : [[hub, c.text]]);
      const calls = [
        tool("patch_candidate", {
          path: hub,
          expectedHash: c.stale ? "0".repeat(64) : hash(c.text),
          replacements,
        }),
        tool("read_knowledge", { path: hub }),
        tool("finish_sync", decision),
      ];
      f.set((res, n) => {
        if (n === 1) {
          const diagnostic = latestToolValue(f);
          assert.equal(diagnostic.path, hub);
          assert.equal(diagnostic.code, c.code);
          assert.equal(diagnostic.currentView, "original");
          assert.equal(
            diagnostic.currentHash,
            c.text === undefined ? null : hash(c.text),
          );
          assert.equal(diagnostic.stagedUnchanged, true);
          if (!c.stale) {
            assert.equal(diagnostic.replacementIndex, c.sequential ? 2 : 1);
            assert.equal(diagnostic.matchCount, c.count);
            assert.equal(
              diagnostic.matchBasis,
              c.sequential
                ? "temporary_text_after_earlier_replacements"
                : "current_view",
            );
            assert.ok(diagnostic.locations.length <= 8);
            assert.equal(diagnostic.locationsTruncated, c.count > 8);
            if (c.count > 0) {
              const loc = diagnostic.locations[0];
              const at = c.text.indexOf(c.before);
              assert.equal(loc.offset, at);
              assert.equal(loc.line, c.text.slice(0, at).split("\n").length);
              assert.equal(loc.readOffset, Math.floor(at / 20000) * 20000);
            }
          }
          if (c.text !== undefined)
            assert.deepEqual(diagnostic.nextRead, {
              path: hub,
              candidate: false,
              offset: 0,
            });
          else assert.equal(diagnostic.nextRead, null);
        }
        if (n === 2 && c.text !== undefined)
          assert.equal(latestToolValue(f).text, c.text);
        reply(res, calls[n]);
      });
      const result = await f.run({ base });
      assert.equal(result.staged.size, 0);
      if (c.text !== undefined) assert.equal(base.get(hub), c.text);
    });
});

test("already-staged patch failure points to the current candidate and its exact segment, then a unique repair succeeds", async (t) => {
  const f = await setup(t);
  const original = "# Original";
  const candidate =
    "# Candidate\n" + "前".repeat(21000) + "\nLEFT repeat\nRIGHT repeat\n";
  const fixed = candidate.replace("RIGHT repeat", "RIGHT changed");
  const calls = [
    tool("write_candidate", { path: hub, text: candidate }),
    tool("patch_candidate", {
      path: hub,
      expectedHash: hash(candidate),
      replacements: [{ before: "repeat", after: "changed" }],
    }),
    tool("read_knowledge", { path: hub, candidate: true, offset: 20000 }),
    tool("patch_candidate", {
      path: hub,
      expectedHash: hash(candidate),
      replacements: [{ before: "RIGHT repeat", after: "RIGHT changed" }],
    }),
    tool("read_knowledge", { path: hub, candidate: true, offset: 20000 }),
    tool("finish_sync", decision),
  ];
  f.set((res, n) => {
    if (n === 2) {
      const d = latestToolValue(f);
      assert.equal(d.code, "PATCH_MULTIPLE_MATCHES");
      assert.equal(d.currentView, "candidate");
      assert.equal(d.currentHash, hash(candidate));
      assert.deepEqual(d.nextRead, {
        path: hub,
        candidate: true,
        offset: 20000,
      });
      assert.equal(d.matchCount, 2);
    }
    if (n === 3)
      assert.equal(latestToolValue(f).text, candidate.slice(20000, 40000));
    if (n === 5)
      assert.equal(latestToolValue(f).text, fixed.slice(20000, 40000));
    reply(res, calls[n]);
  });
  const result = await f.run({ base: new Map([[hub, original]]) });
  assert.equal(result.staged.get(hub), fixed);
  assert.equal(f.requests.length, calls.length);
});

test("patch diagnostics retain repeated-error termination and do not reveal protected text or hashes", async (t) => {
  const f = await setup(t),
    text = "# Repeated";
  const bad = tool("patch_candidate", {
    path: hub,
    expectedHash: hash(text),
    replacements: [{ before: "MISSING", after: "x" }],
  });
  f.set((res) => reply(res, bad));
  await assert.rejects(
    f.run({ base: new Map([[hub, text]]) }),
    /PATCH_NO_MATCH/,
  );
  assert.equal(f.requests.length, 2);
  const privateText = "PRIVATE_PATCH_SENTINEL";
  const protectedPaths = [
    "MEMORY.md",
    "product-knowledge-vault/MEMORY.md",
    "product-knowledge-vault/log.md",
    "DT610/specs/test_202610230001/x.md",
  ];
  for (const p of protectedPaths) {
    f.set((res, n) =>
      reply(
        res,
        n === 0
          ? tool("patch_candidate", {
              path: p,
              expectedHash: "0".repeat(64),
              replacements: [{ before: "PRIVATE", after: "x" }],
            })
          : tool("finish_sync", decision),
      ),
    );
    await f.run({ base: new Map([[p, privateText]]) });
    const payload = JSON.stringify(f.requests);
    assert.ok(!payload.includes(privateText));
    assert.ok(!payload.includes(hash(privateText)));
    assert.ok(!payload.includes('"currentHash"'));
  }
});

test("failed exact patch can be repaired through a real deletion preview; no deletion occurs until confirmation", async (t) => {
  const f = await setup(t),
    root = path.join(f.dataDir, "urovo-product-expert");
  const original = `# DT610\n${existing}\n${source}\nKEEP INDEPENDENT FACTS\n`;
  for (const [p, text] of [
    [source, "# Source to retire"],
    [existing, "# Independent specs"],
    [hub, original],
    ["product-knowledge-vault/index.md", "[[products/DT610|DT610]]"],
  ]) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
  const service = await f.service();
  const calls = [
    tool("source_dependents", { paths: [source] }),
    tool("read_next_deletion_batch"),
    tool("patch_candidate", {
      path: hub,
      expectedHash: hash(original),
      replacements: [{ before: "HALLUCINATED OLD LINK", after: "" }],
    }),
    tool("read_knowledge", { path: hub }),
    tool("patch_candidate", {
      path: hub,
      expectedHash: hash(original),
      replacements: [{ before: source + "\n", after: "" }],
    }),
    tool("finish_sync", {
      ...decision,
      action: "delete",
      oldPaths: [source],
      reviewedPaths: [hub],
    }),
  ];
  f.set((res, n) => {
    if (n === 3) {
      const d = latestToolValue(f);
      assert.equal(d.code, "PATCH_NO_MATCH");
      assert.deepEqual(d.nextRead, { path: hub, candidate: false, offset: 0 });
    }
    reply(res, calls[n]);
  });
  const preview = await done(
    service,
    (await service.preview("Delete only the fixture source")).id,
  );
  assert.equal(
    preview.status,
    "awaiting_confirmation",
    preview.items[0].reason,
  );
  assert.equal(await fs.readFile(path.join(root, hub), "utf8"), original);
  assert.equal(
    await fs.readFile(path.join(root, source), "utf8"),
    "# Source to retire",
  );
  assert.equal(f.requests.length, calls.length);
  const confirmed = await done(service, (await service.confirm(preview.id)).id);
  assert.equal(confirmed.items[0].status, "deleted", confirmed.items[0].reason);
  await assert.rejects(fs.stat(path.join(root, source)), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(root, hub), "utf8"),
    original.replace(source + "\n", ""),
  );
  assert.equal(
    await fs.readFile(path.join(root, existing), "utf8"),
    "# Independent specs",
  );
  assert.equal(f.requests.length, calls.length);
});

test("WeCom receives allowed slots and can repair an invented project-matrix slot into a valid shared source", async (t) => {
  const f = await setup(t);
  const wecom = {
    docid: "e3_project_fixture",
    id: "pos",
    title: "项目对应各部门关系表",
    sectionTitle: "POS项目清单",
    version: "1",
    inputHash: hash("Fixture source"),
    contentHash: hash("Fixture content"),
    indexPath: "product-knowledge-vault/shared/project-fixture.md",
    inventory: [
      { id: "pos", title: "POS项目清单", contentHash: hash("Fixture content") },
    ],
  };
  const allowed = [
    "accessories",
    "specs",
    "brochure",
    "presentation",
    "user_guide",
    "others",
  ];
  assert.deepEqual(JSON.parse(hint(wecom)).allowedSlots, allowed);
  const base = new Map([
    [existing, "# Existing specs"],
    [hub, `# DT610\n${existing}`],
    ["product-knowledge-vault/index.md", "[[products/DT610|DT610]]"],
  ]);
  const wrong = {
    ...decision,
    action: "add",
    slot: "project-matrix",
    newPath: `_shared/project-matrix/wecom-${sourceKey(wecom.docid, wecom.id)}_202610230001/pos.md`,
    reviewedPaths: [hub],
  };
  const corrected = {
    ...wrong,
    slot: "others",
    newPath: wrong.newPath.replace("/project-matrix/", "/others/"),
  };
  const calls = [
    tool("read_candidate_source"),
    tool("write_candidate", {
      path: hub,
      text: `# DT610\n${existing}\n[[shared/project-fixture|Project contacts]]`,
    }),
    tool("finish_sync", wrong), // Automatically deliver the missing Hub first.
    tool("finish_sync", wrong),
    tool("finish_sync", corrected),
  ];
  f.set((res, n) => {
    if (n === 0)
      assert.ok(
        JSON.stringify(f.requests[0].messages).includes("allowedSlots"),
      );
    if (n === 3) {
      const reading = latestToolValue(f);
      assert.equal(reading.phase, "review_required");
      assert.equal(reading.submitted, false);
      assert.deepEqual(reading.segments.map(s => s.path), [hub]);
    }
    if (n === 4) {
      const e = latestToolValue(f);
      assert.equal(e.submitted, false);
      assert.match(
        e.problems.join("\n"),
        /Unsupported WeCom slot "project-matrix"/,
      );
      assert.match(
        e.problems.join("\n"),
        /Allowed slots: accessories, specs, brochure, presentation, user_guide, others/,
      );
      assert.ok(
        !e.problems.join("\n").includes("must use _shared/project-matrix"),
      );
    }
    reply(res, calls[n]);
  });
  const result = await f.run({ base, wecom });
  assert.equal(result.decision.slot, "others");
  assert.equal(result.decision.newPath, corrected.newPath);
  assert.equal(f.requests.length, calls.length);
  assert.deepEqual(
    [...base.keys()],
    [existing, hub, "product-knowledge-vault/index.md"],
  );
});

test("invalid source offsets return an executable next read and normal SYNC can finish after exact continuation", async (t) => {
  const f = await setup(t),
    markdown = "中文".repeat(20001);
  const base = new Map([
    [existing, "# Independent specs"],
    [hub, `# DT610\n${existing}`],
  ]);
  for (const badOffset of [123, 60000])
    await t.test(String(badOffset), async () => {
      const calls = [
        tool("read_candidate_source"),
        tool("read_candidate_source", { offset: badOffset }),
        null,
        tool("read_candidate_source", { offset: 40000 }),
        tool("read_knowledge", { path: hub }),
        tool("write_candidate", {
          path: hub,
          text: `# DT610\n${existing}\n${source}\nConverted; original removed after successful sync`,
        }),
        tool("finish_sync", {
          ...decision,
          action: "add",
          newPath: source,
          reviewedPaths: [hub],
        }),
      ];
      f.set((res, n) => {
        if (n === 2) {
          const d = latestToolValue(f);
          assert.equal(d.code, "INVALID_READ_OFFSET");
          assert.equal(d.requestedOffset, badOffset);
          assert.equal(d.totalCharacters, markdown.length);
          assert.equal(d.nextOffset, 20000);
          assert.equal(d.complete, false);
          assert.deepEqual(d.nextRead, {
            tool: "read_candidate_source",
            args: { offset: 20000 },
          });
          return reply(res, tool(d.nextRead.tool, d.nextRead.args));
        }
        if (n === 3) {
          const segment = latestToolValue(f);
          assert.equal(segment.offset, 20000);
          assert.equal(segment.nextOffset, 40000);
          assert.equal(segment.text, markdown.slice(20000, 40000));
        }
        reply(res, calls[n]);
      });
      const result = await f.run({ base, markdown });
      assert.equal(result.decision.action, "add");
      assert.equal(f.requests.length, calls.length);
    });
});

test("invalid offsets preserve original, candidate and batch view identities; completed views do not invent further reads", async (t) => {
  const f = await setup(t),
    text = "x".repeat(20001);
  const cases = [
    {
      call: tool("read_knowledge", { path: hub }),
      next: {
        tool: "read_knowledge",
        args: { path: hub, candidate: false, offset: 20000 },
      },
    },
    {
      call: tool("read_knowledge", { path: hub, candidate: true }),
      stage: true,
      next: {
        tool: "read_knowledge",
        args: { path: hub, candidate: true, offset: 20000 },
      },
    },
    {
      call: tool("read_batch_source", { id: "batch-fixture" }),
      next: {
        tool: "read_batch_source",
        args: { id: "batch-fixture", offset: 20000 },
      },
    },
  ];
  for (const c of cases)
    await t.test(c.next.tool + JSON.stringify(c.next.args), async () => {
      const script = [
        ...(c.stage ? [tool("write_candidate", { path: hub, text })] : []),
        c.call,
        tool(c.call.name, { ...c.call.args, offset: 20001 }),
        null,
        tool(c.call.name, { ...c.call.args, offset: 20001 }),
        tool("finish_sync", decision),
      ];
      const errorStep = c.stage ? 3 : 2;
      f.set((res, n) => {
        if (n === errorStep) {
          const e = latestToolValue(f);
          assert.equal(e.code, "INVALID_READ_OFFSET");
          assert.deepEqual(e.nextRead, c.next);
          return reply(res, tool(e.nextRead.tool, e.nextRead.args));
        }
        if (n === errorStep + 2) {
          const e = latestToolValue(f);
          assert.equal(e.code, "INVALID_READ_OFFSET");
          assert.equal(e.complete, true);
          assert.equal(e.nextOffset, null);
          assert.equal(e.nextRead, null);
        }
        reply(res, script[n]);
      });
      await f.run({
        base: new Map([[hub, c.stage ? "# Original" : text]]),
        candidates: new Map([["batch-fixture", text]]),
      });
      assert.equal(f.requests.length, script.length);
    });
});

test("maintenance prompt separates current decision from history and finish accepts explicit company-only WeCom scope", async t => {
  const f = await setup(t);
  const markdown = "# Company qualifications\nQ2020132 — enterprise only; no product applicability";
  const docid = "e3_company_scope", id = "other";
  const wecom = {
    docid, id, title: "Company qualifications", sectionTitle: "Other", version: "1",
    inputHash: hash(markdown), contentHash: hash("receipt"),
    inventory: [{ id, title: "Other", contentHash: hash("receipt") }],
    indexPath: "product-knowledge-vault/shared/company-qualifications.md", slot: "others",
  };
  const d = { ...decision, action: "add", sourceScope: "organization", products: [],
    newPath: `_shared/others/wecom-${sourceKey(docid, id)}_202610242210/other.md`,
    reason: "Administrator approved company-only publication; no product Hub is affected" };
  f.set((res, n) => reply(res, n === 0 ? tool("read_candidate_source") : tool("finish_sync", d)));
  const result = await f.run({ markdown, wecom,
    feedback: "Publish company qualifications; do not attach to products",
    feedbackHistory: "Previously: do not publish; later: publish" });
  assert.equal(result.decision.action, "add");
  assert.equal(result.decision.sourceScope, "organization");
  assert.deepEqual(result.decision.products, []);
  assert.equal(f.requests.length, 2, "Successful finish must end immediately");
  const prompt = f.requests[0].messages.map(m => typeof m.content === "string" ? m.content : (m.content ?? []).map(c => c.text ?? "").join("\n")).join("\n");
  assert.match(prompt, /"history":"Previously: do not publish; later: publish","current":"Publish company qualifications; do not attach to products"/);
  assert.match(prompt, /current answer supersedes older answers to the SAME business question/);
  assert.match(prompt, /without asking it again/);
  assert.match(prompt, /tool\/schema failures are technical failures/);
});
