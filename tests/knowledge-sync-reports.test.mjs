import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { SyncService } from "../dist/knowledge-sync/service.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";
import { createWebServer } from "../dist/web/server.js";
function report() {
  return {
    id: randomUUID(),
    kind: "sync",
    created: new Date().toISOString(),
    status: "completed",
    items: [
      {
        id: randomUUID(),
        name: "fixture.md",
        sourceHash: "0".repeat(64),
        bytes: 1,
        status: "published",
        stage: "Published",
        feedback: "",
        textUsage: emptyUsage(),
        visualUsage: emptyUsage(),
        coverage: ["all lines checked"],
        wecom: { privateSnapshot: "not for polling" },
        plan: {
          baseline: "fixture",
          decision: {
            products: ["RT30"],
            slot: "accessories",
            action: "add",
            reason: "verified",
          },
          changes: [
            {
              path: "RT30/accessories/file.md",
              before: null,
              after: "body\n".repeat(200000),
            },
            {
              path: "product-knowledge-vault/products/RT30.md",
              before: "original",
              after: "updated",
            },
          ],
        },
      },
    ],
  };
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-report-"));
  const job = report();
  const folder = path.join(dir, "knowledge-sync/jobs");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, job.id + ".json"), JSON.stringify(job));
  let service;
  function make() {
    return new SyncService({
      dataDir: dir,
      maxBytes: 30 * 1048576,
      timeoutMs: 1000,
      modelId: () => "mock",
      redact: (e) => e.message,
      planner: () => async () => {
        throw Error("no model");
      },
      converter: () => async () => {
        throw Error("no conversion");
      },
    });
  }
  service = make();
  await service.init();
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, job, service, make };
}
test("summary excludes bodies, coverage and source snapshots; lazy details and legacy full API survive restart", async (t) => {
  const { service, job, make } = await setup(t);
  const summary = service.summary(job.id);
  const item = summary.items[0];
  assert.equal(item.coverageCount, 1);
  assert.equal(item.wecom, undefined);
  assert.equal(item.coverage, undefined);
  assert.equal(item.plan.changes[0].lazy, true);
  assert.equal(item.plan.changes[0].after, undefined);
  assert(Buffer.byteLength(JSON.stringify(summary)) < 2000);
  assert(
    Buffer.byteLength(JSON.stringify(await service.get(job.id))) > 1000000,
  );
  const header = item.plan.changes[0];
  const detail = await service.detail(
    job.id,
    item.id,
    "change",
    0,
    header.revision,
  );
  assert.deepEqual(detail.change, job.items[0].plan.changes[0]);
  assert.deepEqual(
    (await service.detail(job.id, item.id, "coverage")).coverage,
    ["all lines checked"],
  );
  await assert.rejects(
    service.detail(job.id, item.id, "change", 0, "0".repeat(64)),
    (e) => e.status === 409,
  );
  await assert.rejects(
    service.detail(job.id, randomUUID(), "coverage"),
    (e) => e.status === 404,
  );
  await assert.rejects(
    service.detail(job.id, item.id, "change", -1, header.revision),
    (e) => e.status === 400,
  );
  const restarted = make();
  await service.close();
  await restarted.init();
  try {
    assert.deepEqual(restarted.summary(job.id), summary);
    assert.deepEqual(
      (await restarted.detail(job.id, item.id, "change", 0, header.revision))
        .change,
      detail.change,
    );
  } finally {
    await restarted.close();
  }
});
test("usage bursts are coalesced, critical saves flush immediately, timer writes latest progress and close drains it", async (t) => {
  const { service, job, dir } = await setup(t);
  let saves = 0;
  const save = service.save.bind(service);
  service.save = async (j) => {
    saves++;
    return save(j);
  };
  for (let n = 1; n <= 100; n++) {
    job.items[0].textUsage.input = n;
    await service.progress(job);
  }
  assert.equal(saves, 0);
  await service.save(job);
  assert.equal(saves, 1);
  assert.equal(service.progressSaves.size, 0);
  const file = path.join(dir, "knowledge-sync/jobs", job.id + ".json");
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).items[0].textUsage.input,
    100,
  );
  job.items[0].textUsage.input = 101;
  await service.progress(job);
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(saves, 2);
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).items[0].textUsage.input,
    101,
  );
  job.items[0].status = "stopped";
  job.items[0].textUsage.input = 102;
  await service.progress(job);
  await service.close();
  assert.equal(saves, 3);
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).items[0].status,
    "stopped",
  );
  assert.equal(service.progressSaves.size, 0);
});
test("report HTTP summary and detail require admin login and preserve full API compatibility", async (t) => {
  const { dir, job, service } = await setup(t);
  await service.close();
  const admin = { account: "admin", password: "fixture-secret" };
  const app = await createWebServer({
    cwd: dir,
    dataDir: dir,
    resourcesDir: path.resolve("resources"),
    admin,
    bridgeToken: "fixture-bridge-".repeat(4),
    model: { apiKey: "", modelId: "mock", baseUrl: "https://unused.invalid" },
    fileTools: { enabled: false },
  });
  t.after(() => app.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`,
    route = `/api/sync/jobs/${job.id}`;
  assert.equal((await fetch(base + route + "?view=summary")).status, 401);
  assert.equal(
    (
      await fetch(base + route, {
        headers: { Authorization: "Bearer " + "fixture-bridge-".repeat(4) },
      })
    ).status,
    401,
  );
  const token = (await (await fetch(base + "/api/auth/status")).json()).token;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": token },
    body: JSON.stringify(admin),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie };
  const summary = await (
    await fetch(base + route + "?view=summary", { headers })
  ).json();
  assert.equal(summary.items[0].plan.changes[0].after, undefined);
  const item = summary.items[0];
  const detail =
    route +
    `/items/${item.id}/changes/0?revision=${item.plan.changes[0].revision}`;
  assert.equal((await fetch(base + detail)).status, 401);
  assert.equal(
    (
      await fetch(base + detail, {
        headers: { Authorization: "Bearer " + "fixture-bridge-".repeat(4) },
      })
    ).status,
    401,
  );
  assert.deepEqual(
    (await (await fetch(base + detail, { headers })).json()).change,
    job.items[0].plan.changes[0],
  );
  assert.equal(
    (
      await fetch(
        base + detail.replace(/revision=.*/, "revision=" + "f".repeat(64)),
        { headers },
      )
    ).status,
    409,
  );
  assert.equal(
    (await fetch(base + detail + "&path=other", { headers })).status,
    400,
  );
  assert.deepEqual(
    (await (await fetch(base + route, { headers })).json()).items[0].plan
      .changes,
    job.items[0].plan.changes,
  );
  assert.equal(
    (await fetch(base + route + "?view=other", { headers })).status,
    400,
  );
});
