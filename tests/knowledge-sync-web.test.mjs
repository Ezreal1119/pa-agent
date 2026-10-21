import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createWebServer } from "../dist/web/server.js";
import { hash, emptyUsage } from "../dist/knowledge-sync/core.js";

test("maintenance HTTP is administrator-only, enforces Origin/CSRF, persists reports, serves a standalone page", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-web-"));
  let app;
  const options = {
    cwd: root,
    dataDir: path.join(root, ".data"),
    resourcesDir: path.resolve("resources"),
    admin: { account: "admin", password: "fixture-password" },
    bridgeToken: "bridge-fixture-key-01234567890123456789",
    mcp: { apiKey: "mcp-fixture-key-01234567890123456789" },
    fileTools: { maxFileBytes: 30 * 1048576 },
    model: {modelId: "deepseek-flash"},
    sync: {
      converter: () => async (source) => ({
        markdown: await fs.readFile(source, "utf8"),
        sourceHash: hash(await fs.readFile(source)),
        coverage: ["Fixture complete"],
        version: 1,
        visual: emptyUsage(),
      }),
      planner: () => async () => ({
        decision: {
          action: "review",
          reason: "新产品需确认",
          summary: "等待人工反馈",
          suggestedFeedback: "这是新产品 T5000，允许创建产品目录，并创建产品 Hub、更新相关索引。",
          products: [],
          slot: "",
          oldPaths: [],
          versionEvidence: "",
          authorizedException: false,
          reviewedPaths: [],
        },
        staged: new Map(),
      }),
    },
  };
  t.after(async () => {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function start() {
    app = await createWebServer(options);
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let url = await start();
  let token = (await (await fetch(url + "/api/auth/status")).json()).token;
  assert.equal(
    (await fetch(url + "/synchronize", { redirect: "manual" })).status,
    302,
  );
  for (const key of [
    "bridge-fixture-key-01234567890123456789",
    "mcp-fixture-key-01234567890123456789",
  ])
    assert.equal(
      (
        await fetch(url + "/api/sync/jobs", {
          headers: { Authorization: `Bearer ${key}` },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await fetch(url + "/api/wecom/sync/jobs", {
        headers: {
          Authorization: "Bearer bridge-fixture-key-01234567890123456789",
        },
      })
    ).status,
    403,
  );
  let res = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": token },
    body: JSON.stringify(options.admin),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const request = (p, method = "GET", body, extra = {}) =>
    fetch(url + p, {
      method,
      headers: {
        Cookie: cookie,
        "x-local-token": token,
        "content-type": "application/json",
        ...extra,
      },
      body,
    });
  assert.match(await (await request("/synchronize")).text(), /Incoming files/);
  assert.equal((await request("/synchronize.css")).status, 200);
  assert.equal(
    (await (await request("/api/sync/incoming")).json()).maxFileBytes,
    100 * 1048576,
  );
  assert.equal(
    (await (await request("/api/status")).json()).fileTools.maxFileBytes,
    30 * 1048576,
  );
  const ignored = await request(
    "/api/sync/incoming?name=README.md",
    "POST",
    "# Directory instructions",
  );
  assert.equal(ignored.status, 200);
  assert.equal((await ignored.json()).ignored, true);
  const inbox = path.join(root, ".data/urovo-product-expert/newly_added");
  await fs.mkdir(path.join(inbox, "nested"), { recursive: true });
  await fs.writeFile(path.join(inbox, "README.md"), "Keep directory guide");
  await fs.writeFile(path.join(inbox, "nested", "ReadMe.MD"), "Nested guide");
  assert.deepEqual(
    (await (await request("/api/sync/incoming")).json()).files,
    [],
  );
  res = await request(
    "/api/sync/incoming?name=large.pdf",
    "POST",
    Buffer.alloc(31 * 1048576, 0x41),
    { "content-type": "application/octet-stream" },
  );
  assert.equal(res.status, 201);
  assert.equal((await res.json()).bytes, 31 * 1048576);
  await fs.unlink(path.join(inbox, "large.pdf"));

  assert.equal(
    (
      await request("/api/sync/incoming?name=a.md", "POST", "text", {
        "x-local-token": "",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/sync/incoming?name=a.md", "POST", "text", {
        Origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/sync/incoming?name=..%2Fescape.md", "POST", "text"))
      .status,
    400,
  );
  res = await request(
    "/api/sync/incoming?name=a.md",
    "POST",
    "# Test\nNew product",
  );
  assert.equal(res.status, 201);
  const uploaded = await res.json();
  const another = await (
    await request("/api/sync/incoming?name=a.md", "POST", "# Second")
  ).json();
  assert.notEqual(another.name, uploaded.name);
  res = await request(
    "/api/sync/jobs",
    "POST",
    JSON.stringify({ ids: [uploaded.id] }),
  );
  assert.equal(res.status, 202);
  const id = (await res.json()).id;
  let job;
  for (let n = 0; n < 100; n++) {
    job = await (await request("/api/sync/jobs/" + id)).json();
    if (job.status === "completed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(job.items[0].status, "needs_review");
  assert.equal(job.items[0].model, "deepseek-flash");
  assert.equal((await (await request("/api/status")).json()).model.modelId, "deepseek-flash");
  await app.close();
  url = await start();
  token = (await (await fetch(url + "/api/auth/status")).json()).token;
  res = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": token },
    body: JSON.stringify(options.admin),
  });
  const freshCookie = res.headers.get("set-cookie").split(";")[0];
  const persisted = await (
    await request("/api/sync/jobs/" + id, "GET", undefined, {
      Cookie: freshCookie,
    })
  ).json();
  assert.equal(persisted.items[0].reason, "新产品需确认");
  assert.equal(
    persisted.items[0].plan.decision.suggestedFeedback,
    (await options.sync.planner()()).decision.suggestedFeedback,
  );
  assert.equal(persisted.items[0].feedback, "");
  assert.equal(
    (
      await fs.readdir(
        path.join(root, ".data/urovo-product-expert/newly_added"),
      )
    ).length,
    4,
  );
});
