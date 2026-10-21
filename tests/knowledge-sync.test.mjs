import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SyncService } from "../dist/knowledge-sync/service.js";
import { Publisher } from "../dist/knowledge-sync/publication.js";
import { buildPlan } from "../dist/knowledge-sync/validation.js";
import {
  catalog,
  hash,
  fingerprint,
  knowledgeLock,
  emptyUsage,
} from "../dist/knowledge-sync/core.js";
import { createConverter } from "../dist/knowledge-sync/converter.js";
import { fileToolConfig } from "../dist/file-tools/config.js";
import { publishedSearchTools } from "../dist/knowledge-sync/read-tools.js";

const old = "DT610/specs/default_202601010000/spec.md";
const next = "DT610/specs/default_202610190000/spec.md";
const hub = "product-knowledge-vault/products/DT610.md";
const idx = "product-knowledge-vault/index.md",
  log = "product-knowledge-vault/log.md";
function proposal(input, action = "update") {
  const deletion = action === "delete";
  const staged = new Map([
    [
      hub,
      deletion
        ? "# DT610\nNo current specifications."
        : `# DT610\n${next}\nConverted; original removed after successful sync`,
    ],
    [idx, "[[products/DT610|DT610]]"],
    [log, "Updated DT610"],
  ]);
  return {
    decision: {
      action,
      reason: "已核对版本与来源",
      summary: "更新资料和索引",
      products: ["DT610"],
      slot: "specs",
      oldPaths: [old],
      ...(deletion ? {} : { newPath: next }),
      versionEvidence:
        "Source explicitly identifies revision 2 replacing revision 1",
      authorizedException: false,
      reviewedPaths: [hub, idx],
    },
    staged,
  };
}
async function setup(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-sync-"));
  const data = path.join(root, ".data"),
    knowledge = path.join(data, "urovo-product-expert");
  for (const [p, text] of [
    [old, "# DT610 revision 1\nRAM 4 GB"],
    [hub, `# DT610\n${old}`],
    [idx, "[[products/DT610|DT610]]"],
    [log, "old log"],
    ["SKILL.md", "protected skill"],
    ["MEMORY.md", "protected memory"],
  ]) {
    const f = path.join(knowledge, p);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  }
  const service = new SyncService({
    dataDir: data,
    maxBytes: 30 * 1048576,
    timeoutMs: 30000,
    modelId: () => "fixture-model",
    redact: (e) => e.message,
    planner: () => async (input) => proposal(input),
    converter: () => async (source) => ({
      markdown: await fs.readFile(source, "utf8"),
      coverage: ["Complete"],
      sourceHash: hash(await fs.readFile(source)),
      version: 1,
      visual: emptyUsage(),
    }),
    ...overrides,
  });
  await service.init();
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, data, knowledge, service };
}
async function upload(
  service,
  name = "spec.txt",
  text = "# DT610 revision 2\nRAM 8 GB",
) {
  return service.upload(
    name,
    (async function* () {
      yield Buffer.from(text);
    })(),
  );
}
async function done(service, id) {
  for (let n = 0; n < 500; n++) {
    const job = await service.get(id);
    if (!["queued", "running", "stopping"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Task did not finish");
}

test("verified update publishes source plus indexes, deletes binary/input, preserves protected files, records complete report", async (t) => {
  const f = await setup(t);
  const file = await upload(f.service);
  const report = await done(f.service, (await f.service.start([file.id])).id);
  const i = report.items[0];
  assert.equal(i.status, "published", i.reason);
  assert.equal(i.sourceDeleted, true);
  assert.equal(
    await fs.readFile(path.join(f.knowledge, next), "utf8"),
    "# DT610 revision 2\nRAM 8 GB",
  );
  assert.equal(
    await fs.stat(path.join(f.knowledge, old)).catch(() => null),
    null,
  );
  assert.match(
    await fs.readFile(path.join(f.knowledge, hub), "utf8"),
    /202610190000/,
  );
  assert.equal(
    await fs.readFile(path.join(f.knowledge, "MEMORY.md"), "utf8"),
    "protected memory",
  );
  assert.ok(i.plan.changes.some((c) => c.path === old && c.after === null));
  assert.equal((await f.service.incoming()).length, 0);
  const duplicate = await upload(f.service);
  const d = await done(f.service, (await f.service.start([duplicate.id])).id);
  assert.equal(d.items[0].status, "duplicate");
  assert.equal(d.items[0].sourceDeleted, true);
});

test("review retains original; feedback makes a new attempt and unchanged current version is used", async (t) => {
  let observed;
  const f = await setup(t, {
    planner: () => async (input) => {
      observed = input.feedback;
      return input.feedback
        ? proposal(input)
        : {
            decision: {
              ...proposal(input).decision,
              action: "review",
              reason: "同版本，需要确认",
            },
            staged: new Map(),
          };
    },
  });
  const file = await upload(f.service);
  const first = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(first.items[0].status, "needs_review");
  assert.equal((await f.service.incoming()).length, 1);
  const second = await done(
    f.service,
    (await f.service.resync(first.id, first.items[0].id, "确认采用这一版")).id,
  );
  assert.equal(observed, "确认采用这一版");
  assert.equal(second.id, first.id);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].status, "published", second.items[0].reason);
  assert.equal(second.items[0].previous, first.items[0].id);
  assert.deepEqual(
    second.items[0].attempts.map((a) => [a.id, a.status]),
    [[first.items[0].id, "needs_review"]],
  );
  assert.equal(f.service.list().length, 1);
});

test("new-product suggestions remain drafts; per-file Re-Sync uses only submitted instructions and current knowledge", async (t) => {
  const suggestion =
    "这是新产品 T5000，允许创建产品目录。将这份修改记录放入 T5000/others，并创建产品 Hub、更新相关索引。";
  const source = "T5000/others/changelog_202610200000/changes.md";
  const productHub = "product-knowledge-vault/products/T5000.md";
  const seen = [];
  const f = await setup(t, {
    planner: () => async (input) => {
      seen.push({
        feedback: input.feedback,
        index: input.base.get(idx),
        batch: input.batch.length,
      });
      const decision = {
        ...proposal(input, "add").decision,
        products: ["T5000"],
        slot: "others",
        oldPaths: [],
        newPath: source,
        reviewedPaths: [idx],
        reason: "新产品需确认",
      };
      if (!input.feedback)
        return {
          decision: {
            ...decision,
            action: "review",
            suggestedFeedback: suggestion,
          },
          staged: new Map([[idx, "This must never publish during review"]]),
        };
      return {
        decision,
        staged: new Map([
          [
            productHub,
            `# T5000\n${source}\nConverted; original removed after successful sync`,
          ],
          [idx, `${input.base.get(idx)}\n[[products/T5000|T5000]]`],
          [log, "Added T5000"],
        ]),
      };
    },
  });
  const a = await upload(f.service, "T5000.txt", "T5000 revision history"),
    b = await upload(f.service, "other.txt", "Other unresolved document");
  const first = await done(f.service, (await f.service.start([a.id, b.id])).id);
  assert.ok(
    first.items.every((i) => i.status === "needs_review" && i.feedback === ""),
  );
  assert.equal(first.items[0].plan.decision.suggestedFeedback, suggestion);
  assert.deepEqual(first.items[0].plan.changes, []);
  assert.equal((await f.service.incoming()).length, 2);
  assert.equal(
    await fs.stat(path.join(f.knowledge, source)).catch(() => null),
    null,
  );
  const empty = await done(
    f.service,
    (await f.service.resync(first.id, first.items[0].id, "")).id,
  );
  assert.equal(empty.items[0].status, "needs_review");
  assert.equal(seen.at(-1).feedback, "");
  await fs.appendFile(
    path.join(f.knowledge, idx),
    "\nExternal update before Re-Sync",
  );
  const edited = suggestion + " 保留已有的外部索引更新。";
  const second = await done(
    f.service,
    (await f.service.resync(first.id, first.items[0].id, edited)).id,
  );
  assert.equal(second.id, first.id);
  assert.equal(second.items.length, 2);
  assert.equal(second.items[0].status, "published", second.items[0].reason);
  assert.equal(second.items[0].attempts.length, 2);
  assert.ok(second.items[0].attempts.every((a) => a.feedback === ""));
  assert.equal(seen.at(-1).feedback, edited);
  assert.equal(seen.at(-1).batch, 1);
  assert.match(seen.at(-1).index, /External update before Re-Sync/);
  assert.match(
    await fs.readFile(path.join(f.knowledge, idx), "utf8"),
    /External update before Re-Sync/,
  );
  assert.equal((await f.service.incoming()).length, 1);
  assert.equal(second.items[1].status, "needs_review");
  assert.equal(second.items[1].id, first.items[1].id);
});

test("suggestions cannot accompany publication or exceed the feedback limit", () => {
  const d = { ...proposal({}).decision, suggestedFeedback: "Authorize this" };
  for (const invalid of [
    d,
    { ...d, action: "review", suggestedFeedback: " " },
    { ...d, action: "review", suggestedFeedback: "X".repeat(16001) },
  ])
    assert.throws(
      () => buildPlan(new Map(), new Map(), invalid, "text", ""),
      /review-only drafts/,
    );
});

test("delete preview has no mutations, requires confirmation, and stale preview fails closed", async (t) => {
  const f = await setup(t, {
    planner: () => async (input) => proposal(input, "delete"),
  });
  const preview = await done(
    f.service,
    (await f.service.preview("删除过时的 DT610 规格")).id,
  );
  assert.equal(preview.status, "awaiting_confirmation");
  assert.ok(await fs.stat(path.join(f.knowledge, old)));
  await fs.appendFile(path.join(f.knowledge, old), "\nexternal change");
  const bad = await done(f.service, (await f.service.confirm(preview.id)).id);
  assert.equal(bad.items[0].status, "failed");
  assert.ok(await fs.stat(path.join(f.knowledge, old)));
  const p2 = await done(
    f.service,
    (await f.service.preview("删除过时的 DT610 规格")).id,
  );
  const result = await done(f.service, (await f.service.confirm(p2.id)).id);
  assert.equal(result.items[0].status, "deleted");
  assert.equal(result.confirmed, true);
  assert.equal(
    await fs.stat(path.join(f.knowledge, old)).catch(() => null),
    null,
  );
  assert.equal(
    await fs.readFile(path.join(f.knowledge, "SKILL.md"), "utf8"),
    "protected skill",
  );
});

test("path traversal, symlinks, protected writes, incomplete indexes and occupied slots are rejected", async (t) => {
  const f = await setup(t);
  await assert.rejects(upload(f.service, "../escape.md"), /Invalid/);
  await assert.rejects(upload(f.service, "MEMORY.md"), /Invalid/);
  const base = await catalog(f.knowledge);
  const p = proposal({});
  p.staged.set("MEMORY.md", "bad");
  assert.throws(
    () => buildPlan(base, p.staged, p.decision, "new", ""),
    /cannot edit/,
  );
  p.staged.delete("MEMORY.md");
  p.staged.set(hub, "missing source");
  assert.throws(
    () => buildPlan(base, p.staged, p.decision, "new", ""),
    /coverage/,
  );
  p.staged.set(hub, `${old}\n${next}`);
  assert.throws(
    () => buildPlan(base, p.staged, p.decision, "new", ""),
    /Old source/,
  );
  p.decision.action = "add";
  p.decision.oldPaths = [];
  assert.throws(
    () => buildPlan(base, p.staged, p.decision, "new", ""),
    /Slot already|Multiple current/,
  );
  await fs.mkdir(path.join(f.knowledge, "newly_added"), { recursive: true });
  await fs.symlink(
    path.join(f.knowledge, "MEMORY.md"),
    path.join(f.knowledge, "newly_added", "linked.md"),
  );
  const inputs = await f.service.incoming();
  assert.match(inputs.find((i) => i.name === "linked.md").error, /links/);
});

test("publication waits for readers, rolls back prepared transactions at restart, rejects baseline changes", async (t) => {
  const f = await setup(t);
  const base = await catalog(f.knowledge),
    p = proposal({});
  const plan = buildPlan(base, p.staged, p.decision, "new", "");
  const release = await knowledgeLock(f.knowledge).read();
  let completed = false;
  const pending = f.service.publisher
    .publish("fixture", plan, new AbortController().signal)
    .then(() => (completed = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(completed, false);
  assert.ok(await fs.stat(path.join(f.knowledge, old)));
  release();
  await pending;
  assert.equal(completed, true);
  await assert.rejects(
    f.service.publisher.publish("again", plan, new AbortController().signal),
    /Knowledge changed/,
  );
  const transaction = {
    state: "prepared",
    created: new Date().toISOString(),
    changes: [
      { path: next, before: "old before crash", after: "partially written" },
    ],
  };
  await fs.writeFile(
    path.join(f.service.directory, "transactions/crash.json"),
    JSON.stringify(transaction),
  );
  await fs.writeFile(path.join(f.knowledge, next), "partially written");
  await f.service.publisher.recover();
  assert.equal(
    await fs.readFile(path.join(f.knowledge, next), "utf8"),
    "old before crash",
  );
});

test("failure/cancellation preserve incoming files; simultaneous starts are rejected", async (t) => {
  let enter;
  const entered = new Promise((r) => (enter = r));
  const f = await setup(t, {
    converter: () => async (_s, _d, signal) => {
      enter();
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error("cancelled")), {
          once: true,
        }),
      );
    },
  });
  const file = await upload(f.service);
  const job = await f.service.start([file.id]);
  await entered;
  await assert.rejects(f.service.start([file.id]), /already active/);
  await f.service.stop(job.id);
  const report = await done(f.service, job.id);
  assert.equal(report.items[0].status, "stopped");
  assert.equal((await f.service.incoming()).length, 1);
  assert.ok(await fs.stat(path.join(f.knowledge, old)));
});

test("native published search cannot include inbox even with an overriding glob", async (t) => {
  const f = await setup(t);
  await upload(f.service, "private.md", "UNPUBLISHED_SENTINEL");
  const tools = publishedSearchTools(f.knowledge);
  for (const name of ["grep", "find", "ls"]) {
    const tool = tools.find((t) => t.name === name);
    const result = await tool.execute(
      "test",
      name === "grep"
        ? { pattern: "UNPUBLISHED_SENTINEL", path: f.knowledge, glob: "**/*" }
        : name === "find"
          ? { pattern: "**/*", path: f.knowledge }
          : { path: f.knowledge },
    );
    assert.ok(!JSON.stringify(result).includes("UNPUBLISHED_SENTINEL"));
    assert.ok(!JSON.stringify(result).includes("newly_added"));
  }
});

test("real native UTF-8 and XLSX conversions preserve data without vision or chat output truncation", async (t) => {
  const f = await setup(t);
  const { default: ExcelJS } = await import("exceljs");
  const file = path.join(f.root, "book.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("参数");
  sheet.getCell("A1").value = "电池";
  sheet.getCell("B1").value = 5000;
  sheet.getCell("A2").value = { formula: "B1*2", result: 10000 };
  sheet.getCell("A2").note = "单位 mAh";
  book.addWorksheet("Second").getCell("A1").value = "second sheet";
  await book.xlsx.writeFile(file);
  const cfg = fileToolConfig(f.data, {
    markitdown: "unused",
    timeoutMs: 30000,
  });
  const convert = createConverter(
    cfg,
    "missing-soffice",
    128,
    async () => () => {},
  );
  const result = await convert(
    file,
    path.join(f.root, "convert"),
    new AbortController().signal,
    emptyUsage(),
    async () => {},
  );
  assert.match(result.markdown, /5000/);
  assert.match(result.markdown, /B1\*2/);
  assert.match(result.markdown, /单位 mAh/);
  assert.match(result.markdown, /second sheet/);
  const text = path.join(f.root, "input.md");
  await fs.writeFile(text, "# Exact\r\n" + "long data\n".repeat(10000));
  const out = await convert(
    text,
    path.join(f.root, "text-convert"),
    new AbortController().signal,
    emptyUsage(),
    async () => {},
  );
  assert.equal(out.markdown, await fs.readFile(text, "utf8"));
  assert.equal(out.visual.requests, 0);
});

test("same-batch identical inputs publish once, classify the second duplicate, and clean both originals", async (t) => {
  const f = await setup(t);
  const first = await upload(f.service, "one.md");
  const second = await upload(f.service, "two.md");
  const job = await done(
    f.service,
    (await f.service.start([first.id, second.id])).id,
  );
  assert.deepEqual(
    job.items.map((i) => i.status),
    ["published", "duplicate"],
  );
  assert.ok(job.items.every((i) => i.sourceDeleted));
});

test("source changes during conversion fail closed and queued readers can be cancelled", async (t) => {
  const f = await setup(t, {
    converter: () => async () => ({
      markdown: "wrong snapshot",
      sourceHash: "changed",
      coverage: [],
      version: 1,
      visual: emptyUsage(),
    }),
  });
  const file = await upload(f.service);
  const job = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(job.items[0].status, "failed");
  assert.match(job.items[0].reason, /changed/);
  assert.equal((await f.service.incoming()).length, 1);
  const lock = knowledgeLock(f.knowledge),
    release = await lock.write(),
    controller = new AbortController();
  const pending = lock.read(controller.signal);
  controller.abort();
  await assert.rejects(pending);
  release();
  const read = await lock.read();
  read();
});

test("restart marks unfinished work Interrupted and preserves input; successful Re-Sync cleans old attempt workspace", async (t) => {
  let review = true;
  const f = await setup(t, {
    planner: () => async (input) =>
      review
        ? {
            decision: { ...proposal(input).decision, action: "review" },
            staged: new Map(),
          }
        : proposal(input),
  });
  const file = await upload(f.service);
  const first = await done(f.service, (await f.service.start([file.id])).id);
  const work = path.join(f.service.directory, "work", first.items[0].id);
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, "source.pdf"), "temporary binary");
  first.status = "running";
  first.items[0].status = "running";
  await fs.writeFile(
    path.join(f.service.directory, "jobs", first.id + ".json"),
    JSON.stringify(first),
  );
  await f.service.close();
  const restored = new SyncService(f.service.options);
  await restored.init();
  t.after(() => restored.close());
  assert.equal((await restored.get(first.id)).items[0].status, "interrupted");
  review = false;
  const second = await done(
    restored,
    (await restored.resync(first.id, first.items[0].id, "采用新版本", true)).id,
  );
  assert.equal(second.items[0].status, "published");
  assert.equal(await fs.stat(work).catch(() => null), null);
  await restored.close();
});

test("legacy deletion audit forces review on exact reintroduction without blocking the upload", async (t) => {
  let deletion = true;
  let sawAudit = false;
  const f = await setup(t, {
    planner: () => async (input) => {
      sawAudit = input.deletions.length > 0;
      if (deletion) return proposal(input, "delete");
      const p = proposal(input, "add");
      p.decision.oldPaths = [];
      return p;
    },
  });
  const preview = await done(f.service, (await f.service.preview("legacy")).id);
  await done(f.service, (await f.service.confirm(preview.id)).id);
  deletion = false;
  const file = await upload(
    f.service,
    "legacy.md",
    "# DT610 revision 1\nRAM 4 GB",
  );
  const report = await done(f.service, (await f.service.start([file.id])).id);
  assert.ok(sawAudit);
  assert.equal(report.items[0].status, "needs_review");
  assert.match(report.items[0].reason, /previously deleted/);
  assert.equal((await f.service.incoming()).length, 1);
});

test("new product requires feedback; encoded and relative source dependencies cannot remain stale", async (t) => {
  const { dependents } = await import("../dist/knowledge-sync/validation.js");
  const f = await setup(t);
  const base = await catalog(f.knowledge);
  const oldSpace = "DT610/specs/old_202601010000/spec sheet.md";
  base.set(oldSpace, "old");
  const derived = "product-knowledge-vault/comparisons/example.md";
  base.set(
    derived,
    "[Source](../../DT610/specs/old_202601010000/spec%20sheet.md)",
  );
  assert.ok(dependents(base, [oldSpace]).includes(derived));
  const p = proposal({}, "add");
  p.decision.products = ["NEW"];
  p.decision.oldPaths = [];
  p.decision.newPath = "NEW/specs/default_202610200000/spec.md";
  assert.throws(
    () => buildPlan(base, p.staged, p.decision, "new", ""),
    /New products require/,
  );
});

test("cleanup never deletes a changed input and retry does not republish; 90-day pruning leaves reports intact", async (t) => {
  let fixture;
  const f = await setup(t, {
    planner: () => async (input) => {
      await fs.writeFile(
        path.join(fixture.knowledge, "newly_added", "spec.txt"),
        "newly changed input",
      );
      return proposal(input);
    },
  });
  fixture = f;
  const file = await upload(f.service);
  const job = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(job.items[0].status, "published");
  assert.match(job.items[0].cleanupError, /changed/);
  assert.equal(
    await fs.readFile(
      path.join(f.knowledge, "newly_added", "spec.txt"),
      "utf8",
    ),
    "newly changed input",
  );
  await fs.writeFile(
    path.join(f.knowledge, "newly_added", "spec.txt"),
    "# DT610 revision 2\nRAM 8 GB",
  );
  const cleaned = await f.service.cleanup(job.id, job.items[0].id);
  assert.equal(cleaned.items[0].sourceDeleted, true);
  assert.equal(cleaned.items[0].status, "published");
  const journal = path.join(
    f.service.directory,
    "transactions",
    job.items[0].id + ".json",
  );
  const data = JSON.parse(await fs.readFile(journal, "utf8"));
  data.created = "2020-01-01T00:00:00Z";
  await fs.writeFile(journal, JSON.stringify(data));
  await f.service.publisher.prune();
  assert.equal(await fs.stat(journal).catch(() => null), null);
  assert.equal((await f.service.get(job.id)).items[0].plan.changes.length, 4);
});

test("Sync streams exactly 100 MiB and rejects one extra byte without leaving a partial input", async (t) => {
  const { SYNC_MAX_FILE_BYTES } = await import(
    "../dist/knowledge-sync/config.js"
  );
  const f = await setup(t, { maxBytes: SYNC_MAX_FILE_BYTES });
  const chunk = Buffer.alloc(1048576, 0x41);
  const stream = async function* (overflow = false) {
    for (let n = 0; n < 100; n++) yield chunk;
    if (overflow) yield Buffer.from([1]);
  };
  const accepted = await f.service.upload("boundary.pdf", stream());
  assert.equal(accepted.bytes, 100 * 1048576);
  assert.equal(
    (await fs.stat(path.join(f.service.inbox, "boundary.pdf"))).size,
    100 * 1048576,
  );
  await assert.rejects(
    f.service.upload("overflow.pdf", stream(true)),
    (e) => e.status === 413 && e.message.includes("100 MB"),
  );
  assert.deepEqual(await fs.readdir(f.service.inbox), ["boundary.pdf"]);
  const ignored = await f.service.upload(
    "readme.MD",
    (async function* () {
      yield Buffer.from("Guide");
    })(),
  );
  assert.equal(ignored.ignored, true);
  assert.deepEqual(await fs.readdir(f.service.inbox), ["boundary.pdf"]);
});

test("backend appends operation log without rewriting history and requires per-file confirmation for a noncanonical existing Hub", async (t) => {
  const customHub = "product-knowledge-vault/products/DT-610.md";
  const f = await setup(t, {
    planner: () => async (input) => {
      const p = proposal(input);
      p.staged.set(customHub, p.staged.get(hub));
      p.staged.delete(hub);
      p.staged.delete(log);
      p.staged.set(idx, "[[products/DT-610|DT610]]");
      p.decision.productHubs = [{ product: "DT610", path: customHub }];
      p.decision.reviewedPaths = [customHub, idx];
      p.decision.logEntry = "Only this operation; do not repeat history.";
      return p;
    },
  });
  await fs.rename(
    path.join(f.knowledge, hub),
    path.join(f.knowledge, customHub),
  );
  await fs.writeFile(path.join(f.knowledge, idx), "[[products/DT-610|DT610]]");
  const history = `# History\n${old}\n` + "historical entry\n".repeat(7000);
  await fs.writeFile(path.join(f.knowledge, log), history);
  const file = await upload(f.service);
  const report = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(report.status, "awaiting_confirmation", report.items[0].reason);
  assert.match(report.items[0].plan.confirmationReason, /DT610 → .*DT-610/);
  assert.equal(await fs.readFile(path.join(f.knowledge, log), "utf8"), history);
  assert.ok(await fs.stat(path.join(f.knowledge, "newly_added/spec.txt")));
  await assert.rejects(f.service.confirm(report.id, "unrelated"), /No pending/);
  await f.service.confirm(report.id, report.items[0].id);
  const published = await done(f.service, report.id);
  assert.equal(
    published.items[0].status,
    "published",
    published.items[0].reason,
  );
  assert.equal(published.items[0].sourceDeleted, true);
  const result = await fs.readFile(path.join(f.knowledge, log), "utf8");
  assert.ok(result.startsWith(history));
  assert.equal(result.match(/Only this operation/g).length, 1);
  assert.equal(
    await fs.stat(path.join(f.knowledge, hub)).catch(() => null),
    null,
  );
});

test("Hub confirmation detects intervening library changes and retains input", async (t) => {
  const customHub = "product-knowledge-vault/products/DT-610.md";
  const f = await setup(t, {
    planner: () => async (input) => {
      const p = proposal(input);
      p.staged.set(customHub, p.staged.get(hub));
      p.staged.delete(hub);
      p.staged.set(idx, "[[products/DT-610|DT610]]");
      p.decision.productHubs = [{ product: "DT610", path: customHub }];
      p.decision.reviewedPaths = [customHub, idx];
      return p;
    },
  });
  await fs.rename(
    path.join(f.knowledge, hub),
    path.join(f.knowledge, customHub),
  );
  const file = await upload(f.service);
  const report = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(report.status, "awaiting_confirmation", report.items[0].reason);
  await fs.writeFile(path.join(f.knowledge, idx), "External update");
  await f.service.confirm(report.id, report.items[0].id);
  const stale = await done(f.service, report.id);
  assert.equal(stale.items[0].status, "failed");
  assert.match(stale.items[0].reason, /Knowledge changed/);
  assert.ok(await fs.stat(path.join(f.knowledge, "newly_added/spec.txt")));
  assert.ok(await fs.stat(path.join(f.knowledge, old)));
});

test("sequential batch exposes converting, converted waiting and analyzing independently", async (t) => {
  let resumeConversion, resumeAnalysis, signalAnalysis;
  const conversionGate = new Promise((r) => (resumeConversion = r));
  const analysisGate = new Promise((r) => (resumeAnalysis = r));
  const analyzing = new Promise((r) => (signalAnalysis = r));
  t.after(() => {
    resumeConversion();
    resumeAnalysis();
  });
  let calls = 0;
  const f = await setup(t, {
    converter: () => async (source) => {
      if (++calls === 2) await conversionGate;
      return {
        markdown: "candidate",
        sourceHash: hash(await fs.readFile(source)),
        coverage: ["Complete"],
        visual: emptyUsage(),
        version: 1,
      };
    },
    planner: () => async () => {
      signalAnalysis();
      await analysisGate;
      return {
        decision: { ...proposal({}).decision, action: "review" },
        staged: new Map(),
      };
    },
  });
  const a = await upload(f.service, "a.txt", "a"),
    b = await upload(f.service, "b.txt", "b"),
    c = await upload(f.service, "c.txt", "c");
  const job = await f.service.start([a.id, b.id, c.id]);
  for (let n = 0; n < 500 && calls < 2; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2);
  assert.deepEqual(
    (await f.service.get(job.id)).items.map((i) => i.status),
    ["converted", "converting", "queued"],
  );
  resumeConversion();
  await analyzing;
  assert.deepEqual(
    (await f.service.get(job.id)).items.map((i) => i.status),
    ["analyzing", "converted", "converted"],
  );
  resumeAnalysis();
  assert.equal((await done(f.service, job.id)).status, "completed");
});

test("multiple Hub previews wait for the batch, require explicit item selection and reject stale later confirmations", async (t) => {
  let resume, entered;
  const gate = new Promise((r) => (resume = r));
  const inSecond = new Promise((r) => (entered = r));
  t.after(() => resume());
  let attempts = 0;
  const customHub = "product-knowledge-vault/products/DT-610.md";
  const f = await setup(t, {
    planner: () => async (input) => {
      if (++attempts === 2) {
        entered();
        await gate;
      }
      const p = proposal(input);
      p.staged.set(customHub, p.staged.get(hub));
      p.staged.delete(hub);
      p.staged.set(idx, "[[products/DT-610|DT610]]");
      p.decision.productHubs = [{ product: "DT610", path: customHub }];
      p.decision.reviewedPaths = [customHub, idx];
      return p;
    },
  });
  await fs.rename(
    path.join(f.knowledge, hub),
    path.join(f.knowledge, customHub),
  );
  await fs.writeFile(path.join(f.knowledge, idx), "[[products/DT-610|DT610]]");
  const a = await upload(f.service, "a.txt"),
    b = await upload(f.service, "b.txt");
  const job = await f.service.start([a.id, b.id]);
  await inSecond;
  const active = await f.service.get(job.id);
  assert.equal(active.status, "running");
  assert.equal(active.items[0].status, "awaiting_confirmation");
  assert.equal(active.items[1].status, "analyzing");
  await assert.rejects(
    f.service.confirm(job.id, active.items[0].id),
    /No pending/,
  );
  resume();
  const ready = await done(f.service, job.id);
  assert.equal(ready.status, "awaiting_confirmation");
  await assert.rejects(f.service.confirm(job.id), /Choose one pending file/);
  await f.service.confirm(job.id, ready.items[0].id);
  const first = await done(f.service, job.id);
  assert.equal(first.items[0].status, "published");
  assert.equal(first.items[1].status, "awaiting_confirmation");
  await f.service.confirm(job.id, ready.items[1].id);
  const second = await done(f.service, job.id);
  assert.equal(second.items[1].status, "failed");
  assert.match(second.items[1].reason, /Knowledge changed/);
  assert.ok(await fs.stat(path.join(f.knowledge, "newly_added/b.txt")));
});

test("Hub names differing only by spacing resolve automatically without confirmation or index edits", async (t) => {
  const product = "K388 Pro",
    current = "K388 Pro/specs/default_202601010000/spec.md",
    added = "K388 Pro/others/release-notes_202610210000/notes.md",
    spaced = "product-knowledge-vault/products/K388-Pro.md";
  const f = await setup(t, {
    planner: () => async () => ({
      decision: {
        action: "add",
        reason: "固件发布记录",
        summary: "新增 others 资料",
        products: [product],
        slot: "others",
        oldPaths: [],
        newPath: added,
        versionEvidence: "",
        authorizedException: false,
        reviewedPaths: [],
      },
      staged: new Map([[spaced, `# K388 Pro\n${current}\n${added}`]]),
    }),
  });
  for (const [p, text] of [
    [current, "# K388 Pro spec"],
    [spaced, `# K388 Pro\n${current}`],
  ]) {
    await fs.mkdir(path.dirname(path.join(f.knowledge, p)), {
      recursive: true,
    });
    await fs.writeFile(path.join(f.knowledge, p), text);
  }
  const { resolveHub } = await import("../dist/knowledge-sync/validation.js");
  assert.equal(resolveHub(await catalog(f.knowledge), product), spaced);
  const file = await upload(f.service, "notes.txt", "K388 Pro release notes");
  const report = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(report.items[0].status, "published", report.items[0].reason);
  assert.equal(report.items[0].plan.confirmationReason, undefined);
  assert.ok(await fs.stat(path.join(f.knowledge, added)));
});

test("deletion plans map original binaries to their Markdown and report every problem at once", async (t) => {
  const f = await setup(t);
  const base = await catalog(f.knowledge);
  const p = proposal({}, "delete");
  p.decision.oldPaths = [old, old.replace(/\.md$/, ".pdf")];
  const plan = buildPlan(base, p.staged, p.decision, "", "", true);
  assert.deepEqual(plan.decision.oldPaths, [old]);
  const bad = proposal({});
  bad.staged.set("product-knowledge-vault/products/OTHER.md", "# Other");
  bad.staged.set(hub, "missing sources");
  bad.decision.reason = "";
  assert.throws(
    () => buildPlan(base, bad.staged, bad.decision, "new", ""),
    (e) =>
      e.problems.length >= 3 &&
      e.review === false &&
      e.problems.some((m) => /Unrelated product Hub change/.test(m)) &&
      e.problems.some((m) => /coverage is incomplete/.test(m)) &&
      e.problems.some((m) => /decision and change explanation/.test(m)),
  );
});

test("validation failures are Failed, not Needs review, and Re-Sync retries in the same report", async (t) => {
  let broken = true;
  const f = await setup(t, {
    planner: () => async (input) => {
      const p = proposal(input);
      if (broken) p.staged.set(hub, "Hub without source coverage");
      return p;
    },
  });
  const file = await upload(f.service);
  const first = await done(f.service, (await f.service.start([file.id])).id);
  assert.equal(first.items[0].status, "failed");
  assert.match(first.items[0].reason, /coverage is incomplete/);
  assert.equal((await f.service.incoming()).length, 1);
  broken = false;
  const second = await done(
    f.service,
    (await f.service.resync(first.id, first.items[0].id, "")).id,
  );
  assert.equal(second.id, first.id);
  assert.equal(second.items[0].status, "published", second.items[0].reason);
  assert.equal(second.items[0].attempts[0].status, "failed");
  assert.equal(f.service.list().length, 1);
  await assert.rejects(
    f.service.resync(first.id, first.items[0].id, ""),
    /already committed/,
  );
});

test("incoming files can be deleted only while no task is running", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = await setup(t, {
    planner: () => async (input) => {
      await gate;
      return {
        decision: { ...proposal(input).decision, action: "review", reason: "?" },
        staged: new Map(),
      };
    },
  });
  const keep = await upload(f.service, "keep.txt", "keep");
  const drop = await upload(f.service, "drop.txt", "drop");
  const job = await f.service.start([keep.id]);
  await assert.rejects(f.service.removeIncoming(drop.id), /already active/);
  release();
  const report = await done(f.service, job.id);
  assert.equal(report.items[0].status, "needs_review");
  assert.deepEqual(await f.service.removeIncoming(drop.id), {
    name: "drop.txt",
    removed: true,
  });
  await assert.rejects(f.service.removeIncoming(drop.id), /no longer exists/);
  await f.service.removeIncoming(keep.id);
  assert.equal((await f.service.incoming()).length, 0);
  await assert.rejects(
    f.service.resync(job.id, report.items[0].id, ""),
    /Original input is missing/,
  );
  assert.equal(f.service.busy, false);
});
