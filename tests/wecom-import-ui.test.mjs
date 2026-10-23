import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { checkDocs as checkPaths } from "../dist/wecom-import/config.js";

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
const row = (path) =>
  JSON.stringify({
    docid: "e3_" + path.replace(/[^A-Za-z0-9]/g, ""),
    description: path,
  }) + "\n";
async function ui() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  get("wecom-schedule-frequency").value = "daily";
  get("wecom-schedule-day").value = "Mon";
  get("wecom-schedule-time").value = "03:00";
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
    wecomImportApi: async (route, method, body) => {
      requests.push({ route, method, body });
      if (route === "settings/docs/check") {
        if (deferCheck) await deferCheck;
        return checkPaths(body.text);
      }
      if (route === "settings/docs") {
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
    refreshWecomImports: async () => {},
  });
  vm.runInContext(
    await fs.readFile("resources/web/synchronize-wecom-settings.js", "utf8"),
    sandbox,
  );
  await get("wecom-settings-open").onclick();
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
      get("wecom-paths-text").value = value;
      get("wecom-paths-text").oninput();
    },
  };
}

test("settings requires a fresh successful Check for the edited text and keeps errors/failed-save drafts", async () => {
  const f = await ui(),
    get = f.get;
  assert.equal(get("wecom-paths-save").disabled, true);
  f.edit("oops");
  await get("wecom-paths-check").onclick();
  assert.equal(get("wecom-paths-save").disabled, true);
  assert.match(get("wecom-paths-result").textContent, /Check failed/);
  assert.match(
    get("wecom-paths-result").children[0].children[0].textContent,
    /Line 1/,
  );
  f.edit(row("/os/two.pdf"));
  await get("wecom-paths-check").onclick();
  assert.equal(get("wecom-paths-save").disabled, false);
  f.edit(row("/os/three.docx"));
  assert.equal(get("wecom-paths-save").disabled, true);
  await get("wecom-paths-save").onclick();
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
  await get("wecom-paths-check").onclick();
  f.rejectSave(true);
  await get("wecom-paths-save").onclick();
  assert.equal(get("wecom-paths-text").value, row("/os/three.docx"));
  assert.match(get("wecom-paths-result").textContent, /changed elsewhere/);
  f.rejectSave(false);
  await get("wecom-paths-save").onclick();
  assert.equal(get("wecom-paths-save").disabled, true);
  assert.match(get("wecom-paths-result").textContent, /Saved/);
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
  const checking = get("wecom-paths-check").onclick();
  f.edit("new invalid text");
  resolve();
  await checking;
  assert.equal(get("wecom-paths-save").disabled, true);
  get("wecom-settings-close").onclick();
  assert.equal(get("wecom-settings-dialog").open, true);
  assert.match(f.prompts.at(-1), /Discard unsaved/);
  f.confirm(true);
  get("wecom-settings-close").onclick();
  assert.equal(get("wecom-settings-dialog").open, false);
});

test("schedule and paths save independently; weekly fields show and use Beijing time without overwriting paths", async () => {
  const f = await ui(),
    get = f.get;
  assert.equal(get("wecom-schedule-save").disabled, true);
  assert.equal(get("wecom-schedule-day-label").hidden, true);
  f.edit(row("/os/unsaved.xlsx"));
  get("wecom-schedule-frequency").value = "weekly";
  get("wecom-schedule-frequency").oninput();
  assert.equal(get("wecom-schedule-day-label").hidden, false);
  get("wecom-schedule-day").value = "Tue";
  get("wecom-schedule-time").value = "06:30";
  get("wecom-schedule-time").oninput();
  await get("wecom-schedule-save").onclick();
  assert.equal(get("wecom-paths-text").value, row("/os/unsaved.xlsx"));
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
    f.requests.filter((r) => r.route === "settings/docs" && r.method === "PUT")
      .length,
    0,
  );
  assert.match(get("wecom-schedule-result").textContent, /Saved and applied/);
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
  const pending = get("wecom-paths-check").onclick();
  f.confirm(true);
  get("wecom-settings-close").onclick();
  assert.equal(get("wecom-settings-dialog").open, false);
  f.deferCheck(undefined);
  await get("wecom-settings-open").onclick();
  f.edit(row("/os/two.xlsx"));
  resolve();
  await pending;
  assert.equal(get("wecom-paths-save").disabled, true);
});
