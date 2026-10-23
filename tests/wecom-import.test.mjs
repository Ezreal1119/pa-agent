import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { wecomConfig, checkDocs } from "../dist/wecom-import/config.js";
import { WecomImportService } from "../dist/wecom-import/service.js";
import {
  Collector,
  region,
  address,
  sectionHash,
  markdown,
} from "../dist/wecom-import/snapshot.js";
import { CliReader, WecomError } from "../dist/wecom-import/client.js";
import { atomic, hash } from "../dist/knowledge-sync/core.js";
const row = (docid = "e3_one", description = "Guide") =>
  JSON.stringify({ docid, description }) + "\n";
class Fake {
  version = 1;
  text = "A";
  title = "Book";
  changes = [];
  calls = [];
  truncated = false;
  denied = false;
  merges = ["A1:A2"];
  hidden = true;
  async run(op, input, signal) {
    signal.throwIfAborted();
    this.calls.push([op, input]);
    if (op === "sheet.version.get")
      return {
        version: this.changes.length ? this.changes.shift() : this.version,
      };
    if (op === "sheet.workbook.get")
      return {
        sheets: [
          { sheet_id: "a", name: "Sheet", type: "sheet", range: "A1:C3" },
          { sheet_id: "b", name: "Hidden", type: "sheet", range: "A1:C3" },
        ],
      };
    if (op === "sheet.get")
      return {
        name: this.title,
        sheets: [
          { sheet_id: "a", title: "Sheet" },
          { sheet_id: "b", title: "Hidden", is_hidden: this.hidden },
        ],
      };
    if (op === "sheet.merge.get")
      return { merges: input.sheet === "a" ? this.merges : [] };
    if (op === "sheet.cells.get") {
      const a = region(input.range),
        cells = Array.from({ length: a.rows }, (_, y) =>
          Array.from({ length: a.cols }, (_, x) => {
            const at = address(y + a.a.r, x + a.a.c);
            return at === "A1"
              ? {
                  value: input.sheet === "a" ? this.text : "B",
                  image: `https://image.invalid/${this.version}`,
                  style: { color: this.version },
                }
              : at === "C1"
                ? {
                    value: 12,
                    formula: "=6*2",
                    link: "https://example.test/",
                    link_text: "Example",
                  }
                : at === "B3"
                  ? "line1\nline2"
                  : null;
          }),
        );
      return {
        cells,
        actual_range: input.range,
        truncated: this.truncated,
        not_viewable_cells: this.denied ? ["A1"] : [],
      };
    }
    throw Error("Unexpected operation");
  }
}
async function fixture(t, reader = new Fake(), extras = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wecom-import-test-"),
  );
  const config = wecomConfig(dataDir, dataDir, {});
  await fs.mkdir(config.authDir);
  await fs.writeFile(config.docsFile, row());
  const service = new WecomImportService({
    dataDir,
    config,
    reader,
    ...extras,
  });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await service.init();
  return { dataDir, config, service, reader };
}
async function run(service) {
  const r = await service.start();
  await service.wait();
  return service.get(r.id);
}
const incoming = async (s) =>
  (await fs.readdir(s.inbox)).filter((n) => n.endsWith(".md"));

test("JSONL validates exact fields, supported ordinary types, uniqueness and descriptions", () => {
  assert(checkDocs(row() + row("w3_word", "说明")).valid);
  for (const value of [
    "{bad",
    row() + row(),
    row("s3_smart"),
    row("e3_one", " "),
    '{"docid":"e3_x","description":"a","path":"/etc/passwd"}',
    row("e3_../../evil"),
    row("w3_x", "x\0x"),
    "",
  ])
    assert.equal(checkDocs(value).valid, false);
  assert.throws(() => checkDocs("x".repeat(4 * 1048576 + 1)));
});
test("version precheck skips full read; text hash ignores style and other sheets; stable names, consumed inputs, latest A→B→A state", async (t) => {
  const { service, reader } = await fixture(t);
  const first = await run(service);
  assert.equal(first.status, "completed");
  assert.equal(first.items[0].outputs.length, 2);
  const files = await incoming(service);
  assert.equal(files.length, 2);
  const sheet = first.items[0].outputs[0];
  const md = await fs.readFile(path.join(service.inbox, sheet.target), "utf8");
  assert.match(md, /merged from A1/);
  assert.match(md, /Formula: =6\*2/);
  assert.match(md, /line1<br>line2/);
  assert.match(md, /Link \(Example\)/);
  assert(!md.includes("image.invalid"));
  reader.calls = [];
  assert.equal((await run(service)).items[0].status, "unchanged");
  assert.deepEqual(
    reader.calls.map((x) => x[0]),
    ["sheet.version.get"],
  );
  reader.version++;
  assert.equal((await run(service)).items[0].status, "unchanged");
  reader.version++;
  reader.text = "B";
  const updated = await run(service);
  assert.equal(updated.items[0].outputs.length, 1);
  assert.equal(updated.items[0].outputs[0].target, sheet.target);
  await fs.unlink(path.join(service.inbox, sheet.target));
  reader.calls = [];
  assert.equal((await run(service)).items[0].status, "unchanged");
  assert(!(await incoming(service)).includes(sheet.target));
  reader.version++;
  reader.text = "A";
  assert.equal((await run(service)).items[0].outputs[0].target, sheet.target);
  assert.match(
    await fs.readFile(path.join(service.inbox, sheet.target), "utf8"),
    /\| A \|/,
  );
  reader.version++;
  reader.title = "Renamed";
  const renamed = await run(service);
  assert.deepEqual(
    renamed.items[0].outputs.map((o) => o.target).sort(),
    files.sort(),
  );
  const list = await service.readDocs();
  await service.saveDocs(row("e3_one", "Description changed"), list.revision);
  reader.calls = [];
  assert.equal((await run(service)).items[0].status, "unchanged");
  assert.equal(reader.calls.length, 1);
  const reboot = new WecomImportService({
    dataDir: service.options.dataDir,
    config: service.options.config,
    reader,
  });
  await reboot.init();
  assert.equal((await run(reboot)).items[0].status, "unchanged");
  await reboot.close();
});
test("only real declared merges carry text; blank cells stay blank; hidden sheets and scalar types survive", async (t) => {
  const { service, reader } = await fixture(t);
  const snap = await new Collector(reader, service.options.config).collect(
    "e3_one",
    new AbortController().signal,
    service.work,
  );
  assert.equal(snap.sections[1].hidden, true);
  assert.equal(snap.sections[0].cells.find((c) => c.at === "C1").value, 12);
  assert.match(
    markdown(snap, snap.sections[0]),
    /\| 2 \| A \(merged from A1\) \|  \|/,
  );
  const a = sectionHash(snap, snap.sections[0]);
  assert.equal(a, sectionHash({ ...snap, version: "999" }, snap.sections[0]));
  reader.merges = ["A1:A2", "A2:B2"];
  await assert.rejects(
    () =>
      new Collector(reader, service.options.config).collect(
        "e3_one",
        new AbortController().signal,
        service.work,
      ),
    /Overlapping/,
  );
});
test("truncation, unreadable ranges, mixed versions and hard limits never publish", async (t) => {
  const f = await fixture(t);
  for (const field of ["truncated", "denied"]) {
    f.reader[field] = true;
    const r = await run(f.service);
    assert.equal(r.items[0].status, "failed");
    assert.equal((await incoming(f.service)).length, 0);
    f.reader[field] = false;
  }
  f.reader.changes = [1, 2, 3, 4];
  assert.match((await run(f.service)).items[0].error, /kept changing/);
  assert.equal((await incoming(f.service)).length, 0);
  f.reader.changes = [1, 2, 3, 3];
  assert.equal((await run(f.service)).status, "completed");
});
test("manual input edit conflicts; settings save conflicts, backup, and separate source identity", async (t) => {
  const { service, reader } = await fixture(t);
  const first = await run(service);
  const output = first.items[0].outputs[0];
  await fs.writeFile(path.join(service.inbox, output.target), "MANUAL");
  reader.text = "new";
  reader.version++;
  assert.match((await run(service)).items[0].error, /manual-edit conflict/);
  assert.equal(
    await fs.readFile(path.join(service.inbox, output.target), "utf8"),
    "MANUAL",
  );
  const old = await service.readDocs();
  await service.saveDocs(
    row("e3_one") + row("e3_two", "Same source title"),
    old.revision,
  );
  await assert.rejects(
    () => service.saveDocs(row("w3_word"), old.revision),
    (e) => e.status === 409,
  );
  assert.equal(
    (await fs.readdir(path.join(service.root, "path-backups"))).length,
    1,
  );
  assert(!checkDocs(row("s3_bad")).valid);
  await fs.unlink(path.join(service.inbox, output.target));
  const next = await run(service);
  assert.equal(next.status, "completed");
  assert.equal(
    new Set(next.items.flatMap((i) => i.outputs.map((o) => o.target))).size,
    3,
  );
});
test("CLI and Web equivalent instances share lock; stop keeps successful hash unchanged and settings locked", async (t) => {
  let entered, continueRead;
  const ready = new Promise((r) => (entered = r));
  const reader = new Fake();
  const original = reader.run.bind(reader);
  reader.run = async (op, input, signal) => {
    if (op === "sheet.cells.get") {
      entered();
      await new Promise((resolve, reject) => {
        continueRead = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
    return original(op, input, signal);
  };
  const { service, dataDir, config } = await fixture(t, reader);
  const r = await service.start();
  await ready;
  const cliResult = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.resolve("dist/wecom-import/cli.js")],
      {
        cwd: dataDir,
        env: { PATH: process.env.PATH, AGENT_DATA_DIR: dataDir },
        timeout: 5000,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    ),
  );
  assert.equal(cliResult.error?.code, 1);
  assert.match(cliResult.stderr, /already running/);
  const other = new WecomImportService({ dataDir, config, reader });
  await assert.rejects(
    () => other.start(),
    (e) => e.status === 409,
  );
  const docs = await service.readDocs();
  await assert.rejects(
    () => other.saveDocs(row("e3_two"), docs.revision),
    (e) => e.status === 409,
  );
  await other.stop(r.id);
  await service.wait();
  assert.equal((await service.get(r.id)).status, "stopped");
  await assert.rejects(
    () => fs.stat(path.join(service.root, "state.json")),
    (e) => e.code === "ENOENT",
  );
  assert.equal((await incoming(service)).length, 0);
  continueRead();
  await other.close();
});
test("authorization or disk failures stop batch, independent permission errors continue, no successful state advancement", async (t) => {
  const { service, reader } = await fixture(t);
  const old = await service.readDocs();
  await service.saveDocs(row() + row("e3_two"), old.revision);
  const original = reader.run.bind(reader);
  reader.run = async (op, input, signal) => {
    if (input.docid === "e3_one")
      throw new WecomError("No document permission.");
    return original(op, input, signal);
  };
  let r = await run(service);
  assert.deepEqual(
    r.items.map((i) => i.status),
    ["failed", "delivered"],
  );
  reader.run = async () => {
    throw new WecomError("Authorization expired.", true);
  };
  r = await run(service);
  assert.deepEqual(
    r.items.map((i) => i.status),
    ["failed", "not_attempted"],
  );
  const disk = await fixture(t, new Fake(), {
    disk: async () => {
      throw new WecomError("Disk full.", true);
    },
  });
  assert.equal((await run(disk.service)).items[0].status, "failed");
  assert.equal((await incoming(disk.service)).length, 0);
});
async function pendingFixture(t) {
  const f = await fixture(t);
  const report = await run(f.service),
    state = JSON.parse(
      await fs.readFile(path.join(f.service.root, "state.json"), "utf8"),
    ),
    e = state.sources[hash("e3_one")],
    output = report.items[0].outputs[0];
  const stage = randomUUID() + ".part",
    target = path.join(f.service.inbox, output.target);
  const body = await fs.readFile(target);
  await fs.writeFile(path.join(f.service.work, stage), body);
  await fs.unlink(target);
  e.pending = {
    run: report.id,
    snapshotFile: e.snapshotFile,
    snapshotHash: e.snapshotHash,
    outputs: [
      { ...output, status: "pending", stage, markdownHash: hash(body) },
    ],
  };
  delete e.sections[output.key];
  report.status = "running";
  report.items[0].status = "publishing";
  await atomic(
    path.join(f.service.root, report.id + ".json"),
    JSON.stringify(report),
  );
  const { items, ...small } = report;
  await atomic(
    path.join(f.service.root, report.id + ".summary.json"),
    JSON.stringify(small),
  );
  await atomic(path.join(f.service.root, "state.json"), JSON.stringify(state));
  return { ...f, state, e, output, stage, body };
}
test("restart recovers pending delivery before equal version skip and interrupted report without duplicate output", async (t) => {
  const f = await pendingFixture(t);
  const restarted = new WecomImportService({
    dataDir: f.dataDir,
    config: f.config,
    reader: f.reader,
  });
  await restarted.init();
  assert.deepEqual(
    await fs.readFile(path.join(f.service.inbox, f.output.target)),
    f.body,
  );
  assert.equal((await run(restarted)).items[0].status, "unchanged");
  assert.equal((await incoming(restarted)).length, 2);
  assert((await restarted.list()).some((r) => r.status === "interrupted"));
  await restarted.close();
});
test("recovery handles exclusive hardlink crash; ambiguous missing stage and changed targets fail closed", async (t) => {
  const linked = await pendingFixture(t);
  await fs.link(
    path.join(linked.service.work, linked.stage),
    path.join(linked.service.inbox, linked.output.target),
  );
  await linked.service.init();
  assert.equal((await linked.service.status()).recoveryError, undefined);
  assert.equal(
    (await fs.stat(path.join(linked.service.inbox, linked.output.target)))
      .nlink,
    1,
  );
  const missing = await pendingFixture(t);
  await fs.unlink(path.join(missing.service.work, missing.stage));
  await missing.service.init();
  assert.match(
    (await missing.service.status()).recoveryError,
    /cannot be verified/,
  );
  await assert.rejects(() => missing.service.start(), /cannot be verified/);
  const manual = await pendingFixture(t);
  await fs.writeFile(
    path.join(manual.service.inbox, manual.output.target),
    "MANUAL",
  );
  await manual.service.init();
  assert.match((await manual.service.status()).recoveryError, /edited outside/);
  assert.equal(
    await fs.readFile(
      path.join(manual.service.inbox, manual.output.target),
      "utf8",
    ),
    "MANUAL",
  );
});
test("corrupt persistence and symlink lists/inbox do not reset state or read arbitrary paths", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.service.root, "state.json"), "{bad");
  await f.service.init();
  assert((await f.service.status()).recoveryError);
  await assert.rejects(() => f.service.start());
  assert.equal(
    await fs.readFile(path.join(f.service.root, "state.json"), "utf8"),
    "{bad",
  );
  await fs.unlink(f.config.docsFile);
  await fs.symlink("/etc/passwd", f.config.docsFile);
  await assert.rejects(() => f.service.readDocs(), /Linked paths/);
});
test("Word inline and contained file body forms, images excluded, no separate version precheck and escape rejected", async (t) => {
  for (const form of ["inline", "file", "wrapper"]) {
    const reader = {
      async run(op, input, signal, dir) {
        assert.equal(op, "doc.contents.get");
        const content =
          "# 正文\r\n\r\nContent\n![image](https://images.invalid/a)";
        if (form === "inline") return { name: "Word", version: 2, content };
        const filename = path.join(dir, "body.txt");
        await fs.writeFile(
          filename,
          form === "wrapper"
            ? JSON.stringify({
                name: "Word",
                version: 2,
                content: { markdown_content: content },
              })
            : content,
        );
        return { name: "Word", version: 2, file_path: filename };
      },
    };
    const f = await fixture(t, reader);
    const list = await f.service.readDocs();
    await f.service.saveDocs(row("w3_one"), list.revision);
    const first = await run(f.service);
    assert.equal(first.items[0].status, "delivered");
    const body = await fs.readFile(
      path.join(f.service.inbox, first.items[0].outputs[0].target),
      "utf8",
    );
    assert.match(body, /# 正文\n\nContent/);
    assert(!body.includes("markdown_content"));
    assert(!body.includes("\\r\\n"));
    assert(!body.includes("images.invalid"));
    assert.equal((await run(f.service)).items[0].status, "unchanged");
  }
  const evil = await fixture(t, {
    async run() {
      return { file_path: "/etc/passwd" };
    },
  });
  const old = await evil.service.readDocs();
  await evil.service.saveDocs(row("w3_one"), old.revision);
  assert.match((await run(evil.service)).items[0].error, /outside/);
});
test("real child process wrapper is read-only, isolates Bridge environment, sanitizes errors and cancels promptly", async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.dataDir, "fake-cli");
  await fs.writeFile(
    bin,
    `#!${process.execPath}\nconst input=JSON.parse(process.argv[process.argv.indexOf('--json')+1]);if(input.mode==='auth'){console.log(JSON.stringify({error:{message:'authorization token=NEVER_SHOW',type:'auth'}}));}else if(input.mode==='sleep'){setTimeout(()=>{},10000);}else{console.log(JSON.stringify({version:1,secretInherited:!!process.env.WECOM_BOT_SECRET,tokenInherited:!!process.env.WECOM_CLI_ACCESS_TOKEN,config:process.env.WECOM_CLI_CONFIG_DIR,args:process.argv.slice(2)}));}`,
    { mode: 0o700 },
  );
  const saved = process.env.WECOM_BOT_SECRET;
  process.env.WECOM_BOT_SECRET = "bridge-secret";
  t.after(() => {
    if (saved === undefined) delete process.env.WECOM_BOT_SECRET;
    else process.env.WECOM_BOT_SECRET = saved;
  });
  const cli = new CliReader({ ...f.config, cliBin: bin });
  await cli.preflight();
  const body = await cli.run(
    "sheet.version.get",
    {},
    new AbortController().signal,
  );
  assert.equal(body.secretInherited, false);
  assert.equal(body.tokenInherited, false);
  assert.equal(body.config, f.config.authDir);
  assert.deepEqual(body.args.slice(0, 3), ["sheet", "version", "get"]);
  await assert.rejects(
    () => cli.run("write", {}, new AbortController().signal),
    /not allowed/,
  );
  await assert.rejects(
    () =>
      cli.run(
        "sheet.version.get",
        { mode: "auth" },
        new AbortController().signal,
      ),
    (e) => e.fatal && !e.message.includes("NEVER_SHOW"),
  );
  const controller = new AbortController();
  const task = cli.run(
    "sheet.version.get",
    { mode: "sleep" },
    controller.signal,
  );
  setTimeout(() => controller.abort(Error("Stopped")), 30);
  await assert.rejects(() => task, /Stopped/);
});

test("large ranges are read in complete bounded chunks; merge omission needs an explicit success; rename keeps identity", async (t) => {
  const f = await fixture(t);
  const base = f.reader.run.bind(f.reader);
  let sheetTitle = "Wide";
  f.reader.run = async (op, input, signal) => {
    if (op === "sheet.workbook.get")
      return {
        sheets: [
          { sheet_id: "a", name: sheetTitle, range: "A1:ZZ8", type: "sheet" },
        ],
      };
    if (op === "sheet.get")
      return {
        name: "Wide book",
        sheets: [{ sheet_id: "a", title: sheetTitle }],
      };
    if (op === "sheet.merge.get") return { errcode: 0 };
    return base(op, input, signal);
  };
  let report = await run(f.service);
  assert.equal(report.status, "completed");
  assert(f.reader.calls.filter(([op]) => op === "sheet.cells.get").length >= 2);
  for (const [op, input] of f.reader.calls)
    if (op === "sheet.cells.get") {
      const r = region(input.range);
      assert(r.cols * r.rows <= 4000);
    }
  const filename = report.items[0].outputs[0].target;
  sheetTitle = "Renamed sheet";
  f.reader.version++;
  report = await run(f.service);
  assert.equal(report.items[0].outputs[0].target, filename);
  assert.match(
    await fs.readFile(path.join(f.service.inbox, filename), "utf8"),
    /Renamed sheet/,
  );
  f.config.maxCells = 10;
  f.reader.version++;
  assert.match((await run(f.service)).items[0].error, /exceeds 10 cells/);
});
test("request timeouts kill the CLI native child, bounded retries recover transient reads, and no late side effects survive cancellation", async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.dataDir, "retry-cli"),
    counter = path.join(f.dataDir, "counter");
  await fs.writeFile(
    bin,
    `#!${process.execPath}\nconst fs=require('node:fs');const n=Number(fs.existsSync(${JSON.stringify(counter)})?fs.readFileSync(${JSON.stringify(counter)},'utf8'):0)+1;fs.writeFileSync(${JSON.stringify(counter)},String(n));console.log(JSON.stringify(n<2?{error:{code:429,message:'Rate limit'}}:{version:2}));`,
    { mode: 0o700 },
  );
  const cli = new CliReader({ ...f.config, cliBin: bin });
  assert.equal(
    (await cli.run("sheet.version.get", {}, new AbortController().signal))
      .version,
    2,
  );
  assert.equal(await fs.readFile(counter, "utf8"), "2");
  const marker = path.join(f.dataDir, "late-write"),
    wrapper = path.join(f.dataDir, "wrapper"),
    ready = path.join(f.dataDir, "child-ready");
  await fs.writeFile(
    wrapper,
    `#!${process.execPath}\nconst {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),700);`)}],{stdio:'inherit'});`,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  const request = new CliReader({
    ...f.config,
    cliBin: wrapper,
    attempts: 1,
  }).run("sheet.version.get", {}, controller.signal);
  for (let n = 0; n < 100; n++) {
    if (await fs.stat(ready).catch(() => null)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(await fs.stat(ready));
  controller.abort(Error("cancel group"));
  await assert.rejects(() => request, /cancel group/);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await fs.stat(marker).catch(() => null), null);
  const timed = new CliReader({
    ...f.config,
    cliBin: wrapper,
    timeoutMs: 100,
    attempts: 1,
  });
  await assert.rejects(
    () => timed.run("sheet.version.get", {}, new AbortController().signal),
    /timed out/,
  );
});

test("sparse merged layouts do not expand unrelated empty row/column products", () => {
  const snapshot = {
    schema: 1,
    docid: "e3_layout",
    kind: "sheet",
    title: "Layout",
    coverage: [],
    sections: [],
  };
  const section = {
    key: "sheet",
    title: "Sheet",
    cells: [
      { at: "A1", value: "Vertical" },
      { at: "B1", value: "Horizontal" },
    ],
    merges: ["A1:A5000", "B1:XFD1"],
  };
  const body = markdown(snapshot, section);
  assert(body.length < 4 * 1048576);
  assert.match(body, /\| 5000 \| Vertical \(merged from A1\)/);
  assert.match(body, /XFD/);
});
test("worksheet keys are data even when they match JavaScript prototype names", async (t) => {
  const f = await fixture(t);
  const original = f.reader.run.bind(f.reader);
  f.reader.run = async (op, input, signal) => {
    if (op === "sheet.workbook.get")
      return {
        sheets: [
          {
            sheet_id: "__proto__",
            name: "Sheet",
            type: "sheet",
            range: "A1:C3",
          },
        ],
      };
    if (op === "sheet.get")
      return {
        name: "Book",
        sheets: [{ sheet_id: "__proto__", title: "Sheet" }],
      };
    return original(op, input, signal);
  };
  assert.equal((await run(f.service)).items[0].status, "delivered");
  f.reader.version++;
  assert.equal((await run(f.service)).items[0].status, "unchanged");
  const state = JSON.parse(
    await fs.readFile(path.join(f.service.root, "state.json"), "utf8"),
  );
  assert(Object.hasOwn(state.sources[hash("e3_one")].sections, "__proto__"));
});
