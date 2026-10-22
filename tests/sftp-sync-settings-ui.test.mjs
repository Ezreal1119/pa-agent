import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { checkPaths } from "../dist/sftp-sync/paths-editor.js";

class Element {
  constructor() {
    this.value = "";
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.checked = false;
    this.disabled = false;
    this.events = {};
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  addEventListener(name, fn) {
    this.events[name] = fn;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {
    this.focused = true;
  }
  set innerHTML(_) {
    throw Error("Settings must render untrusted values as text");
  }
}
const row = (path) => JSON.stringify({ path }) + "\n";
async function ui() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  get("sftp-schedule-frequency").value = "daily";
  get("sftp-schedule-day").value = "Mon";
  get("sftp-schedule-time").value = "03:00";
  let text = row("/os/one.xlsx"),
    revision = "original",
    rejectSave = false,
    confirmation = false,
    deferCheck;
  let timer = {
    available: true,
    editable: true,
    revision: "timer-1",
    schedule: { enabled: true, frequency: "daily", time: "03:00" },
    calendar: "*-*-* 03:00:00 Asia/Shanghai",
    enabled: true,
    active: true,
    nextRun: null,
  };
  const requests = [],
    prompts = [];
  const sandbox = vm.createContext({
    document: { getElementById: get, createElement: () => new Element() },
    window: {
      addEventListener() {},
      confirm(message) {
        prompts.push(message);
        return confirmation;
      },
    },
    importApi: async (route, method, body) => {
      requests.push({ route, method, body });
      if (route === "settings/paths/check") {
        if (deferCheck) await deferCheck;
        return checkPaths(body.text);
      }
      if (route === "settings/paths") {
        if (method === "PUT") {
          if (rejectSave)
            throw Error("The path list changed elsewhere. Reload paths.");
          text = body.text;
          revision = "saved";
        }
        return {
          text,
          revision,
          file: "/fixture/list.jsonl",
          check: checkPaths(text),
        };
      }
      if (route === "settings/schedule") {
        if (method === "PUT")
          timer = { ...timer, schedule: body.schedule, revision: "timer-2" };
        return timer;
      }
      throw Error("Unexpected request");
    },
    refreshImports: async () => {},
  });
  vm.runInContext(
    await fs.readFile("resources/web/synchronize-sftp-settings.js", "utf8"),
    sandbox,
  );
  await get("sftp-settings-open").onclick();
  return {
    get,
    requests,
    prompts,
    confirm: (value) => {
      confirmation = value;
    },
    rejectSave: (value) => {
      rejectSave = value;
    },
    deferCheck: (promise) => {
      deferCheck = promise;
    },
    edit: (value) => {
      get("sftp-paths-text").value = value;
      get("sftp-paths-text").oninput();
    },
  };
}

test("settings requires a fresh successful Check for the edited text and keeps errors/failed-save drafts", async () => {
  const f = await ui(),
    get = f.get;
  assert.equal(get("sftp-paths-save").disabled, true);
  f.edit("oops");
  await get("sftp-paths-check").onclick();
  assert.equal(get("sftp-paths-save").disabled, true);
  assert.match(get("sftp-paths-result").textContent, /Check failed/);
  assert.match(
    get("sftp-paths-result").children[0].children[0].textContent,
    /Line 1/,
  );
  f.edit(row("/os/two.pdf"));
  await get("sftp-paths-check").onclick();
  assert.equal(get("sftp-paths-save").disabled, false);
  f.edit(row("/os/three.docx"));
  assert.equal(get("sftp-paths-save").disabled, true);
  await get("sftp-paths-save").onclick();
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
  await get("sftp-paths-check").onclick();
  f.rejectSave(true);
  await get("sftp-paths-save").onclick();
  assert.equal(get("sftp-paths-text").value, row("/os/three.docx"));
  assert.match(get("sftp-paths-result").textContent, /changed elsewhere/);
  f.rejectSave(false);
  await get("sftp-paths-save").onclick();
  assert.equal(get("sftp-paths-save").disabled, true);
  assert.match(get("sftp-paths-result").textContent, /Saved/);
});

test("stale Check response cannot enable Save for newer text; closing asks before losing unsaved paths", async () => {
  const f = await ui(),
    get = f.get;
  let resolve;
  f.deferCheck(
    new Promise((done) => {
      resolve = done;
    }),
  );
  f.edit(row("/os/two.xlsx"));
  const checking = get("sftp-paths-check").onclick();
  f.edit("new invalid text");
  resolve();
  await checking;
  assert.equal(get("sftp-paths-save").disabled, true);
  get("sftp-settings-close").onclick();
  assert.equal(get("sftp-settings-dialog").open, true);
  assert.match(f.prompts.at(-1), /Discard unsaved/);
  f.confirm(true);
  get("sftp-settings-close").onclick();
  assert.equal(get("sftp-settings-dialog").open, false);
});

test("schedule and paths save independently; weekly fields show and use Beijing time without overwriting paths", async () => {
  const f = await ui(),
    get = f.get;
  assert.equal(get("sftp-schedule-save").disabled, true);
  assert.equal(get("sftp-schedule-day-label").hidden, true);
  f.edit(row("/os/unsaved.xlsx"));
  get("sftp-schedule-frequency").value = "weekly";
  get("sftp-schedule-frequency").oninput();
  assert.equal(get("sftp-schedule-day-label").hidden, false);
  get("sftp-schedule-day").value = "Tue";
  get("sftp-schedule-time").value = "06:30";
  get("sftp-schedule-time").oninput();
  await get("sftp-schedule-save").onclick();
  assert.equal(get("sftp-paths-text").value, row("/os/unsaved.xlsx"));
  const request = f.requests.find(
    (r) => r.route === "settings/schedule" && r.method === "PUT",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    schedule: {
      enabled: true,
      frequency: "weekly",
      time: "06:30",
      weekday: "Tue",
    },
    revision: "timer-1",
  });
  assert.equal(
    f.requests.filter((r) => r.route === "settings/paths" && r.method === "PUT")
      .length,
    0,
  );
  assert.match(get("sftp-schedule-result").textContent, /Saved and applied/);
});

test("closing during a read-only Check is allowed and its late result cannot authorize a reopened draft", async () => {
  const f = await ui(),
    get = f.get;
  let resolve;
  f.deferCheck(
    new Promise((done) => {
      resolve = done;
    }),
  );
  f.edit(row("/os/two.xlsx"));
  const pending = get("sftp-paths-check").onclick();
  f.confirm(true);
  get("sftp-settings-close").onclick();
  assert.equal(get("sftp-settings-dialog").open, false);
  f.deferCheck(undefined);
  await get("sftp-settings-open").onclick();
  f.edit(row("/os/two.xlsx"));
  resolve();
  await pending;
  assert.equal(get("sftp-paths-save").disabled, true);
});
