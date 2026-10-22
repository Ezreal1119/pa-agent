import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

async function ui() {
  const nodes = new Map(),
    prompts = [],
    requests = [];
  const get = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: "",
        checked: false,
        disabled: false,
        textContent: "",
        dataset: {},
        events: {},
        addEventListener(name, fn) {
          this.events[name] = fn;
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
        focus() {},
        set innerHTML(_) {
          throw Error("Untrusted values must use textContent");
        },
      });
    return nodes.get(id);
  };
  let confirm = false,
    failure = false,
    pending;
  let timer = {
    available: true,
    editable: true,
    unit: "product-expert-library-import.timer",
    revision: "v1",
    enabled: true,
    active: true,
    calendar: "Mon *-*-* 06:00:00 Asia/Shanghai",
    nextRun: null,
    schedule: {
      enabled: true,
      frequency: "weekly",
      time: "06:00",
      weekday: "Mon",
    },
  };
  const sandbox = vm.createContext({
    document: { getElementById: get },
    window: {
      addEventListener() {},
      confirm(text) {
        prompts.push(text);
        return confirm;
      },
    },
    libraryImportApi: async (route, method, body) => {
      requests.push({ route, method, body });
      if (method === "PUT") {
        if (failure) throw Error("Timer changed elsewhere");
        timer = { ...timer, revision: "v2", schedule: body.schedule };
      } else if (pending) return await pending;
      return timer;
    },
  });
  vm.runInContext(
    await fs.readFile("resources/web/synchronize-library-settings.js", "utf8"),
    sandbox,
  );
  await get("library-settings-open").onclick();
  return {
    get,
    prompts,
    requests,
    confirm: (value) => {
      confirm = value;
    },
    failure: (value) => {
      failure = value;
    },
    pending: (value) => {
      pending = value;
    },
    timer: (value) => {
      timer = value;
    },
  };
}

test("Library dialog reads actual weekly schedule and saves daily/paused settings only to Library", async () => {
  const f = await ui(),
    get = f.get;
  assert.equal(get("library-schedule-time").value, "06:00");
  assert.equal(get("library-schedule-day-label").hidden, false);
  assert.equal(get("library-schedule-save").disabled, true);
  get("library-schedule-frequency").value = "daily";
  get("library-schedule-enabled").checked = false;
  get("library-schedule-time").value = "07:30";
  get("library-schedule-time").oninput();
  assert.equal(get("library-schedule-day-label").hidden, true);
  await get("library-schedule-save").onclick();
  const saved = f.requests.find((r) => r.method === "PUT");
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
    route: "settings/schedule",
    method: "PUT",
    body: {
      schedule: { enabled: false, frequency: "daily", time: "07:30" },
      revision: "v1",
    },
  });
  assert.match(get("library-schedule-result").textContent, /Saved and applied/);
  assert.equal(get("library-schedule-save").disabled, true);
});

test("Library conflict retains draft, close/reload require discard and invalid time cannot save", async () => {
  const f = await ui(),
    get = f.get;
  get("library-schedule-time").value = "";
  get("library-schedule-time").oninput();
  assert.equal(get("library-schedule-save").disabled, true);
  get("library-schedule-time").value = "08:00";
  get("library-schedule-time").oninput();
  f.failure(true);
  await get("library-schedule-save").onclick();
  assert.equal(get("library-schedule-time").value, "08:00");
  assert.match(get("library-schedule-result").textContent, /changed elsewhere/);
  await get("library-schedule-reload").onclick();
  assert.equal(get("library-schedule-time").value, "08:00");
  get("library-settings-close").onclick();
  assert.equal(get("library-settings-dialog").open, true);
  f.confirm(true);
  await get("library-schedule-reload").onclick();
  assert.equal(get("library-schedule-time").value, "06:00");
  get("library-settings-close").onclick();
  assert.equal(get("library-settings-dialog").open, false);
});

test("unavailable helper disables Library controls; old read cannot overwrite a reopened dialog", async () => {
  const f = await ui(),
    get = f.get;
  let resolve;
  f.pending(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const old = get("library-schedule-reload").onclick();
  get("library-settings-close").onclick();
  f.pending(undefined);
  f.timer({ available: false, editable: false, note: "Update the VPS helper" });
  await get("library-settings-open").onclick();
  resolve({
    available: true,
    editable: true,
    schedule: { enabled: true, frequency: "daily", time: "11:00" },
    calendar: "old",
  });
  await old;
  assert.equal(get("library-schedule-time").disabled, true);
  assert.equal(get("library-schedule-save").disabled, true);
  assert.match(
    get("library-schedule-result").textContent,
    /Update the VPS helper/,
  );
});
