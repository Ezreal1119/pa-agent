import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SyncService } from "../dist/knowledge-sync/service.js";
import {
  buildPlan,
  references,
  resolveHub,
} from "../dist/knowledge-sync/validation.js";
import {
  sourceCoverage,
  managedSourceProducts,
} from "../dist/knowledge-sync/associations.js";
import { catalog, hash, emptyUsage } from "../dist/knowledge-sync/core.js";

const source = "i9600/others/release-notes_202610220001/changes.md";
const hub = "product-knowledge-vault/products/i9600.md";
const miniHub = "product-knowledge-vault/products/i9600-Mini.md";
const index = "product-knowledge-vault/index.md";
const log = "product-knowledge-vault/log.md";
const spec = "i9600/specs/default_202601010000/spec.md";
const miniSpec = "i9600 Mini/specs/default_202601010000/spec.md";
const body = "# SQ69 release notes\nFirmware revision 3.\n";
const feedback =
  "这份修改记录同时适用于 i9600 和 i9600 Mini。保留 i9600，补充 i9600 Mini 的来源关联，正文和版本不变。";
const ops = { references, resolveHub };
const decision = (overrides = {}) => ({
  action: "associate",
  existingSource: source,
  products: ["i9600", "i9600 Mini"],
  slot: "others",
  oldPaths: [],
  reason: "管理员明确确认两个型号适用同一份记录",
  summary: "保留原件并补充 Mini 来源关联",
  versionEvidence: "No version changes",
  authorizedException: false,
  reviewedPaths: [source, hub, miniHub],
  ...overrides,
});
const settled = async (service, id) => {
  for (let n = 0; n < 500; n++) {
    const job = await service.get(id);
    if (!["queued", "running", "stopping"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Fixture did not finish");
};
async function fixture(t, override) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-coverage-"));
  const dataDir = path.join(root, ".data");
  let conversions = 0,
    analyses = 0;
  const seen = [];
  const options = {
    dataDir,
    maxBytes: 100 * 1048576,
    timeoutMs: 30000,
    redact: (e) => e.message,
    modelId: () => "simulated",
    converter: () => async (file) => {
      conversions++;
      const bytes = await fs.readFile(file);
      return {
        markdown: bytes.toString(),
        sourceHash: hash(bytes),
        version: 1,
        coverage: ["Simulated conversion"],
        visual: emptyUsage(),
      };
    },
    planner: () => async (input) => {
      analyses++;
      seen.push(input);
      if (input.association)
        return override
          ? override(input)
          : {
              decision: decision({
                products: input.feedback
                  ? ["i9600", "i9600 Mini"]
                  : input.association.products,
              }),
              staged: new Map(),
            };
      return {
        decision: decision({
          action: "add",
          existingSource: undefined,
          newPath: source,
          products: ["i9600"],
          reviewedPaths: [hub],
        }),
        staged: new Map([
          [
            hub,
            `# i9600\n${spec}\n${source}\nConverted; original removed after successful sync`,
          ],
        ]),
      };
    },
  };
  const service = new SyncService(options);
  const base = new Map([
    [spec, "# i9600 specs\nIndependent i9600 facts"],
    [miniSpec, "# Mini specs\nIndependent Mini facts"],
    [hub, `# i9600\n${spec}`],
    [miniHub, `# Mini\n${miniSpec}`],
    [index, "# Index\n[[products/i9600]]\n[[products/i9600-Mini]]"],
    [log, "Historical audit\n"],
    ["SKILL.md", "Protected skill"],
    ["MEMORY.md", "Protected memory"],
  ]);
  for (const [p, text] of base) {
    await fs.mkdir(path.dirname(path.join(service.root, p)), {
      recursive: true,
    });
    await fs.writeFile(path.join(service.root, p), text);
  }
  await service.init();
  const services = [service];
  t.after(async () => {
    for (const s of services) await s.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const upload = async (name = "changes.txt") =>
    service.upload(
      name,
      (async function* () {
        yield Buffer.from(body);
      })(),
    );
  const firstFile = await upload();
  const first = await settled(
    service,
    (await service.start([firstFile.id])).id,
  );
  assert.equal(first.items[0].status, "published", first.items[0].reason);
  const repeat = await upload();
  const duplicate = await settled(
    service,
    (await service.start([repeat.id])).id,
  );
  assert.equal(
    duplicate.items[0].status,
    "duplicate",
    duplicate.items[0].reason,
  );
  assert.equal(duplicate.items[0].sourceDeleted, true);
  return {
    service,
    options,
    services,
    seen,
    first,
    duplicate,
    upload,
    count: () => ({ conversions, analyses }),
    preview: async (s = service, job = duplicate) =>
      settled(s, (await s.resync(job.id, job.items[0].id, feedback)).id),
  };
}

test("old Duplicate without original can preview and confirm additive Mini coverage; repeat confirmation is idempotent", async (t) => {
  const f = await fixture(t),
    s = f.service;
  const before = await catalog(s.root),
    counts = f.count();
  // Simulate a pre-upgrade report with no new optional coverage fields, including a restart.
  const legacy = structuredClone(f.duplicate);
  delete legacy.items[0].matchedSources;
  delete legacy.items[0].associationOnly;
  await s.save(legacy);
  await s.close();
  const restarted = new SyncService(f.options);
  f.services.push(restarted);
  await restarted.init();
  const preview = await f.preview(restarted, legacy),
    item = preview.items[0];
  assert.equal(item.status, "awaiting_confirmation", item.reason);
  assert.equal(item.associationOnly, true);
  assert.equal(item.matchedSources[0].path, source);
  assert.deepEqual(item.matchedSources[0].coveredProducts, ["i9600"]);
  assert.deepEqual(
    await catalog(s.root),
    before,
    "preview must not write knowledge",
  );
  assert.equal(
    f.count().conversions,
    counts.conversions,
    "no original/vision reconversion",
  );
  assert.ok(f.seen.at(-1).feedback.includes(feedback));
  assert.ok(item.plan.changes.length >= 4);
  for (const change of item.plan.changes) {
    assert.ok(change.path.startsWith("product-knowledge-vault/"));
    assert.notEqual(change.after, null);
    if (change.before !== null)
      assert.ok(change.after.startsWith(change.before));
  }
  const final = await settled(
    restarted,
    (await restarted.confirm(preview.id, item.id)).id,
  );
  assert.equal(final.items[0].status, "published", final.items[0].reason);
  const after = await catalog(s.root);
  assert.equal(after.get(source), before.get(source));
  for (const p of [spec, miniSpec, "SKILL.md", "MEMORY.md"])
    assert.equal(after.get(p), before.get(p));
  assert.ok(after.get(hub).startsWith(before.get(hub)));
  assert.ok(after.get(miniHub).startsWith(before.get(miniHub)));
  assert.deepEqual(sourceCoverage(after, source, [], ops).coveredProducts, [
    "i9600",
    "i9600 Mini",
  ]);
  assert.deepEqual(managedSourceProducts(after, source, ops), [
    "i9600",
    "i9600 Mini",
  ]);
  const shared = [...after.keys()].find((p) =>
    p.includes("/shared/source-association-"),
  );
  assert.ok(references(after.get(miniHub), after, miniHub).includes(shared));
  assert.ok(references(after.get(shared), after, shared).includes(source));
  assert.ok(references(after.get(index), after, index).includes(shared));
  const unchanged = buildPlan(
    after,
    new Map(),
    decision(),
    body,
    feedback,
    false,
    { ...item.matchedSources[0], products: ["i9600", "i9600 Mini"] },
  );
  assert.deepEqual(unchanged.changes, []);
  assert.equal(after.get(log).split(" · associate · ").length - 1, 1);
  await assert.rejects(
    restarted.resync(f.first.id, f.first.items[0].id, feedback),
    /already committed/,
  );
});

test("new filename with same bytes is analyzed for product coverage; feedback cannot silently become Duplicate", async (t) => {
  const f = await fixture(t),
    s = f.service,
    before = f.count();
  const file = await f.upload("mini-changes.txt");
  const reviewed = await settled(s, (await s.start([file.id])).id);
  assert.equal(reviewed.items[0].status, "duplicate");
  assert.equal(
    f.count().analyses,
    before.analyses + 1,
    "a different name must reach planner",
  );
  assert.equal(
    f.count().conversions,
    before.conversions,
    "verified Markdown can be reused",
  );
  const preview = await f.preview(s, reviewed);
  assert.equal(
    preview.items[0].status,
    "awaiting_confirmation",
    preview.items[0].reason,
  );
  assert.deepEqual(preview.items[0].plan.decision.products, [
    "i9600",
    "i9600 Mini",
  ]);
});

test("feedback requesting an already-covered product still previews the actual no-op result", async (t) => {
  const f = await fixture(t, (input) => ({
    decision: decision({ products: input.association.products }),
    staged: new Map(),
  }));
  const preview = await f.preview();
  assert.equal(preview.items[0].status, "awaiting_confirmation");
  assert.deepEqual(preview.items[0].plan.changes, []);
  assert.match(
    preview.items[0].plan.confirmationReason,
    /No source or index changes/,
  );
  assert.ok(
    !preview.items[0].plan.decision.products.includes("i9600 Mini"),
    "UI must not claim Mini was added",
  );
});

test("source mismatch/missing fails closed; ambiguous matches require explicit current path", async (t) => {
  for (const missing of [false, true]) {
    const f = await fixture(t),
      s = f.service;
    if (missing) await fs.unlink(path.join(s.root, source));
    else
      await fs.writeFile(
        path.join(s.root, source),
        "Changed by another publication",
      );
    const before = await catalog(s.root),
      counts = f.count();
    const reviewed = await f.preview();
    assert.equal(
      reviewed.items[0].status,
      "needs_review",
      reviewed.items[0].reason,
    );
    assert.match(reviewed.items[0].reason, /无法验证/);
    assert.deepEqual(await catalog(s.root), before);
    assert.deepEqual(
      f.count(),
      counts,
      "no planner/converter when receipt cannot be verified",
    );
  }
  const f = await fixture(t),
    s = f.service;
  const alternate = "i9600 Mini/others/other_202610220002/changes.md";
  await fs.mkdir(path.dirname(path.join(s.root, alternate)), {
    recursive: true,
  });
  await fs.writeFile(path.join(s.root, alternate), body);
  // Persist a second independently published receipt; do not collapse equal bodies with different identities.
  const receipt = structuredClone(f.first);
  receipt.id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  receipt.items[0].id = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  receipt.items[0].plan.decision.newPath = alternate;
  receipt.items[0].plan.decision.products = ["i9600 Mini"];
  receipt.items[0].plan.changes = [];
  await s.save(receipt);
  await s.close();
  const restarted = new SyncService(f.options);
  f.services.push(restarted);
  await restarted.init();
  const ambiguous = await f.preview(restarted);
  assert.equal(ambiguous.items[0].status, "needs_review");
  assert.match(ambiguous.items[0].reason, /匹配多份/);
  const selected = await settled(
    restarted,
    (
      await restarted.resync(
        ambiguous.id,
        ambiguous.items[0].id,
        `只关联这条完整路径：${source}。${feedback}`,
      )
    ).id,
  );
  assert.equal(
    selected.items[0].status,
    "awaiting_confirmation",
    selected.items[0].reason,
  );
  assert.equal(selected.items[0].plan.decision.existingSource, source);
});

test("coverage preview rejects stale publication, can retry without original, and rolls back all generated indexes on write failure", async (t) => {
  const f = await fixture(t),
    s = f.service;
  const preview = await f.preview();
  await fs.appendFile(
    path.join(s.root, miniHub),
    "\nIndependent concurrent edit\n",
  );
  const before = await catalog(s.root);
  const stale = await settled(
    s,
    (await s.confirm(preview.id, preview.items[0].id)).id,
  );
  assert.equal(stale.items[0].status, "failed");
  assert.match(stale.items[0].reason, /Knowledge changed/);
  assert.deepEqual(await catalog(s.root), before);
  const retry = await f.preview(s, stale);
  assert.equal(
    retry.items[0].status,
    "awaiting_confirmation",
    retry.items[0].reason,
  );
  const apply = s.publisher.apply.bind(s.publisher);
  s.publisher.apply = async (changes, forward) => {
    if (forward) {
      await apply(changes.slice(0, 2), true);
      throw Error("simulated disk failure");
    }
    return apply(changes, false);
  };
  const failed = await settled(
    s,
    (await s.confirm(retry.id, retry.items[0].id)).id,
  );
  assert.equal(failed.items[0].status, "failed");
  assert.match(failed.items[0].reason, /simulated disk failure/);
  assert.deepEqual(
    await catalog(s.root),
    before,
    "all partial index writes roll back",
  );
  s.publisher.apply = apply;
  const ready = await f.preview(s, failed);
  const final = await settled(
    s,
    (await s.confirm(ready.id, ready.items[0].id)).id,
  );
  assert.equal(final.items[0].status, "published", final.items[0].reason);
});

test("association cannot rewrite facts, change identity, drop a member, create a product or bypass verified context", async (t) => {
  const f = await fixture(t),
    base = await catalog(f.service.root);
  const match = f.duplicate.items[0].matchedSources[0];
  for (const [change, staged, pattern] of [
    [{}, new Map([[miniHub, "rewrite"]]), /index-only/],
    [{ oldPaths: [source] }, new Map(), /index-only/],
    [
      { newPath: "_shared/others/moved_202610220002/changes.md" },
      new Map(),
      /index-only/,
    ],
    [{ existingSource: miniSpec }, new Map(), /backend-verified/],
    [{ products: ["i9600 Mini"] }, new Map(), /preserve every/],
    [{ slot: "brochure" }, new Map(), /cannot change/],
    [{ products: ["i9600", "T5000"] }, new Map(), /existing canonical/],
    [
      { productHubs: [{ product: "i9600 Mini", path: hub }] },
      new Map(),
      /index-only/,
    ],
    [{ products: ["i9600", "../secret"] }, new Map(), /Invalid canonical/],
  ])
    assert.throws(
      () =>
        buildPlan(base, staged, decision(change), body, feedback, false, match),
      pattern,
    );
  assert.throws(
    () => buildPlan(base, new Map(), decision(), body, feedback),
    /backend-verified/,
  );
  assert.throws(
    () =>
      buildPlan(
        base,
        new Map(),
        decision({ action: "add" }),
        body,
        feedback,
        false,
        match,
      ),
    /source replacement is not permitted/,
  );
  assert.throws(
    () => buildPlan(base, new Map(), decision(), body, feedback, true, match),
    /deletion preview/,
  );
  await assert.rejects(
    f.service.resync(f.duplicate.id, f.duplicate.items[0].id, ""),
    /which product/,
  );
  await assert.rejects(
    f.service.resync(f.duplicate.id, f.duplicate.items[0].id, feedback, true),
    /cannot reconvert/,
  );
  const withMissing = await settled(
    f.service,
    (
      await f.service.resync(
        f.duplicate.id,
        f.duplicate.items[0].id,
        `补上遗漏的型号关联。${feedback}`,
      )
    ).id,
  );
  assert.equal(
    withMissing.items[0].status,
    "awaiting_confirmation",
    withMissing.items[0].reason,
  );
  const occupiedSpecs = { ...match, slot: "specs" };
  assert.throws(
    () =>
      buildPlan(
        base,
        new Map(),
        decision({ slot: "specs" }),
        body,
        feedback,
        false,
        occupiedSpecs,
      ),
    /current-slot replacement/,
  );
});

test("later deletion of an association-managed source must review every associated product", async (t) => {
  const f = await fixture(t),
    s = f.service,
    preview = await f.preview();
  await settled(s, (await s.confirm(preview.id, preview.items[0].id)).id);
  const base = await catalog(s.root),
    shared = [...base.keys()].find((p) =>
      p.includes("/shared/source-association-"),
    );
  const d = decision({
    action: "delete",
    existingSource: undefined,
    products: ["i9600"],
    oldPaths: [source],
    reviewedPaths: [hub, miniHub, shared],
  });
  const staged = new Map([
    [hub, `# i9600\n${spec}`],
    [miniHub, `# Mini\n${miniSpec}`],
    [shared, "# Shared record\nSource was removed; no current version."],
  ]);
  assert.throws(
    () => buildPlan(base, staged, d, "", "Delete the shared source", true),
    /all associated products/,
  );
  const valid = buildPlan(
    base,
    staged,
    { ...d, products: ["i9600", "i9600 Mini"] },
    "",
    "Delete the shared source",
    true,
  );
  assert.match(valid.confirmationReason, /all products/);
  assert.deepEqual(
    await catalog(s.root),
    base,
    "preparing deletion cannot mutate data",
  );
  const revised = "_shared/firmware/release_202610220003/changes.md";
  const later = new Map(
    [...base].map(([p, text]) => [
      p === source ? revised : p,
      text.replaceAll(source, revised),
    ]),
  );
  assert.deepEqual(
    managedSourceProducts(later, revised, ops),
    ["i9600", "i9600 Mini"],
    "a source's fresh revision path must retain its association guard",
  );
  assert.throws(
    () =>
      buildPlan(
        later,
        staged,
        { ...d, oldPaths: [revised] },
        "",
        "Delete new revision",
        true,
      ),
    /all associated products/,
  );
});
