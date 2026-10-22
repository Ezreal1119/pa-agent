import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import {
  SftpPathsEditor,
  checkPaths,
  MAX_PATHS_BYTES,
} from "../dist/sftp-sync/paths-editor.js";
import { parsePaths, sftpConfig } from "../dist/sftp-sync/config.js";
import { SftpSyncService } from "../dist/sftp-sync/service.js";
import {
  SftpTimerManager,
  SftpScheduleClient,
  SFTP_TIMER,
  LIBRARY_TIMER,
  scheduleSource,
  validateSchedule,
} from "../dist/sftp-sync/schedule.js";
import { createWebServer } from "../dist/web/server.js";

const list = (p) => JSON.stringify({ path: p }) + "\n";
const daily = { enabled: true, frequency: "daily", time: "03:00" };
const weekly = {
  enabled: true,
  frequency: "weekly",
  weekday: "Mon",
  time: "06:00",
};
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sftp-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function fakeTimer(t, source = "sftp") {
  const timerUnit = source === "library" ? LIBRARY_TIMER : SFTP_TIMER;
  const calendar =
    source === "library"
      ? "Mon *-*-* 06:00:00 Asia/Shanghai"
      : "*-*-* 03:00:00 Asia/Shanghai";
  const root = await temp(t),
    file = path.join(root, "timer.d/90-web-schedule.conf");
  await fs.mkdir(path.dirname(file));
  let enabled = true,
    active = true,
    loaded = calendar,
    external = "",
    fail,
    monotonic = "",
    trigger = timerUnit.replace(/\.timer$/, ".service");
  const calls = [];
  const command = async (args) => {
    calls.push(args);
    if (args[0] !== "daemon-reload")
      assert.equal(
        args.at(-1).startsWith("--property") ? args[1] : args.at(-1),
        timerUnit,
      );
    if (fail === args[0]) {
      fail = undefined;
      throw Error(`fixture ${args[0]} failed`);
    }
    if (args[0] === "show")
      return `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nUnitFileState=${enabled ? "enabled" : "disabled"}\nTimersCalendar={ OnCalendar=${loaded} ; next_elapse=n/a }\nTimersMonotonic=${monotonic}\nNextElapseUSecRealtime=${active ? "@1792706400" : "n/a"}\nTriggers=${trigger}\n`;
    if (args[0] === "cat")
      return `[Timer]\nOnCalendar=${calendar}\n${external}\n${await fs
        .readFile(file, "utf8")
        .catch((e) => {
          if (e.code === "ENOENT") return "";
          throw e;
        })}`;
    if (args[0] === "daemon-reload") {
      const text = await fs.readFile(file, "utf8").catch((e) => {
        if (e.code === "ENOENT") return "";
        throw e;
      });
      loaded =
        [...text.matchAll(/^OnCalendar=(.+)$/gm)].at(-1)?.[1] || calendar;
    }
    if (args[0] === "stop") active = false;
    if (args[0] === "start") active = true;
    if (args[0] === "enable" || args[0] === "disable") {
      enabled = args[0] === "enable";
      if (args.includes("--now")) active = enabled;
    }
    return "";
  };
  return {
    manager: new SftpTimerManager(command, file, false, source),
    command,
    calls,
    file,
    fail: (value) => {
      fail = value;
    },
    change: () => {
      external = "# External edit";
    },
    unsupported: () => {
      monotonic = "{ OnBootUSec=1min }";
    },
    wrongTrigger: () => {
      trigger = "other.service";
    },
  };
}

test("JSONL Check rejects wrong fields, unsafe paths, duplicates and empty lists without changing importer compatibility", () => {
  const valid = list("/os/产品/修改记录.xlsx");
  assert.deepEqual(checkPaths(valid), { valid: true, count: 1, errors: [] });
  const duplicate = checkPaths(valid + valid);
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.errors[0].line, 2);
  assert.match(duplicate.errors[0].message, /Duplicate path.*line 1/);
  assert.equal(
    parsePaths(valid + valid).length,
    1,
    "CLI retains the existing dedup rule",
  );
  for (const text of [
    "",
    "oops",
    '{"path":"/x.txt","id":"x"}',
    list("/../secret.txt"),
    list("/README.md"),
    list("/file.exe"),
  ])
    assert.equal(checkPaths(text).valid, false);
  assert.equal(checkPaths("\n".repeat(10001)).valid, false);
  assert.throws(() => checkPaths("a".repeat(MAX_PATHS_BYTES + 1)), /4 MiB/);
  assert.ok(
    !JSON.stringify(checkPaths('{"password":"do-not-echo"}')).includes(
      "do-not-echo",
    ),
  );
});

test("path editor atomically saves only valid content, retains backup and rejects stale or arbitrary paths", async (t) => {
  const root = await temp(t),
    file = path.join(root, "list.jsonl");
  const editor = new SftpPathsEditor(file, path.join(root, "logs"));
  const missing = await editor.read();
  assert.equal(missing.exists, false);
  const first = await editor.save(list("/os/one.xlsx"), missing.revision);
  await assert.rejects(editor.save("oops", first.revision), /Line 1/);
  assert.equal(await fs.readFile(file, "utf8"), first.text);
  const saved = await editor.save(list("/os/two.pdf"), first.revision);
  const backups = await fs.readdir(path.join(root, "logs/path-backups"));
  assert.equal(backups.length, 1);
  assert.equal(
    await fs.readFile(path.join(root, "logs/path-backups", backups[0]), "utf8"),
    first.text,
  );
  await assert.rejects(
    editor.save(first.text, first.revision),
    /changed elsewhere/,
  );
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, list("/os/external.docx"));
  await assert.rejects(
    editor.save(first.text, saved.revision),
    /changed elsewhere/,
  );
  await fs.unlink(file);
  await fs.symlink(path.join(root, "logs/path-backups", backups[0]), file);
  await assert.rejects(editor.read(), /Linked/);
  await assert.rejects(
    new SftpPathsEditor(path.join(root, ".env"), root).read(),
    /jsonl/,
  );
});

test("storage failures and invalid UTF-8 preserve the current path list", async (t) => {
  const root = await temp(t),
    file = path.join(root, "list.jsonl"),
    state = path.join(root, "blocked");
  await fs.writeFile(file, list("/os/source.xlsx"));
  await fs.writeFile(state, "not a directory");
  const editor = new SftpPathsEditor(file, state),
    original = await editor.read();
  await assert.rejects(editor.save(list("/os/new.xlsx"), original.revision));
  assert.equal(await fs.readFile(file, "utf8"), original.text);
  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(editor.read(), /UTF-8/);
});

test("path saving shares the CLI/import cross-process lock and does not change a running batch", async (t) => {
  const root = await temp(t),
    data = path.join(root, ".data");
  await fs.mkdir(data);
  const file = path.join(data, "sftp_sync_paths.jsonl");
  await fs.writeFile(file, list("/os/source.xlsx"));
  const config = {
    ...sftpConfig(root, data, {}),
    host: "fixture",
    username: "fixture",
    password: "fixture",
    fingerprint: "SHA256:" + "A".repeat(43),
  };
  const service = new SftpSyncService({
    dataDir: data,
    config,
    connector: async (_c, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
  });
  t.after(() => service.close());
  await service.init();
  const before = await service.readPaths(),
    run = await service.start();
  await assert.rejects(
    service.savePaths(list("/os/new.xlsx"), before.revision),
    /already running/,
  );
  assert.equal(await fs.readFile(file, "utf8"), before.text);
  await service.stop(run.id);
  await service.wait();
  const saved = await service.savePaths(list("/os/new.xlsx"), before.revision);
  assert.equal(saved.check.count, 1);
});

test("timer writes only a reset OnCalendar drop-in, applies weekly/paused settings and reports actual next trigger", async (t) => {
  const f = await fakeTimer(t),
    before = await f.manager.read();
  assert.deepEqual(before.schedule, daily);
  assert.equal(before.editable, true);
  assert.ok(before.nextRun.endsWith("Z"));
  const after = await f.manager.save(weekly, before.revision);
  assert.deepEqual(after.schedule, weekly);
  assert.equal(after.active, true);
  assert.equal(
    await fs.readFile(f.file, "utf8"),
    "[Timer]\nOnCalendar=\nOnCalendar=Mon *-*-* 06:00:00 Asia/Shanghai\nPersistent=true\n",
  );
  assert.ok(
    f.calls.some((args) => args.join(" ") === `enable --now ${SFTP_TIMER}`),
  );
  assert.ok(
    !f.calls.some((args) => args.includes("product-expert-sftp.service")),
    "never run or stop the importer itself",
  );
  const paused = await f.manager.save(
    { ...weekly, enabled: false },
    after.revision,
  );
  assert.equal(paused.enabled, false);
  assert.equal(paused.active, false);
  assert.equal(paused.nextRun, null);
  const n = f.calls.length;
  await f.manager.save({ ...weekly, enabled: false }, paused.revision);
  assert.deepEqual(
    f.calls.slice(n).map((args) => args[0]),
    ["show", "cat"],
    "unchanged schedule does not restart the timer",
  );
});

test("timer rejects injection, stale revisions, unknown operations and unsupported timer configuration", async (t) => {
  const f = await fakeTimer(t),
    before = await f.manager.read();
  for (const schedule of [
    { ...daily, time: "03:00\n[Service]" },
    { ...daily, time: "24:00" },
    { ...weekly, weekday: "Mon; reboot" },
    { ...daily, unit: "other.service" },
    { ...daily, enabled: "true" },
  ])
    assert.throws(() => validateSchedule(schedule));
  await assert.rejects(
    f.manager.handle({
      operation: "save",
      schedule: weekly,
      revision: before.revision,
      unit: "other.timer",
    }),
    /fields/,
  );
  await assert.rejects(f.manager.handle({ operation: "exec" }), /Only status/);
  f.change();
  await assert.rejects(
    f.manager.save(weekly, before.revision),
    /changed elsewhere/,
  );
  assert.equal(await fs.stat(f.file).catch(() => null), null);
  f.unsupported();
  assert.equal((await f.manager.read()).editable, false);
  await assert.rejects(
    f.manager.save(weekly, (await f.manager.read()).revision),
    /unsupported/,
  );
  const g = await fakeTimer(t);
  g.wrongTrigger();
  assert.equal((await g.manager.read()).editable, false);
});

test("timer apply failures restore both drop-in contents and previous active/enable state", async (t) => {
  for (const failure of ["stop", "daemon-reload", "enable"])
    await t.test(failure, async (t) => {
      const f = await fakeTimer(t),
        before = await f.manager.read();
      f.fail(failure);
      await assert.rejects(
        f.manager.save(weekly, before.revision),
        /Previous timer settings were restored/,
      );
      const restored = await f.manager.read();
      assert.deepEqual(restored.schedule, daily);
      assert.equal(restored.active, true);
      assert.equal(await fs.stat(f.file).catch(() => null), null);
    });
});

test("timer refuses linked drop-ins before stopping the existing timer", async (t) => {
  const f = await fakeTimer(t);
  const outside = path.join(path.dirname(f.file), "outside.conf");
  await fs.writeFile(outside, "original");
  await fs.symlink(outside, f.file);
  const before = await f.manager.read();
  await assert.rejects(f.manager.save(weekly, before.revision), /Unsafe timer/);
  assert.equal(await fs.readFile(outside, "utf8"), "original");
  assert.ok(!f.calls.some((args) => args[0] === "stop"));
});

test("timer rollback failures require VPS investigation instead of claiming settings were restored", async (t) => {
  const f = await fakeTimer(t),
    before = await f.manager.read();
  const manager = new SftpTimerManager(
    async (args) => {
      if (args[0] === "daemon-reload")
        throw Error("fixture daemon unavailable");
      return f.command(args);
    },
    f.file,
    false,
  );
  await assert.rejects(
    manager.save(weekly, before.revision),
    /update and rollback failed/,
  );
});

test("schedule socket client handles actual responses, conflicts and missing helper without touching host systemd", async (t) => {
  const f = await fakeTimer(t),
    library = await fakeTimer(t, "library"),
    root = await temp(t),
    socket = path.join(root, "timer.sock");
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk;
    });
    connection.on("end", async () => {
      try {
        connection.end(
          JSON.stringify({
            ok: true,
            result: await (
              scheduleSource(JSON.parse(input).source) === "library"
                ? library
                : f
            ).manager.handle(JSON.parse(input)),
          }),
        );
      } catch (e) {
        connection.end(
          JSON.stringify({
            ok: false,
            error: e.message,
            status: e.status || 503,
          }),
        );
      }
    });
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new SftpScheduleClient(socket),
    state = await client.status();
  assert.equal(state.available, true);
  const saved = await client.save(weekly, state.revision);
  assert.deepEqual(saved.schedule, weekly);
  await assert.rejects(client.save(daily, state.revision), /changed elsewhere/);
  const libraryClient = new SftpScheduleClient(socket, "library");
  const libraryBefore = await libraryClient.status();
  assert.equal(libraryBefore.unit, LIBRARY_TIMER);
  await libraryClient.save(daily, libraryBefore.revision);
  assert.deepEqual((await libraryClient.status()).schedule, daily);
  assert.deepEqual(
    (await client.status()).schedule,
    weekly,
    "Library edits leave SFTP untouched",
  );
  assert.throws(
    () => scheduleSource("../../other.timer"),
    /Only SFTP and Library/,
  );
  await assert.rejects(
    f.manager.handle({ operation: "status", source: "library" }),
    /source does not match/,
  );
  const missing = new SftpScheduleClient(path.join(root, "missing.sock"));
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.save(daily, "a".repeat(64)), /unavailable/);
});

test("settings HTTP enforces admin/CSRF/Origin, rechecks saves and surfaces schedule conflicts", async (t) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("SFTP_")),
  );
  for (const key of Object.keys(env)) delete process.env[key];
  t.after(() => Object.assign(process.env, env));
  const f = await fakeTimer(t),
    libraryTimer = await fakeTimer(t, "library"),
    root = await temp(t),
    dataDir = path.join(root, ".data");
  await fs.mkdir(dataDir);
  const file = path.join(dataDir, "sftp_sync_paths.jsonl");
  await fs.writeFile(file, list("/os/one.xlsx"));
  const app = await createWebServer({
    cwd: root,
    dataDir,
    resourcesDir: path.resolve("resources"),
    admin: { account: "admin", password: "fixture" },
    bridgeToken: "fixture-bridge-012345678901234567890",
    mcp: { apiKey: "fixture-mcp-012345678901234567890" },
    librarySchedule: {
      status: () => libraryTimer.manager.read(),
      save: (s, r) => libraryTimer.manager.save(s, r),
    },
    sftpSchedule: {
      status: () => f.manager.read(),
      save: (s, r) => f.manager.save(s, r),
    },
  });
  t.after(() => app.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of [
    "sftp-sync/settings/paths",
    "sftp-sync/settings/schedule",
    "library-import/settings/schedule",
  ]) {
    assert.equal((await fetch(`${base}/api/${route}`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/wecom/${route}`, {
          headers: {
            Authorization: "Bearer fixture-bridge-012345678901234567890",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/${route}`, {
          headers: {
            Authorization: "Bearer fixture-mcp-012345678901234567890",
          },
        })
      ).status,
      401,
    );
  }
  const token = (await (await fetch(base + "/api/auth/status")).json()).token;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": token },
    body: JSON.stringify({ account: "admin", password: "fixture" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = (route, method = "GET", body, headers = {}) =>
    fetch(`${base}/api/sftp-sync/settings/${route}`, {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        "x-local-token": token,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const libraryRequest = (method = "GET", body, headers = {}) =>
    fetch(`${base}/api/library-import/settings/schedule`, {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        "x-local-token": token,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const libraryOpened = await (await libraryRequest()).json();
  assert.equal(libraryOpened.unit, LIBRARY_TIMER);
  const librarySave = { schedule: daily, revision: libraryOpened.revision };
  assert.equal(
    (await libraryRequest("PUT", librarySave, { "x-local-token": "" })).status,
    403,
  );
  assert.equal(
    (
      await libraryRequest("PUT", librarySave, {
        Origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await libraryRequest("PUT", { ...librarySave, unit: SFTP_TIMER })).status,
    400,
  );
  assert.equal((await libraryRequest("PUT", librarySave)).status, 200);
  assert.equal((await libraryRequest("PUT", librarySave)).status, 409);
  assert.deepEqual((await f.manager.read()).schedule, daily);
  assert.equal(
    (
      await fetch(base + "/synchronize-library-settings.js", {
        headers: { cookie },
      })
    ).status,
    200,
  );
  const opened = await (await request("paths")).json();
  assert.equal(opened.text, list("/os/one.xlsx"));
  assert.equal(
    (
      await request(
        "paths/check",
        "POST",
        { text: "oops" },
        { "x-local-token": "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "paths",
        "PUT",
        { text: opened.text, revision: opened.revision },
        { Origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
  const invalid = await (
    await request("paths/check", "POST", { text: opened.text + "oops" })
  ).json();
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].line, 2);
  assert.equal(
    (await request("paths", "PUT", { text: "oops", revision: opened.revision }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("paths", "PUT", {
        text: opened.text,
        revision: opened.revision,
        file: "/etc/passwd",
      })
    ).status,
    400,
  );
  const saved = await request("paths", "PUT", {
    text: list("/os/two.pdf"),
    revision: opened.revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(file, "utf8"), list("/os/two.pdf"));
  assert.equal(
    (
      await request("paths", "PUT", {
        text: opened.text,
        revision: opened.revision,
      })
    ).status,
    409,
  );
  const timer = await (await request("schedule")).json();
  assert.equal(
    (
      await request(
        "schedule",
        "PUT",
        { schedule: weekly, revision: timer.revision },
        { "x-local-token": "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("schedule", "PUT", {
        schedule: weekly,
        revision: timer.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("schedule", "PUT", {
        schedule: daily,
        revision: timer.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(base + "/synchronize-sftp-settings.js", {
        headers: { cookie },
      })
    ).status,
    200,
  );
});

test("Library timer applies/pauses independently and preserves the last schedule on apply failure", async (t) => {
  const f = await fakeTimer(t, "library");
  const before = await f.manager.read();
  assert.deepEqual(before.schedule, weekly);
  f.fail("enable");
  await assert.rejects(
    f.manager.save(daily, before.revision),
    /Previous timer settings were restored/,
  );
  assert.deepEqual((await f.manager.read()).schedule, weekly);
  const changed = await f.manager.save(daily, before.revision);
  assert.equal(changed.unit, LIBRARY_TIMER);
  const paused = await f.manager.save(
    { ...daily, enabled: false },
    changed.revision,
  );
  assert.equal(paused.nextRun, null);
  assert.equal(paused.active, false);
  assert.ok(!f.calls.flat().includes(SFTP_TIMER));
  assert.ok(!f.calls.flat().includes("product-expert-library-import.service"));
});
