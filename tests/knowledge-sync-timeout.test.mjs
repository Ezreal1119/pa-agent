import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCanvas } from "@napi-rs/canvas";
import { createConverter } from "../dist/knowledge-sync/converter.js";
import { fileToolConfig } from "../dist/file-tools/config.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";

function respond(res, text = "Complete fixture evidence", content = {}) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              complete: true,
              text,
              issues: [],
              ...content,
            }),
          },
        },
      ],
    }),
  );
}
async function fixture(
  t,
  handler,
  { width = 100, budget = 128, acquire } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-vision-timeout-"));
  const labels = [];
  const server = createServer(async (req, res) => {
    let json = "";
    for await (const chunk of req) json += chunk;
    const body = JSON.parse(json);
    labels.push(body.messages[1].content[0].text);
    handler(req, res, labels.length);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const source = path.join(root, "fixture.png"),
    work = path.join(root, "attempt-1");
  const canvas = createCanvas(width, 100);
  canvas.getContext("2d").fillRect(0, 0, width, 100);
  await fs.writeFile(source, canvas.toBuffer("image/png"));
  const config = fileToolConfig(
    root,
    {
      timeoutMs: 10000,
      vision: {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKey: "fixture",
        model: "fixture",
        timeoutMs: 120,
      },
    },
    {},
  );
  let acquired = 0,
    released = 0;
  const convert = createConverter(
    config,
    "unused",
    budget,
    acquire ??
      (async () => {
        acquired++;
        return () => {
          released++;
        };
      }),
  );
  const usage = emptyUsage();
  const run = (
    signal = new AbortController().signal,
    dir = work,
    totals = usage,
  ) => convert(source, dir, signal, totals, async () => {});
  return { root, work, labels, usage, run, gates: () => [acquired, released] };
}

test("one vision timeout retries only the unfinished region, accounts attempts and retains complete caches", async (t) => {
  const f = await fixture(
    t,
    (_req, res, call) => {
      if (call !== 2) respond(res, `Evidence call ${call}`);
    },
    { width: 2000 },
  );
  const result = await f.run();
  assert.equal(f.labels.length, 3);
  assert.equal(
    f.labels[1],
    f.labels[2],
    "retry the same region, never skip it",
  );
  assert.notEqual(f.labels[0], f.labels[1]);
  assert.deepEqual(f.usage, {
    input: 20,
    output: 10,
    requests: 3,
    recorded: 2,
  });
  assert.deepEqual(
    f.gates(),
    [3, 3],
    "release the concurrency gate after every attempt",
  );
  assert.match(result.markdown, /Evidence call 1/);
  assert.match(result.markdown, /Evidence call 3/);
  assert.ok(
    result.coverage.some(
      (c) => c.includes("timed out") && c.includes("retrying once"),
    ),
  );
  assert.equal(
    result.coverage.filter((c) => c.endsWith(": inspected")).length,
    2,
  );
  await f.run();
  assert.equal(
    f.labels.length,
    3,
    "complete conversion stays reusable without a version bump",
  );
});

test("two timeouts stop with the region and request limit; Re-Sync resumes complete checkpoints", async (t) => {
  let failing = true;
  const f = await fixture(
    t,
    (_req, res, call) => {
      if (call === 1 || !failing) respond(res, `Evidence call ${call}`);
    },
    { width: 2000 },
  );
  await assert.rejects(
    f.run(),
    /Vision request timed out at Image, region x=200 y=0.*120 ms.*attempt 2\/2/,
  );
  assert.equal(f.labels.length, 3, "at most one retry for a region");
  assert.deepEqual(f.usage, { input: 10, output: 5, requests: 3, recorded: 1 });
  assert.deepEqual(f.gates(), [3, 3]);
  assert.equal(
    await fs.stat(path.join(f.work, "conversion.json")).catch(() => null),
    null,
  );
  const coverage = JSON.parse(
    await fs.readFile(path.join(f.work, "coverage.json"), "utf8"),
  );
  assert.equal(coverage.filter((c) => c.endsWith(": inspected")).length, 1);
  failing = false;
  const next = path.join(f.root, "attempt-2"),
    usage = emptyUsage();
  await fs.cp(f.work, next, { recursive: true });
  const result = await f.run(undefined, next, usage);
  assert.equal(
    f.labels.length,
    4,
    "only the failed region is requested on Re-Sync",
  );
  assert.match(result.markdown, /Evidence call 1/);
  assert.match(result.markdown, /Evidence call 4/);
  assert.deepEqual(usage, { input: 10, output: 5, requests: 1, recorded: 1 });
});

test("timeout while reading the response body also receives only one retry", async (t) => {
  const f = await fixture(t, (_req, res, call) => {
    if (call === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":');
    } else respond(res);
  });
  const result = await f.run();
  assert.match(result.markdown, /Complete fixture evidence/);
  assert.equal(f.labels.length, 2);
  assert.equal(f.usage.requests, 2);
  assert.equal(f.usage.recorded, 1);
});

test("request budget limits include retries and never permit an extra network request", async (t) => {
  const f = await fixture(t, () => {}, { budget: 1 });
  await assert.rejects(
    f.run(),
    /Vision request timed out at Image.*request budget exhausted/,
  );
  assert.equal(f.labels.length, 1);
  assert.equal(f.usage.requests, 1);
  assert.deepEqual(f.gates(), [1, 1]);
});

test("file deadline and explicit cancellation interrupt vision without retrying", async (t) => {
  for (const [name, expected] of [
    ["TimeoutError", /SYNC file deadline exceeded at Image/],
    ["AbortError", /Vision conversion cancelled at Image/],
  ]) {
    await t.test(name, async (t) => {
      const controller = new AbortController();
      const f = await fixture(t, () =>
        controller.abort(new DOMException("Fixture abort", name)),
      );
      await assert.rejects(f.run(controller.signal), expected);
      assert.equal(f.labels.length, 1);
      assert.deepEqual(f.gates(), [1, 1]);
    });
  }
});

test("file deadline while waiting for the model gate gives a region and starts no request", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, () => assert.fail("no request expected"), {
    acquire: async () => {
      controller.abort(new DOMException("Fixture deadline", "TimeoutError"));
      throw controller.signal.reason;
    },
  });
  await assert.rejects(
    f.run(controller.signal),
    /SYNC file deadline exceeded at Image/,
  );
  assert.equal(f.labels.length, 0);
  assert.equal(f.usage.requests, 0);
});

test("HTTP errors, network failures and incomplete evidence do not get timeout retries", async (t) => {
  const cases = [
    [
      "HTTP 400",
      (_req, res) => {
        res.writeHead(400);
        res.end("bad image");
      },
      /Vision HTTP 400/,
    ],
    [
      "HTTP 401",
      (_req, res) => {
        res.writeHead(401);
        res.end("unauthorized");
      },
      /Vision HTTP 401/,
    ],
    [
      "HTTP 503",
      (_req, res) => {
        res.writeHead(503);
        res.end("unavailable");
      },
      /Vision HTTP 503/,
    ],
    ["network", (req) => req.socket.destroy(), /fetch failed/],
    [
      "incomplete",
      (_req, res) =>
        respond(res, "", { complete: false, issues: ["unreadable"] }),
      /Unresolved visual evidence/,
    ],
  ];
  for (const [name, handler, expected] of cases)
    await t.test(name, async (t) => {
      const f = await fixture(t, handler);
      await assert.rejects(f.run(), expected);
      assert.equal(f.labels.length, 1);
      assert.deepEqual(f.gates(), [1, 1]);
      assert.equal(
        await fs.stat(path.join(f.work, "conversion.json")).catch(() => null),
        null,
      );
    });
});
