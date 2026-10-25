import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createWebServer } from "../dist/web/server.js";
import { defaults } from "../dist/research/domain.js";
test("research page and API require admin, preserve CSRF/origin, reject machine access, run/stop/export", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-web-"));
  const bridge = "bridge-test-token-".repeat(3);
  const admin = { account: "admin", password: "fixture-password" };
  const settings = {
    ...defaults,
    initialMs: 30,
    checkpointMs: 30,
    maxMs: 500,
    wrapMs: 100,
    reviewMs: 40,
  };
  const engine = {
    ready() {},
    async worker() {
      return {
        async step() {
          await new Promise((r) => setTimeout(r, 40));
        },
        async close() {},
      };
    },
    async review() {
      return { verdicts: [], nextDirections: [], summary: "无候选" };
    },
  };
  const app = await createWebServer({
    cwd: root,
    dataDir: path.join(root, ".data"),
    resourcesDir: path.resolve("resources"),
    admin,
    bridgeToken: bridge,
    model: { apiKey: "", baseUrl: "", modelId: "" },
    research: { engine: () => engine, settings },
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = "http://127.0.0.1:" + app.server.address().port;
  assert.equal(
    (await fetch(base + "/research", { redirect: "manual" })).status,
    302,
  );
  assert.equal((await fetch(base + "/api/research/runs")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/research/runs", {
        headers: { Authorization: "Bearer " + bridge },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/api/wecom/research/runs", {
        headers: { Authorization: "Bearer " + bridge },
      })
    ).status,
    403,
  );
  const token = (await (await fetch(base + "/api/auth/status")).json()).token;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "x-local-token": token, "content-type": "application/json" },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const req = (p, method = "GET", body, headers = {}) =>
    fetch(base + p, {
      method,
      headers: {
        Cookie: cookie,
        "x-local-token": token,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.match(await (await req("/research")).text(), /行业研究/);
  assert.equal(
    (
      await req(
        "/api/research/runs",
        "POST",
        { endDate: "2026-10-24" },
        { "x-local-token": "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await req(
        "/api/research/runs",
        "POST",
        { endDate: "2026-10-24" },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await req("/api/research/runs", "POST", { endDate: "2026-02-30" })).status,
    400,
  );
  assert.equal(
    (
      await req("/api/research/runs", "POST", {
        endDate: "2026-10-24",
        systemPrompt: "override",
      })
    ).status,
    400,
  );
  const response = await req("/api/research/runs", "POST", {
    endDate: "2026-10-24",
  });
  assert.equal(response.status, 202);
  const run = await response.json();
  assert.equal(run.days[0], "2026-10-11");
  assert.ok(!("background" in run));
  assert.equal(
    (await req("/api/research/runs", "POST", { endDate: "2026-10-24" })).status,
    409,
  );
  assert.equal(
    (await req("/api/research/runs/" + run.id + "/stop", "POST", {})).status,
    200,
  );
  const browse = await (
    await req("/api/research/items?endDate=2026-10-24&days=14")
  ).json();
  assert.equal(browse.coverage.length, 14);
  assert.equal(browse.coverage[0].scenes.length, 7);
  const exp = await req("/api/research/export?endDate=2026-10-24&days=7");
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get("content-type"), /markdown/);
  assert.match(await exp.text(), /2026-10-18/);
  assert.equal((await req("/api/research/items?days=999")).status, 400);
});
