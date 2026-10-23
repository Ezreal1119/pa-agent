import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPlanner } from "../dist/knowledge-sync/agent.js";
import { WecomImportService } from "../dist/wecom-import/service.js";
import { wecomConfig } from "../dist/wecom-import/config.js";
import {
  incomingWecom,
  contextFor,
  indexes,
  sourceKey,
  verifyRetirement,
} from "../dist/knowledge-sync/wecom-sources.js";
import {
  buildPlan,
  dependents,
  resolveHub,
} from "../dist/knowledge-sync/validation.js";
import { hash, catalog, emptyUsage } from "../dist/knowledge-sync/core.js";
import { Publisher } from "../dist/knowledge-sync/publication.js";
import { KnowledgeLibrary } from "../dist/knowledge-sync/library.js";
import { createConverter } from "../dist/knowledge-sync/converter.js";
import { fileToolConfig } from "../dist/file-tools/config.js";
import { SyncService } from "../dist/knowledge-sync/service.js";
const old = "_shared/accessories/old-guide_202609182242/old.md",
  node = "product-knowledge-vault/shared/device-and-accessories-guide.md",
  hub = "product-knowledge-vault/products/UPad.md",
  main = "product-knowledge-vault/index.md",
  dock = "UPad/accessories/dock_202608281943/dock.md";
const docid = "e3_testguide";
async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sync-wecom-sources-"),
  );
  const root = path.join(dataDir, "urovo-product-expert");
  const config = wecomConfig(dataDir, dataDir, {});
  await fs.mkdir(config.authDir);
  await fs.writeFile(
    config.docsFile,
    JSON.stringify({ docid, description: "Human label" }) + "\n",
  );
  let version = 1,
    text = "Accessory A",
    title = "Device and Accessories Guide";
  const reader = {
    async run(op, input, signal) {
      signal.throwIfAborted();
      if (op === "sheet.version.get") return { version };
      if (op === "sheet.get")
        return {
          name: title,
          sheets: [
            { sheet_id: "a", title: "UPad" },
            { sheet_id: "b", title: "Common" },
          ],
        };
      if (op === "sheet.workbook.get")
        return {
          sheets: [
            { sheet_id: "a", name: "UPad", type: "sheet", range: "A1:A1" },
            { sheet_id: "b", name: "Common", type: "sheet", range: "A1:A1" },
          ],
        };
      if (op === "sheet.cells.get")
        return {
          cells: [[input.sheet === "a" ? text : "Common B"]],
          actual_range: input.range,
        };
      if (op === "sheet.merge.get") return { errcode: 0 };
      throw Error("Unexpected operation");
    },
  };
  const importer = new WecomImportService({
    dataDir,
    config,
    reader,
    disk: async () => {},
  });
  await importer.init();
  const write = async (p, s) => {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), s);
  };
  await write(
    old,
    "# Old complete workbook\nBoth UPad and Common. Image-only historical facts.",
  );
  await write(dock, "# Independent printer dock specification");
  await write(
    hub,
    `# UPad\n${dock}\n[[shared/device-and-accessories-guide|Guide]]`,
  );
  await write(
    node,
    `# Device and Accessories Guide\nOriginal overview with image-derived facts.\n${old}`,
  );
  await write(
    main,
    "# Index\n[[products/UPad|UPad]]\n[[shared/device-and-accessories-guide|Guide]]",
  );
  const route = {
    version: 1,
    documents: {
      [docid]: { indexPath: node, slot: "accessories", legacySources: [old] },
    },
  };
  await fs.mkdir(path.join(dataDir, "knowledge-sync"));
  await fs.writeFile(
    path.join(dataDir, "knowledge-sync/wecom-routing.json"),
    JSON.stringify(route),
  );
  t.after(async () => {
    await importer.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const collect = async () => {
    const r = await importer.start();
    await importer.wait();
    const report = await importer.get(r.id);
    assert.equal(report.status, "completed");
    return report.items[0].outputs;
  };
  const outputs = await collect();
  return {
    dataDir,
    root,
    importer,
    outputs,
    write,
    collect,
    change(value) {
      text = value;
      version++;
    },
    rename(value) {
      title = value;
      version++;
    },
  };
}
async function verified(f, output) {
  const body = await fs.readFile(
    path.join(f.importer.inbox, output.target),
    "utf8",
  );
  const input = await incomingWecom(f.dataDir, output.target, hash(body));
  return { body, input, base: await catalog(f.root) };
}
function proposed(ctx, base, stamp = "202610230001") {
  const next = `_shared/accessories/wecom-${sourceKey(ctx.docid, ctx.id)}_${stamp}/sheet.md`;
  return {
    decision: {
      action: ctx.previous ? "update" : "add",
      products: ["UPad"],
      slot: "accessories",
      oldPaths: ctx.previous ? [ctx.previous.path] : [],
      newPath: next,
      reason: "Verified online version and same sheet identity",
      summary: "Updated configurations without dropping other sources",
      versionEvidence: `Verified source version ${ctx.version}`,
      authorizedException: false,
      reviewedPaths: [
        hub,
        node,
        ...dependents(base, ctx.previous ? [ctx.previous.path] : []),
      ],
    },
    staged: new Map([
      [
        hub,
        `# UPad\n${[...base.keys()].filter((p) => p.startsWith("UPad/")).join("\n")}\n[[shared/device-and-accessories-guide|Guide]]`,
      ],
    ]),
  };
}
function makePlan(v, ctx, stamp) {
  const p = proposed(ctx, v.base, stamp);
  return buildPlan(
    v.base,
    p.staged,
    p.decision,
    v.body,
    "",
    false,
    undefined,
    ctx,
  );
}
async function publish(f, plan) {
  await new Publisher(f.root, path.join(f.dataDir, "knowledge-sync")).publish(
    crypto.randomUUID(),
    plan,
    new AbortController().signal,
  );
}

test("existing delivered files acquire verified identity; per-sheet shared publication preserves old workbook and occupied accessories slot", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]),
    ctx = contextFor(v.input, v.base),
    plan = makePlan(v, ctx);
  assert.equal(ctx.id, "a");
  await publish(f, plan);
  const base = await catalog(f.root);
  assert(base.has(old));
  assert(base.has(dock));
  assert.equal(indexes(base)[0].members.length, 1);
  assert.match(base.get(node), /Pending Sync/);
  assert.match(base.get(node), /Original overview with image-derived facts/);
  assert(base.get(node).includes("<!-- wecom-source-index:v1 "));
  assert(!base.get(node).includes("Accessory A"));
  assert(base.get(hub).includes(dock));
});
test("one changed sheet replaces only itself, remains discoverable through shared index and survives title changes", async (t) => {
  const f = await fixture(t);
  let v = await verified(f, f.outputs[0]);
  let ctx = contextFor(v.input, v.base);
  const first = makePlan(v, ctx);
  await publish(f, first);
  f.change("Accessory changed");
  const changed = await f.collect();
  assert.equal(changed.length, 1);
  v = await verified(f, changed[0]);
  ctx = contextFor(v.input, v.base);
  assert.equal(ctx.previous.path, first.decision.newPath);
  const plan = makePlan(v, ctx, "202610230002");
  assert.deepEqual(
    plan.changes.filter((c) => c.after === null).map((c) => c.path),
    [first.decision.newPath],
  );
  await publish(f, plan);
  assert((await catalog(f.root)).has(dock));
  assert((await catalog(f.root)).has(old));
  f.rename("Renamed Guide");
  const renamed = await f.collect();
  const again = await verified(
    f,
    renamed.find((o) => o.key === "a"),
  );
  assert.equal(
    contextFor(again.input, again.base).previous.path,
    plan.decision.newPath,
  );
});
test("cross-section, whole-workbook, product-local replacement and rewritten text are rejected by backend", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]),
    ctx = contextFor(v.input, v.base);
  for (const target of [
    old,
    dock,
    "_shared/accessories/some-other-sheet_202610230000/source.md",
  ]) {
    const p = proposed(ctx, v.base);
    p.decision.action = "update";
    p.decision.oldPaths = [target];
    assert.throws(
      () =>
        buildPlan(
          v.base,
          p.staged,
          p.decision,
          v.body,
          "approve",
          false,
          undefined,
          ctx,
        ),
      /ownership requires/,
    );
  }
  const p = proposed(ctx, v.base);
  p.decision.newPath = "UPad/accessories/guide_202610230003/guide.md";
  assert.throws(
    () =>
      buildPlan(
        v.base,
        p.staged,
        p.decision,
        v.body,
        "",
        false,
        undefined,
        ctx,
      ),
    /Do not occupy product-local/,
  );
  assert.throws(
    () =>
      buildPlan(
        v.base,
        proposed(ctx, v.base).staged,
        proposed(ctx, v.base).decision,
        v.body + "changed",
        "",
        false,
        undefined,
        ctx,
      ),
    /differs from the verified/,
  );
});
test("retirement is blocked for partial migration; once every sheet is published, explicit delete removes legacy overview and keeps all new sources", async (t) => {
  const f = await fixture(t);
  let v = await verified(f, f.outputs[0]);
  await publish(f, makePlan(v, contextFor(v.input, v.base)));
  let base = await catalog(f.root);
  const deletion = () => ({
    action: "delete",
    products: ["UPad"],
    slot: "accessories",
    oldPaths: [old],
    reason: "Retire legacy source after checked migration",
    summary: "Remove old complete workbook",
    versionEvidence: "Administrator deletion",
    authorizedException: false,
    reviewedPaths: [hub, node, ...dependents(base, [old])],
  });
  assert.throws(
    () =>
      buildPlan(
        base,
        new Map([[hub, base.get(hub)]]),
        deletion(),
        "",
        "delete",
        true,
      ),
    /retirement is blocked/,
  );
  v = await verified(f, f.outputs[1]);
  await publish(f, makePlan(v, contextFor(v.input, v.base), "202610230003"));
  base = await catalog(f.root);
  const plan = buildPlan(
    base,
    new Map([[hub, base.get(hub)]]),
    deletion(),
    "",
    "delete",
    true,
  );
  assert(!plan.changes.find((c) => c.path === node).after.includes(old));
  await publish(f, plan);
  base = await catalog(f.root);
  assert(!base.has(old));
  assert(base.has(dock));
  assert.equal(indexes(base)[0].members.length, 2);
  assert(!base.get(node).includes("Original overview"));
  for (const m of indexes(base)[0].members) assert(base.has(m.path));
});
test("manual managed-index/source edits, lost provenance and forged input names fail closed", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]);
  const plan = makePlan(v, contextFor(v.input, v.base));
  await publish(f, plan);
  let base = await catalog(f.root);
  assert.throws(
    () => indexes(new Map(base).set(node, base.get(node) + "manual")),
    /edited outside/,
  );
  const changed = new Map(base).set(plan.decision.newPath, "MANUAL");
  assert.throws(
    () => contextFor(v.input, changed),
    /missing or manually changed/,
  );
  const lost = new Map(base);
  lost.delete(node);
  assert.throws(() => contextFor(v.input, lost), /unregistered published/);
  await assert.rejects(
    () =>
      incomingWecom(
        f.dataDir,
        "WeCom-0000000000000000-fake.md",
        hash("forged"),
      ),
    /verified delivered/,
  );
  await assert.rejects(
    () => incomingWecom(f.dataDir, f.outputs[0].target, hash("edit")),
    /verified delivered/,
  );
});
test("adoption requires explicit local routing, malformed routes never authorize arbitrary paths; ordinary inputs retain normal behavior", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.dataDir, "knowledge-sync/wecom-routing.json"));
  let v = await verified(f, f.outputs[0]);
  assert.throws(
    () => contextFor(v.input, v.base),
    (e) => e.review && /Configure wecom-routing/.test(e.message),
  );
  await fs.writeFile(
    path.join(f.dataDir, "knowledge-sync/wecom-routing.json"),
    JSON.stringify({
      version: 1,
      documents: {
        [docid]: {
          indexPath: "../../escape",
          slot: "accessories",
          legacySources: [],
        },
      },
    }),
  );
  await assert.rejects(() => verified(f, f.outputs[0]), /Invalid WeCom route/);
  assert.equal(
    await incomingWecom(f.dataDir, "ordinary.md", hash("ordinary")),
    undefined,
  );
});
test("transaction baseline and rollback protect both mapping index and source; generic Sync cannot mutate registered ownership", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]);
  const plan = makePlan(v, contextFor(v.input, v.base));
  await f.write("UPad/others/manual_202610230000/note.md", "# External update");
  await assert.rejects(() => publish(f, plan), /Knowledge changed/);
  assert(!indexes(await catalog(f.root)).length);
  const fresh = await verified(f, f.outputs[0]);
  await publish(f, makePlan(fresh, contextFor(fresh.input, fresh.base)));
  const base = await catalog(f.root),
    member = indexes(base)[0].members[0],
    p = proposed({ docid: "e3_other", id: "x" }, base);
  p.decision.action = "update";
  p.decision.oldPaths = [member.path];
  assert.throws(
    () => buildPlan(base, p.staged, p.decision, "foreign body", "", false),
    /only replace its own/,
  );
  const forged = proposed(contextFor(fresh.input, base), base);
  forged.staged.set(node, base.get(node));
  assert.throws(
    () =>
      buildPlan(
        base,
        forged.staged,
        forged.decision,
        fresh.body,
        "",
        false,
        undefined,
        contextFor(fresh.input, base),
      ),
    /maintained by the backend/,
  );
});
test("real Sync service binds current receipts before planner, skips repeated publication and publishes changed sheet without disturbing other sources", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const sync = new SyncService({
    dataDir: f.dataDir,
    maxBytes: 1048576,
    timeoutMs: 5000,
    modelId: () => "mock",
    redact: (e) => e.message,
    converter: () => async (file) => {
      const markdown = await fs.readFile(file, "utf8");
      return {
        markdown,
        sourceHash: hash(markdown),
        coverage: ["Full text"],
        visual: emptyUsage(),
        version: 1,
      };
    },
    planner: () => async (input) => {
      calls++;
      assert(input.wecom);
      return proposed(
        input.wecom,
        input.base,
        `20261023${String(calls).padStart(4, "0")}`,
      );
    },
  });
  await sync.init();
  t.after(() => sync.close());
  const run = async () => {
    const job = await sync.start((await sync.incoming()).map((i) => i.id));
    await sync.active;
    return sync.get(job.id);
  };
  let report = await run();
  assert(
    report.items.every((i) => i.status === "published"),
    report.items.map((i) => i.reason).join("\n"),
  );
  assert.equal(calls, 2);
  assert.equal(indexes(await catalog(f.root))[0].members.length, 2);
  const published = await catalog(f.root),
    member = indexes(published)[0].members.find((m) => m.id === "a");
  await fs.writeFile(
    path.join(f.importer.inbox, f.outputs[0].target),
    published.get(member.path),
  );
  report = await run();
  assert.equal(report.items[0].status, "duplicate", report.items[0].reason);
  assert.equal(calls, 2);
  await assert.rejects(
    () => sync.resync(report.id, report.items[0].id, "Review coverage"),
    /own source binding/,
  );
  f.change("New actual text");
  await f.collect();
  report = await run();
  assert.equal(report.items[0].status, "published", report.items[0].reason);
  assert.equal(calls, 3);
  assert((await catalog(f.root)).has(old));
  assert((await catalog(f.root)).has(dock));
});

test("legacy deletion checks the latest importer snapshot again at commit, even if its preview was complete", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() =>
    verifyRetirement(f.dataDir, awaitBase(), {
      action: "delete",
      oldPaths: [old],
    }),
  );
  function awaitBase() {
    return new Map();
  }
  for (const output of f.outputs) {
    const v = await verified(f, output);
    await publish(f, makePlan(v, contextFor(v.input, v.base)));
  }
  const base = await catalog(f.root),
    decision = {
      action: "delete",
      products: ["UPad"],
      slot: "accessories",
      oldPaths: [old],
      reason: "Migration done",
      summary: "Retire old workbook",
      versionEvidence: "Administrator request",
      authorizedException: false,
      reviewedPaths: [hub, node, ...dependents(base, [old])],
    };
  const plan = buildPlan(
    base,
    new Map([[hub, base.get(hub)]]),
    decision,
    "",
    "delete",
    true,
  );
  await verifyRetirement(f.dataDir, base, decision);
  f.change("Changed after the preview");
  await f.collect();
  await assert.rejects(() => publish(f, plan), /latest imported text/);
  assert((await catalog(f.root)).has(old));
});
test("publication rollback restores the source graph and managed binding together; managed navigation is read-only in Library", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]),
    plan = makePlan(v, contextFor(v.input, v.base));
  const publisher = new Publisher(
      f.root,
      path.join(f.dataDir, "knowledge-sync"),
    ),
    apply = publisher.apply.bind(publisher);
  publisher.apply = async (changes, after) => {
    if (after) {
      await apply(changes.slice(0, 1), true);
      throw Error("Simulated storage failure");
    }
    return apply(changes, false);
  };
  await assert.rejects(
    () =>
      publisher.publish(
        crypto.randomUUID(),
        plan,
        new AbortController().signal,
      ),
    /Simulated storage/,
  );
  assert.deepEqual(await catalog(f.root), v.base);
  await publish(f, plan);
  const library = new KnowledgeLibrary(f.root, f.dataDir, () => false),
    read = await library.read(node);
  assert.equal(read.editable, false);
  await assert.rejects(
    () => library.save(node, read.text + "edit", read.hash),
    (e) => e.status === 403,
  );
});
test("explicit withdrawal blocks automatic reintroduction; exact administrator restore instruction requires confirmation", async (t) => {
  const f = await fixture(t);
  const v = await verified(f, f.outputs[0]);
  await publish(f, makePlan(v, contextFor(v.input, v.base)));
  let base = await catalog(f.root),
    member = indexes(base)[0].members[0];
  const deletion = {
    action: "delete",
    products: ["UPad"],
    slot: "accessories",
    oldPaths: [member.path],
    reason: "Withdraw one section",
    summary: "Withdraw source",
    versionEvidence: "Administrator request",
    authorizedException: false,
    reviewedPaths: [hub, node],
  };
  await publish(
    f,
    buildPlan(
      base,
      new Map([[hub, base.get(hub)]]),
      deletion,
      "",
      "delete",
      true,
    ),
  );
  base = await catalog(f.root);
  assert(indexes(base)[0].members[0].withdrawn);
  const ctx = contextFor(v.input, base),
    p = proposed({ ...ctx, previous: undefined }, base, "202610230099");
  assert.throws(
    () =>
      buildPlan(
        base,
        p.staged,
        p.decision,
        v.body,
        "yes",
        false,
        undefined,
        ctx,
      ),
    (e) => e.review && /RESTORE WECOM/.test(e.message),
  );
  const plan = buildPlan(
    base,
    p.staged,
    p.decision,
    v.body,
    `RESTORE WECOM ${ctx.docid} ${ctx.id}`,
    false,
    undefined,
    ctx,
  );
  assert(plan.confirmationReason);
  await publish(f, plan);
  assert(!indexes(await catalog(f.root))[0].members[0].withdrawn);
});

test("UTF-8 imported Markdown survives the real converter and encoded source links remain usable", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]);
  const converter = createConverter(
    fileToolConfig(f.dataDir, {}, {}),
    "missing-soffice",
    1,
    async () => () => {},
  );
  const result = await converter(
    path.join(f.importer.inbox, f.outputs[0].target),
    path.join(f.dataDir, "conversion"),
    new AbortController().signal,
    emptyUsage(),
    async () => {},
  );
  assert.equal(result.markdown, v.body);
  const ctx = contextFor(v.input, v.base),
    p = proposed(ctx, v.base);
  p.decision.newPath = p.decision.newPath.replace(
    "sheet.md",
    "配件 (U2&U2S).md",
  );
  const plan = buildPlan(
    v.base,
    p.staged,
    p.decision,
    result.markdown,
    "",
    false,
    undefined,
    ctx,
  );
  await publish(f, plan);
  const base = await catalog(f.root);
  assert(base.has(p.decision.newPath));
  assert.match(base.get(node), /%E9%85%8D%E4%BB%B6%20%28U2%26U2S%29/);
  assert(dependents(base, [p.decision.newPath]).includes(node));
});
test("an incorrect legacy route cannot silently drop the migration fallback", async (t) => {
  const f = await fixture(t),
    v = await verified(f, f.outputs[0]);
  v.input.route.legacySources = [
    "_shared/accessories/missing_202610230000/missing.md",
  ];
  assert.throws(
    () => contextFor(v.input, v.base),
    /Configured legacy source is missing/,
  );
});


test("real planner can batch-read a legacy retirement, correct a review into a verified delete and stop without a final model request", async (t) => {
  const f = await fixture(t);
  for (const output of f.outputs) {
    const v = await verified(f, output);
    await publish(f, makePlan(v, contextFor(v.input, v.base)));
  }
  const base = await catalog(f.root);
  const deletion = {
    action: "delete", products: ["UPad"], slot: "accessories", oldPaths: [old],
    reason: "Verified migration", summary: "Retire only the old complete workbook",
    versionEvidence: "Administrator deletion", authorizedException: false,
    reviewedPaths: [hub, node, ...dependents(base, [old])],
  };
  const calls = [
    { name: "finish_sync", args: { ...deletion, action: "review" } },
    { name: "source_dependents", args: { paths: [old] } },
    { name: "read_next_deletion_batch", args: {} },
    { name: "write_candidate", args: {path: hub, text: base.get(hub)} },
    { name: "finish_sync", args: deletion },
    // The Hub now links via the managed index, so it is no longer a direct dependent.
    // finish_sync queues its unread original because the candidate stages that Hub.
    { name: "read_next_deletion_batch", args: {} },
    { name: "finish_sync", args: deletion },
  ];
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {}
    const call = calls[requests++];
    res.writeHead(200, {"content-type": "text/event-stream"});
    const delta = call
      ? {role: "assistant", tool_calls: [{index: 0, id: `call-${requests}`, type: "function", function: {name: call.name, arguments: JSON.stringify(call.args)}}]}
      : {role: "assistant", content: "Unnecessary final response"};
    for (const [part, finish] of [[delta, null], [{}, call ? "tool_calls" : "stop"]])
      res.write(`data: ${JSON.stringify({id: "fixture", object: "chat.completion.chunk", created: 1, choices: [{index: 0, delta: part, finish_reason: finish}], ...(finish ? {usage: {prompt_tokens: 100, completion_tokens: 10}} : {})})}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r));});
  const usage = emptyUsage();
  const result = await createPlanner({
    model: {apiKey: "fixture", modelId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 128000, maxTokens: 16384},
    effort: "low", resourcesDir: path.resolve("resources"), workDir: path.join(f.dataDir, "planner"), maxCalls: 64, acquire: async () => () => {},
  })({
    base, markdown: "", prompt: "DELETE PREVIEW: retire only the migrated workbook", deletion: true,
    feedback: "", batch: [], deletions: [], timestamp: "202610230004", signal: AbortSignal.timeout(10000), usage, update: async () => {},
    validate: d => verifyRetirement(f.dataDir, base, d),
  });
  assert.equal(result.decision.action, "delete");
  assert.equal(requests, calls.length, "no inference after the accepted decision");
  assert.equal(usage.requests, requests);
  const plan = buildPlan(base, result.staged, result.decision, "", "", true);
  assert((await catalog(f.root)).has(old), "preview keeps the original until explicit publication");
  await publish(f, plan);
  const after = await catalog(f.root);
  assert(!after.has(old)); assert(after.has(dock));
  for (const member of indexes(after)[0].members) assert(after.has(member.path));
});

test('unrelated Chinese and mixed-language family titles do not collide or require manual adoption',()=>{
  const cases=[
    ['（对外）项目对应各部门关系表','打印机知识点（耗材）'],
    ['POS项目清单','POS认证清单'],
    ['PDA项目清单','PDA配件清单'],
  ];
  for(const [title,heading] of cases){
    const unrelated='product-knowledge-vault/shared/printer-consumables-knowledge.md';
    const text=`# ${heading}\nExisting independent knowledge`;
    const base=new Map([[unrelated,text]]);
    const input={docid:'e3_chinese_fixture',id:'pos',title};
    const context=contextFor(input,base);
    assert.equal(context.indexPath,`product-knowledge-vault/shared/wecom-${hash(input.docid).slice(0,24)}.md`);
    assert.equal(context.previous,undefined);
    assert.equal(context.route,undefined);
    assert.equal(base.size,1);
    assert.equal(base.get(unrelated),text);
    assert.equal(contextFor({...input,id:'pda'},base).indexPath,context.indexPath);
  }
});

test('real Chinese and English title matches still require explicit adoption of an existing family page',()=>{
  const existingPage='product-knowledge-vault/shared/existing.md';
  for(const [title,heading] of [
    ['项目对应各部门关系表','项目对应各部门关系表'],
    ['项目对应各部门关系表','项目 对应各部门关系表！'],
    ['POS项目清单','pos 项目清单'],
    ['Device and Accessories Guide','DEVICE-and_accessories GUIDE'],
    ['版本１２','版本 １２'],
  ]) {
    assert.throws(()=>contextFor({docid:'e3_match_fixture',id:'sheet',title},new Map([[existingPage,`# ${heading}\nKeep current source`]])),e=>e.review===true && e.message.includes(existingPage) && /Configure wecom-routing/.test(e.message));
  }
});

test('empty or punctuation-only title keys never match blank or heading-less pages',()=>{
  const base=new Map([
    ['product-knowledge-vault/shared/no-heading.md','Unrelated text without a heading'],
    ['product-knowledge-vault/shared/symbols.md','# ★ — !!!\n'],
    ['product-knowledge-vault/shared/blank.md',''],
  ]);
  for(const title of ['','★ — !!!','（）','项目负责人']){
    const input={docid:'e3_empty_fixture',id:'sheet',title};
    assert.equal(contextFor(input,base).indexPath,`product-knowledge-vault/shared/wecom-${hash(input.docid).slice(0,24)}.md`);
  }
});
