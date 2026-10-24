import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createWebServer } from "../dist/web/server.js";
const row = (id = "w3_one") =>
  JSON.stringify({
    docid: id,
    description: "<img src=x onerror=alert(1)> Guide",
  }) + "\n";
test("WeCom administrator routes, actual list saves/rechecks/conflicts, mock run/stop and schedule are isolated from machine access", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-import-web-")),
    dataDir = path.join(root, ".data");
  // Production environment overrides otherwise win over this fixture's cwd
  // and dataDir, including the JSONL file this test edits through the API.
  const isolatedEnv = {
    WECOM_IMPORT_DOCS_FILE: path.join(dataDir, "wecom_sync_docs.jsonl"),
    WECOM_CLI_CONFIG_DIR: path.join(dataDir, "wecom-auth"),
  };
  const previousEnv = new Map(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnv);
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let app;
  t.after(async () => {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dataDir, "wecom-auth"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "wecom_sync_docs.jsonl"), row());
  let timer = {
    available: true,
    editable: true,
    revision: "one",
    unit: "product-expert-wecom-import.timer",
    calendar: "*-*-* 04:00:00 Asia/Shanghai",
    schedule: { enabled: true, frequency: "daily", time: "04:00" },
  };
  let hold = false,
    entered,
    ready = new Promise((r) => (entered = r));
  app = await createWebServer({
    cwd: root,
    dataDir,
    resourcesDir: path.resolve("resources"),
    admin: { account: "admin", password: "fixture" },
    model: { apiKey: "", baseUrl: "", modelId: "" },
    bridgeToken: "bridge-fixture-secret-123456789012345",
    mcp: { apiKey: "mcp-fixture-secret-123456789012345" },
    wecomImport: {
      disk: async () => {},
      reader: {
        async run(op, input, signal) {
          assert.equal(op, "doc.contents.get");
          if (hold) {
            entered();
            await new Promise((resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              }),
            );
          }
          return { name: "Guide", version: 1, content: "Text body" };
        },
      },
    },
    wecomSchedule: {
      status: async () => timer,
      save: async (schedule, revision) => {
        if (revision !== timer.revision) {
          const e = Error("Conflict");
          e.status = 409;
          throw e;
        }
        timer = { ...timer, revision: "two", schedule };
        return timer;
      },
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ["status", "settings/docs", "settings/schedule"]) {
    assert.equal(
      (await fetch(base + "/api/wecom-import/" + route)).status,
      401,
    );
    for (const key of [
      "bridge-fixture-secret-123456789012345",
      "mcp-fixture-secret-123456789012345",
    ])
      assert.equal(
        (
          await fetch(base + "/api/wecom-import/" + route, {
            headers: { Authorization: "Bearer " + key },
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await fetch(base + "/api/wecom/wecom-import/" + route, {
          headers: {
            Authorization: "Bearer bridge-fixture-secret-123456789012345",
          },
        })
      ).status,
      403,
    );
  }
  const token = (await (await fetch(base + "/api/auth/status")).json()).token;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "X-Local-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ account: "admin", password: "fixture" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = {
    cookie,
    "X-Local-Token": token,
    "Content-Type": "application/json",
  };
  const api = async (route, method = "GET", body) =>
    fetch(base + "/api/wecom-import/" + route, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  const state = await (await api("status")).json();
  assert.equal(state.configured, true);
  assert.equal(state.docsFile, isolatedEnv.WECOM_IMPORT_DOCS_FILE);
  assert.equal(state.documents, 1);
  assert(!JSON.stringify(state).includes("fixture-secret"));
  const list = await (await api("settings/docs")).json();
  assert(list.text.includes("<img"));
  assert.equal(
    (
      await fetch(base + "/api/wecom-import/settings/docs", {
        method: "PUT",
        headers: { cookie },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/wecom-import/runs", {
        method: "POST",
        headers: { ...headers, Origin: "https://bad.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("settings/docs/check", "POST", {
        text: '{"path":"/etc/passwd"}',
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await api("settings/docs/check", "POST", { text: "bad" })).json())
      .valid,
    false,
  );
  assert.equal(
    (
      await api("settings/docs", "PUT", {
        text: "bad",
        revision: list.revision,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("settings/docs", "PUT", {
        text: row("w3_two"),
        revision: list.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("settings/docs", "PUT", {
        text: row(),
        revision: list.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (await api("runs", "POST", { docid: "w3_arbitrary" })).status,
    400,
  );
  let res = await api("runs", "POST", {});
  assert.equal(res.status, 202);
  const started = await res.json();
  let report;
  for (let i = 0; i < 100; i++) {
    report = await (await api("runs/" + started.id)).json();
    if (report.finished) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(report.status, "completed");
  assert.equal(report.items[0].outputs.length, 1);
  const timerBefore = await (await api("settings/schedule")).json();
  const changed = {
    enabled: false,
    frequency: "weekly",
    weekday: "Fri",
    time: "07:20",
  };
  assert.equal(
    (
      await api("settings/schedule", "PUT", {
        revision: timerBefore.revision,
        schedule: changed,
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await (await api("settings/schedule")).json()).schedule,
    changed,
  );
  for (let i = 0; i < 100; i++) {
    if (!(await (await api("status")).json()).running) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  hold = true;
  const current = await (await api("settings/docs")).json();
  assert.equal(
    (
      await api("settings/docs", "PUT", {
        text: row("w3_three"),
        revision: current.revision,
      })
    ).status,
    200,
  );
  res = await api("runs", "POST", {});
  assert.equal(res.status, 202);
  const running = await res.json();
  await ready;
  assert.equal((await api("runs", "POST", {})).status, 409);
  const activeList = await (await api("settings/docs")).json();
  assert.equal(
    (
      await api("settings/docs", "PUT", {
        text: row(),
        revision: activeList.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (await api("runs/" + running.id + "/stop", "POST", {})).status,
    200,
  );
  const html = await (await fetch(base + "/synchronize", { headers })).text();
  for (const value of [
    "WeCom imports",
    "SFTP imports",
    "Library imports",
    "wecom-settings-dialog",
    "wecom-import-run",
    "04:00",
  ])
    assert(html.includes(value));
  for (const asset of [
    "synchronize-wecom-settings.js",
    "synchronize-wecom-imports.js",
  ])
    assert.equal((await fetch(base + "/" + asset, { headers })).status, 200);
});
