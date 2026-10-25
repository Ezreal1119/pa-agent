import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  windowDays,
  defaults,
  admitted,
  total,
  evidenceCheck,
  articleSchema,
} from "../dist/research/domain.js";
import { ResearchStore, hash, digest } from "../dist/research/store.js";
import { ResearchService } from "../dist/research/service.js";
import { ResearchKnowledge } from "../dist/research/knowledge.js";
const resourcesDir = path.resolve("resources");
const checks = {
  readableBody: true,
  dateVerified: true,
  factsSupported: true,
  businessLink: true,
  productSupported: true,
  consistent: true,
};
function fixture(date = "2026-10-23") {
  const e = {
    id: randomUUID(),
    kind: "web",
    locator: "https://example.com/news",
    title: "Warehouse deployment",
    content:
      "2026-10-23 New warehouse deployment. Customer installed barcode devices. ".repeat(
        10,
      ),
    fetchedAt: new Date().toISOString(),
    readable: true,
    hash: hash("body"),
  };
  const quote = { evidenceId: e.id, quote: "2026-10-23" };
  const a = {
    title: "仓库部署",
    eventKey: "Customer|Wuhan|deployment",
    disclosureDate: date,
    dateEvidence: quote,
    eventDate: "",
    region: "中国",
    companies: ["Customer"],
    scene: "logistics",
    tags: ["条码"],
    relatedScenes: [],
    facts: [
      {
        claim: "部署扫描设备",
        citations: [
          { evidenceId: e.id, quote: "Customer installed barcode devices." },
        ],
      },
    ],
    deployment: "仓库部署",
    competition: { status: "undisclosed", detail: "未披露", citations: [] },
    urovo: { relevance: "仓储识别和移动作业", productClaims: [] },
    brief: { news: "仓库部署条码采集", sales: "了解具体作业流程" },
    detail: {
      analysis: "现场采集需求",
      sales: "询问扫描环境与软件集成条件",
      questions: ["设备要求是什么？"],
      limitations: ["品牌未披露"],
    },
    relatedIds: [],
    status: "active",
  };
  const c = {
    id: randomUUID(),
    action: "new",
    reason: "新事件",
    article: a,
    submittedAt: new Date().toISOString(),
  };
  const v = {
    candidateId: c.id,
    approve: true,
    unresolvedIssues: [],
    scores: {
      relevance: 4,
      commercial: 4,
      evidence: 4,
      importance: 3,
      novelty: 4,
    },
    checks,
    material: true,
    reason: "正文证据与业务相关",
  };
  return { e, c, v };
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "urovo-research-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function run() {
  return {
    id: randomUUID(),
    days: windowDays("2026-10-24"),
    endDate: "2026-10-24",
    config: defaults,
    state: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    background: "business",
    backgroundHash: "x",
    candidates: [],
    coverage: [],
    checkpoints: [],
    metrics: {
      modelCalls: 0,
      search: 0,
      fetch: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    potentialUsed: false,
    errors: [],
  };
}
test("inclusive fourteen days, month/year/leap boundaries and validation", () => {
  assert.equal(windowDays("2026-10-24")[0], "2026-10-11");
  assert.equal(windowDays("2026-10-20")[0], "2026-10-07");
  assert.equal(windowDays("2026-01-05")[0], "2025-12-23");
  assert.ok(windowDays("2024-03-01").includes("2024-02-29"));
  assert.throws(() => windowDays("2026-02-30"));
  assert.throws(() => windowDays("2026-10-24", 2));
});
test("weighted admission, hard gates, exact quotes and evidence type", () => {
  const { e, c, v } = fixture();
  assert.equal(total(v.scores), 77);
  assert.equal(admitted(v, c, defaults), true);
  assert.equal(
    admitted({ ...v, checks: { ...checks, dateVerified: false } }, c, defaults),
    false,
  );
  assert.equal(
    admitted({ ...v, scores: { ...v.scores, relevance: 2 } }, c, defaults),
    false,
  );
  assert.doesNotThrow(() => evidenceCheck(c, [e]));
  assert.throws(() => evidenceCheck(c, [{ ...e, readable: false }]));
  assert.throws(() => evidenceCheck(c, [{ ...e, content: "Only title" }]));
  assert.throws(() =>
    evidenceCheck(
      {
        ...c,
        article: {
          ...c.article,
          urovo: {
            ...c.article.urovo,
            productClaims: [
              { claim: "Specific model", citations: [c.article.dateEvidence] },
            ],
          },
        },
      },
      [e],
    ),
  );
  assert.equal(articleSchema.safeParse(c.article).success, true);
});
test("atomic upsert, idempotency, duplicate URLs, optimistic versions, correction and archive", async (t) => {
  const store = new ResearchStore(await temp(t));
  await store.init();
  const r = run();
  const { e, c, v } = fixture();
  const out = await store.commit(r, c, v, [e], () => {});
  assert.equal(out.kind, "new");
  assert.equal((await store.commit(r, c, v, [e], () => {})).kind, "replay");
  let item = await store.item(out.id);
  assert.equal(item.version, 1);
  await assert.rejects(
    store.commit(
      r,
      {
        ...c,
        id: randomUUID(),
        article: { ...c.article, eventKey: "Different wording" },
      },
      v,
      [e],
      () => {},
    ),
    /同一事件/,
  );
  const update = {
    ...c,
    id: randomUUID(),
    action: "update",
    targetId: item.id,
    expectedVersion: item.version,
    article: {
      ...c.article,
      detail: { ...c.article.detail, analysis: "新增规模信息" },
    },
  };
  await store.commit(r, update, v, [e], () => {});
  assert.equal((await store.item(item.id)).version, 2);
  await assert.rejects(
    store.commit(r, { ...update, id: randomUUID() }, v, [e], () => {}),
    /版本/,
  );
  const correction = {
    ...update,
    id: randomUUID(),
    action: "correction",
    expectedVersion: 2,
    article: { ...update.article, status: "disputed" },
  };
  await store.commit(
    r,
    correction,
    {
      ...v,
      scores: {
        relevance: 1,
        commercial: 1,
        evidence: 4,
        importance: 1,
        novelty: 1,
      },
    },
    [e],
    () => {},
  );
  item = await store.item(item.id);
  assert.equal(item.article.status, "disputed");
  assert.equal(item.history.length, 3);
  assert.ok(!digest([item], r.days).includes("### 仓库部署"));
  await store.archive(item.id, "错误收录");
  assert.ok((await store.item(item.id)).archived);
});
test("failed late commit cannot publish; interrupted runs and index rebuild retain library", async (t) => {
  const dir = await temp(t);
  const store = new ResearchStore(dir);
  await store.init();
  const { c, e, v } = fixture();
  await assert.rejects(
    store.commit(run(), c, v, [e], () => {
      throw new Error("expired");
    }),
  );
  assert.equal((await store.items()).length, 0);
  const r = run();
  await store.saveRun(r);
  await store.commit(r, c, v, [e], () => {});
  await fs.writeFile(path.join(store.root, "library/index.json"), "[]");
  const restart = new ResearchStore(dir);
  await restart.init();
  assert.equal((await restart.run(r.id)).state, "interrupted");
  assert.equal((await restart.items()).length, 1);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(store.root, "library/index.json"), "utf8"),
    ).length,
    1,
  );
});
test("knowledge reads reject traversal, credentials and symlink escape", async (t) => {
  const dir = await temp(t);
  await fs.mkdir(path.join(dir, "urovo-product-expert"));
  await fs.writeFile(path.join(dir, "urovo-product-expert/a.md"), "knowledge");
  await fs.writeFile(path.join(dir, "secret.md"), "secret");
  await fs.symlink(
    path.join(dir, "secret.md"),
    path.join(dir, "urovo-product-expert/link.md"),
  );
  const k = new ResearchKnowledge(dir);
  assert.equal(await k.read("products", "a.md"), "knowledge");
  await assert.rejects(k.read("products", "../secret.md"));
  await assert.rejects(k.read("products", ".env"));
  await assert.rejects(k.read("products", "link.md"));
  assert.deepEqual((await k.list("products")).files, ["a.md"]);
});
test("checkpoint control, once-only credit, snapshot and latest enriched history", async (t) => {
  const dir = await temp(t);
  let now = Date.parse("2026-10-24T01:00:00Z");
  let phases = 0;
  const f = fixture();
  const engine = {
    ready() {},
    async worker(ctx) {
      return {
        async step() {
          phases++;
          if (phases === 1) {
            ctx.evidence.set(f.e.id, f.e);
            ctx.run.candidates.push(f.c);
            ctx.run.coverage.push({
              scene: "logistics",
              from: "2026-10-11",
              to: "2026-10-24",
              query: "warehouse",
              at: new Date(now).toISOString(),
              resultCount: 3,
            });
          }
          now += 300000;
        },
        async close() {},
      };
    },
    async review(ctx) {
      return {
        verdicts: ctx.run.candidates
          .filter((c) => !c.outcome)
          .map((c) => ({ ...f.v, candidateId: c.id })),
        nextDirections: ["追查客户部署"],
        summary: "有价值的新信息",
      };
    },
  };
  const s = new ResearchService({
    dataDir: dir,
    resourcesDir,
    engine: () => engine,
    now: () => now,
  });
  await s.init();
  await s.start("2026-10-24");
  await assert.rejects(s.start("2026-10-24"), /已有/);
  await s.wait();
  const r = (await s.store.runs())[0];
  assert.equal(r.checkpoints[0].points, 2);
  assert.equal(r.checkpoints[0].decisions[0].status, "saved");
  assert.match(r.checkpoints[0].resultSummary, /Saved 1/);
  assert.equal(r.checkpoints[0].continued, true);
  assert.equal(r.checkpoints[1].continued, false);
  assert.equal((await s.store.items()).length, 1);
  const view = await s.browse("2026-10-24");
  assert.equal(view.items.length, 1);
  assert.ok(
    view.coverage.every(
      (d) =>
        d.scenes.find((s) => s.scene === "logistics").status !== "not_searched",
    ),
  );
  await s.close();
});
test("review failure rejects candidates, completes without fabricated report", async (t) => {
  const dir = await temp(t);
  let now = Date.parse("2026-10-24T01:00:00Z");
  const f = fixture();
  let first = true;
  const s = new ResearchService({
    dataDir: dir,
    resourcesDir,
    now: () => now,
    engine: () => ({
      ready() {},
      async worker(ctx) {
        return {
          async step() {
            if (first) {
              ctx.evidence.set(f.e.id, f.e);
              ctx.run.candidates.push(f.c);
              first = false;
            }
            now += 300000;
          },
          async close() {},
        };
      },
      async review() {
        throw new Error("review unavailable");
      },
    }),
  });
  await s.init();
  await s.start("2026-10-24");
  await s.wait();
  assert.equal((await s.store.items()).length, 0);
  assert.equal(
    (await s.store.runs())[0].checkpoints[0].error,
    "review unavailable",
  );
  await s.close();
});
test("hard deadline aborts hanging worker and persists unreviewed outcome", async (t) => {
  const dir = await temp(t);
  const settings = {
    ...defaults,
    initialMs: 10,
    checkpointMs: 10,
    maxMs: 100,
    wrapMs: 20,
    reviewMs: 10,
  };
  const s = new ResearchService({
    dataDir: dir,
    resourcesDir,
    settings,
    engine: () => ({
      ready() {},
      async worker(ctx) {
        return {
          async step() {
            await new Promise((resolve, reject) =>
              ctx.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              ),
            );
          },
          async close() {},
        };
      },
      async review() {
        throw new Error("not reached");
      },
    }),
  });
  await s.init();
  await s.start("2026-10-24");
  const keepAlive = setTimeout(() => {}, 200);
  await s.wait();
  clearTimeout(keepAlive);
  assert.equal((await s.store.runs())[0].state, "completed");
  assert.equal((await s.store.items()).length, 0);
  await s.close();
});
test("material new development is linked to old event; supplements preserve original date", async (t) => {
  const store = new ResearchStore(await temp(t));
  await store.init();
  const { e, c, v } = fixture();
  const r = run();
  const first = await store.commit(r, c, v, [e], () => {});
  const later = {
    ...e,
    id: randomUUID(),
    locator: "https://example.com/rollout",
    content: e.content + "2026-10-24 deployment expanded",
  };
  const c2 = {
    ...c,
    id: randomUUID(),
    article: {
      ...c.article,
      title: "规模扩大",
      eventKey: "Customer|Wuhan|expansion",
      disclosureDate: "2026-10-24",
      dateEvidence: { evidenceId: later.id, quote: "2026-10-24" },
      facts: [
        {
          claim: "部署扩大",
          citations: [{ evidenceId: later.id, quote: "deployment expanded" }],
        },
      ],
      relatedIds: [first.id],
    },
  };
  await store.commit(r, c2, { ...v, candidateId: c2.id }, [e, later], () => {});
  assert.equal((await store.items()).length, 2);
  const update = {
    ...c,
    id: randomUUID(),
    action: "update",
    targetId: first.id,
    expectedVersion: 1,
    article: {
      ...c.article,
      disclosureDate: "2026-10-24",
      dateEvidence: c2.article.dateEvidence,
    },
  };
  await assert.rejects(
    store.commit(r, update, v, [e, later], () => {}),
    /不得改变/,
  );
});
test("new articles outside the window cannot enter through model approval", async (t) => {
  const store = new ResearchStore(await temp(t));
  await store.init();
  const { e, c, v } = fixture("2026-10-01");
  await assert.rejects(
    store.commit(run(), c, v, [e], () => {}),
    /不在/,
  );
});
test("background and settings are frozen; stop during active research retains only reviewed work", async (t) => {
  const dir = await temp(t);
  await fs.mkdir(path.join(dir, "research"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "research/urovo-business-context.md"),
    "Version A",
  );
  let ctx;
  let finish;
  const blocked = new Promise((r) => (finish = r));
  const settings = { ...defaults };
  const s = new ResearchService({
    dataDir: dir,
    resourcesDir,
    settings,
    engine: () => ({
      ready() {},
      async worker(c) {
        ctx = c;
        return {
          async step() {
            if (!ctx.wrapping()) await blocked;
          },
          async close() {},
        };
      },
      async review() {
        throw new Error("No candidates expected");
      },
    }),
  });
  await s.init();
  const r = await s.start("2026-10-24");
  await fs.writeFile(
    path.join(dir, "research/urovo-business-context.md"),
    "Version B",
  );
  settings.threshold = 99;
  await s.stop(r.id);
  finish();
  await s.wait();
  const saved = await s.store.run(r.id);
  assert.equal(saved.background, "Version A");
  assert.equal(saved.config.threshold, 70);
  assert.equal(saved.state, "completed");
  assert.equal(saved.stopReason, "用户要求提前收尾");
  await s.close();
});
test("one high-potential extension per run, denied candidates never become accepted", async (t) => {
  const dir = await temp(t);
  let now = Date.parse("2026-10-24T01:00:00Z");
  const f = fixture();
  let phase = 0;
  const s = new ResearchService({
    dataDir: dir,
    resourcesDir,
    now: () => now,
    engine: () => ({
      ready() {},
      async worker(ctx) {
        return {
          async step() {
            phase++;
            ctx.evidence.set(f.e.id, f.e);
            ctx.run.candidates.push({ ...f.c, id: randomUUID() });
            now += 300000;
          },
          async close() {},
        };
      },
      async review(ctx) {
        const pending = ctx.run.candidates.filter((c) => !c.outcome);
        return {
          verdicts: pending.map((c) => ({
            ...f.v,
            candidateId: c.id,
            approve: false,
          })),
          potential: {
            candidateId: pending[0].id,
            missingStep: "核实部署时间",
          },
          nextDirections: ["核查正式公告"],
          summary: "有证据但尚缺一项核查",
        };
      },
    }),
  });
  await s.init();
  await s.start("2026-10-24");
  await s.wait();
  const r = (await s.store.runs())[0];
  assert.equal(r.checkpoints[0].points, 2);
  assert.equal(r.checkpoints[1].points, 0);
  assert.equal(r.potentialUsed, true);
  assert.equal((await s.store.items()).length, 0);
  await s.close();
});

test("a conditional approval with unresolved corrections never publishes", () => {
  const { c, v } = fixture();
  assert.equal(
    admitted({ ...v, unresolvedIssues: ["Date not established"] }, c, defaults),
    false,
  );
});

test(
  "actual SDK payloads isolate research/reviewer and apply date filters, retries and evidence submission",
  { timeout: 20000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const { createResearchEngine } = await import("../dist/research/agent.js");
    const dir = await temp(t);
    const store = new ResearchStore(dir);
    await store.init();
    const r = run();
    r.config = { ...defaults, fetchTimeoutMs: 250 };
    await store.saveRun(r);
    const f = fixture();
    const controller = new AbortController();
    const ctx = {
      run: r,
      store,
      evidence: new Map(),
      signal: controller.signal,
      boundary: () => true,
      wrapping: () => false,
      save: () => store.saveRun(r),
    };
    const payloads = [];
    let phase = 0;
    let reviewerCalls = 0;
    let abortAt = Infinity;
    let abortReview;
    const model = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      payloads.push(body);
      const review = body.messages.some(
        (m) => m.role === "system" && m.content.includes("独立 UROVO"),
      );
      let name, args;
      if (review) {
        reviewerCalls++;
        if (reviewerCalls === abortAt) {
          abortReview();
          return;
        }
        name = "submit_review";
        args = {
          verdicts: [{ ...f.v, candidateId: r.candidates[0].id }],
          nextDirections: [],
          summary: "实际正文已核对",
        };
      } else if (++phase === 1) {
        name = "search_news";
        args = {
          query: "warehouse barcode deployment",
          scene: "logistics",
          from: "2026-10-11",
          to: "2026-10-24",
        };
      } else if (phase === 2) {
        name = "fetch_source";
        args = { url: f.e.locator };
      } else if (phase === 4 || phase === 5) {
        name = "fetch_sources";
        args = {
          urls:
            phase === 4
              ? [
                  f.e.locator,
                  "https://example.com/slow",
                  "https://example.com/fast",
                ]
              : ["https://example.com/slow"],
        };
      } else {
        name = "submit_candidate";
        const evidence = [...ctx.evidence.values()][0];
        const article = JSON.parse(
          JSON.stringify(f.c.article).replaceAll(f.e.id, evidence.id),
        );
        args = { action: "new", reason: "模拟部署新闻", article };
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant" }, null],
        [
          {
            tool_calls: [
              {
                index: 0,
                id: "call-" + payloads.length,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          null,
        ],
        [{}, "tool_calls"],
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    t.after(async () => {
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    });
    let attempts = 0;
    const outbound = [];
    let activeFetches = 0,
      maxFetches = 0;
    const engine = createResearchEngine({
      dataDir: dir,
      resourcesDir,
      model: () => ({
        apiKey: "fixture-model-secret",
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        modelId: "fixture",
        contextWindow: 128000,
        maxTokens: 8192,
      }),
      web: () => ({
        apiKey: "fixture-web-secret",
        request: async (url, init) => {
          outbound.push(JSON.parse(init.body));
          if (String(url).endsWith("/search")) {
            attempts++;
            return attempts < 3
              ? new Response("", { status: 503 })
              : Response.json({
                  results: [
                    {
                      url: f.e.locator,
                      title: f.e.title,
                      summary: "Warehouse deployment",
                      date: "2026-10-23",
                    },
                    {
                      url: "https://example.com/slow",
                      title: "Slow source",
                      summary: "Competitor deployment",
                    },
                    {
                      url: "https://example.com/fast",
                      title: "Fast source",
                      summary: "Retail endpoint deployment",
                    },
                  ],
                });
          }
          const target = JSON.parse(init.body).url;
          activeFetches++;
          maxFetches = Math.max(maxFetches, activeFetches);
          try {
            if (target.endsWith("/slow"))
              await new Promise((resolve, reject) =>
                init.signal.addEventListener(
                  "abort",
                  () => reject(init.signal.reason),
                  { once: true },
                ),
              );
            else if (target.endsWith("/fast"))
              await new Promise((resolve) => setTimeout(resolve, 10));
            return Response.json({ title: f.e.title, content: f.e.content });
          } finally {
            activeFetches--;
          }
        },
      }),
    });
    const worker = await engine.worker(ctx);
    try {
      await worker.step("RESEARCH_ONLY_SENTINEL");
      await worker.step("fetch source");
      await worker.step("submit");
      assert.equal(r.candidates.length, 1);
      await worker.step("Read independent leads concurrently");
      await worker.step("Reuse failed result without another network attempt");
      assert.equal(maxFetches, 2);
      assert.equal(r.metrics.readableBodies, 2);
      assert.equal(r.metrics.fetchFailures, 1);
      assert.equal(r.metrics.fetchCalls, 3);
      assert.equal(
        r.leads.find((l) => l.url === f.e.locator).state,
        "submitted",
      );
      assert.equal(
        r.leads.find((l) => l.url.endsWith("/slow")).state,
        "unavailable",
      );
      assert.equal(r.leads.find((l) => l.url.endsWith("/fast")).state, "read");
      const result = await engine.review(
        ctx,
        [r.candidates[0].id],
        controller.signal,
      );
      assert.equal(result.verdicts[0].approve, true);
    } finally {
      await worker.close();
    }
    assert.equal(attempts, 3);
    assert.equal(reviewerCalls, 1);
    assert.match(outbound[0].query, /after:2026-10-10 before:2026-10-25/);
    assert.equal(r.metrics.search, 3);
    assert.equal(r.metrics.fetch, 3);
    const reviewPayload = payloads.at(-1);
    assert.ok(
      !JSON.stringify(reviewPayload).includes("RESEARCH_ONLY_SENTINEL"),
    );
    assert.ok(JSON.stringify(reviewPayload).includes("evidencePacket"));
    assert.ok(JSON.stringify(reviewPayload).includes("行业情报价值标尺"));
    assert.ok(JSON.stringify(reviewPayload).includes("outstandingLeads"));
    for (const p of payloads) {
      const system = p.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("");
      assert.ok(system.includes("Frozen"));
      assert.ok(!system.includes("User Role & Style"));
      assert.ok(
        !p.tools.some((t) =>
          ["bash", "write", "edit", "memory"].includes(t.function.name),
        ),
      );
    }
    // A completed verdict survives a review-only timeout; a whole-run abort does not.
    r.candidates.push({
      ...structuredClone(r.candidates[0]),
      id: randomUUID(),
    });
    const reviewTimeout = new AbortController();
    abortAt = reviewerCalls + 2;
    abortReview = () => reviewTimeout.abort();
    const partial = await engine.review(
      ctx,
      r.candidates.map((c) => c.id),
      reviewTimeout.signal,
    );
    assert.equal(partial.incomplete, true);
    assert.equal(partial.verdicts.length, 1);
    assert.equal(partial.verdicts[0].candidateId, r.candidates[0].id);
    abortAt = reviewerCalls + 2;
    abortReview = () => controller.abort();
    await assert.rejects(
      engine.review(
        ctx,
        r.candidates.map((c) => c.id),
        controller.signal,
      ),
      /abort/i,
    );
    assert.ok(
      !(
        await fs.readFile(
          path.join(store.root, "runs", r.id, "audit.jsonl"),
          "utf8",
        )
      ).includes("fixture-model-secret"),
    );
  },
);

test("historical enrichment uses Shanghai calendar day, summaries omit source bodies", async (t) => {
  const { localDay } = await import("../dist/research/domain.js");
  assert.equal(localDay("2026-10-24T17:00:00Z"), "2026-10-25");
  const store = new ResearchStore(await temp(t));
  await store.init();
  const { e, c, v } = fixture();
  await store.commit(run(), c, v, [e], () => {});
  const rows = await store.summaries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brief.news, c.article.brief.news);
  assert.ok(!JSON.stringify(rows).includes(e.content));
});

test("final submission receives a bounded budget that reserves time for review", async (t) => {
  const dir = await temp(t);
  const budgets = [];
  const settings = {
    ...defaults,
    initialMs: 20,
    checkpointMs: 20,
    maxMs: 400,
    wrapMs: 150,
    reviewMs: 60,
  };
  const service = new ResearchService({
    dataDir: dir,
    resourcesDir,
    settings,
    engine: () => ({
      ready() {},
      async worker(ctx) {
        return {
          async step(_prompt, budget) {
            if (ctx.wrapping()) budgets.push(budget);
            else await new Promise((r) => setTimeout(r, 25));
          },
          async close() {},
        };
      },
      async review() {
        throw new Error("No candidates");
      },
    }),
  });
  await service.init();
  await service.start("2026-10-24");
  await service.wait();
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] > 0 && budgets[0] <= 90);
  await service.close();
});

test("supplements cannot silently drop previously accepted facts", async (t) => {
  const store = new ResearchStore(await temp(t));
  await store.init();
  const { e, c, v } = fixture();
  const r = run();
  const saved = await store.commit(r, c, v, [e], () => {});
  const update = {
    ...c,
    id: randomUUID(),
    action: "update",
    targetId: saved.id,
    expectedVersion: 1,
    article: {
      ...c.article,
      facts: [{ ...c.article.facts[0], claim: "New claim replacing old fact" }],
    },
  };
  await assert.rejects(
    store.commit(r, update, v, [e], () => {}),
    /保留原有事实/,
  );
  assert.equal((await store.item(saved.id)).version, 1);
});

test("partial review timeout commits completed verdicts and retries pending candidates", async (t) => {
  const dir = await temp(t);
  let now = Date.parse("2026-10-24T01:00:00Z");
  const first = fixture(),
    second = fixture();
  second.c.article.eventKey = "Different|warehouse";
  second.e.locator = "https://example.com/second";
  let phases = 0,
    reviews = 0;
  const service = new ResearchService({
    dataDir: dir,
    resourcesDir,
    now: () => now,
    settings: { ...defaults, reviewMs: 5 },
    engine: () => ({
      ready() {},
      async worker(ctx) {
        return {
          async step() {
            if (++phases === 1)
              for (const f of [first, second]) {
                ctx.evidence.set(f.e.id, f.e);
                ctx.run.candidates.push(f.c);
              }
            now += 300000;
          },
          async close() {},
        };
      },
      async review(ctx, ids, signal) {
        if (++reviews === 1) {
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
          return {
            verdicts: [first.v],
            incomplete: true,
            nextDirections: ["审核剩余已读取候选"],
            summary: "部分完成",
          };
        }
        assert.deepEqual(ids, [second.c.id]);
        assert.equal((await ctx.store.items()).length, 1);
        return {
          verdicts: [second.v],
          nextDirections: [],
          summary: "剩余已审核",
        };
      },
    }),
  });
  await service.init();
  await service.start("2026-10-24");
  await service.wait();
  const r = (await service.store.runs())[0];
  assert.equal((await service.store.items()).length, 2);
  assert.equal(reviews, 2);
  assert.equal(r.checkpoints[0].points, 2);
  assert.equal(r.checkpoints[0].continued, true);
  assert.match(r.checkpoints[0].error, /保留已完成判定/);
  assert.equal(r.checkpoints[1].points, 2);
  await service.close();
});

test("lead ledger deduplicates URLs, retains unpursued results and ranks researcher choices", async () => {
  const { registerLeads, pendingLeads } = await import(
    "../dist/research/leads.js"
  );
  const r = run();
  registerLeads(
    r,
    [
      {
        url: "https://example.com/a?utm_source=search",
        title: "Competitor handheld release",
        summary: "Android 16",
      },
      { url: "https://example.com/b", title: "Cold warehouse" },
      { url: "javascript:alert(1)", title: "Invalid" },
    ],
    "retail",
  );
  registerLeads(
    r,
    [{ url: "https://example.com/a", title: "Syndicated headline" }],
    "logistics",
  );
  assert.equal(r.leads.length, 2);
  assert.deepEqual(r.leads[0].scenes, ["retail", "logistics"]);
  r.leads[1].priority = "high";
  assert.equal(pendingLeads(r)[0].title, "Cold warehouse");
  r.leads[1].state = "deferred";
  r.leads[1].reason = "No endpoint link after reading";
  assert.equal(pendingLeads(r).length, 1);
  assert.equal(r.leads[0].state, "unread");
  assert.equal(r.leads[0].summary, "Android 16");
});

test("evidence approval below threshold cannot masquerade as a saved checkpoint result", async (t) => {
  const dir = await temp(t);
  const f = fixture();
  let now = Date.parse("2026-10-24T01:00:00Z"),
    first = true;
  const service = new ResearchService({
    dataDir: dir,
    resourcesDir,
    now: () => now,
    engine: () => ({
      ready() {},
      async worker(ctx) {
        return {
          async step() {
            if (first) {
              ctx.run.candidates.push(f.c);
              ctx.evidence.set(f.e.id, f.e);
              first = false;
            }
            now += 300000;
          },
          async close() {},
        };
      },
      async review() {
        return {
          verdicts: [
            {
              ...f.v,
              scores: {
                relevance: 3,
                commercial: 3,
                evidence: 4,
                importance: 3,
                novelty: 3,
              },
            },
          ],
          nextDirections: [],
          summary: "通过1条行业进展",
        };
      },
    }),
  });
  await service.init();
  await service.start("2026-10-24");
  await service.wait();
  const r = (await service.store.runs())[0];
  assert.equal((await service.store.items()).length, 0);
  assert.equal(r.checkpoints[0].decisions[0].status, "below_threshold");
  assert.equal(r.checkpoints[0].decisions[0].score, 64);
  assert.match(
    r.checkpoints[0].resultSummary,
    /Saved 0; below score threshold 1/,
  );
  await service.close();
});

test("navigation-only product citations cannot substitute for source evidence", () => {
  const f = fixture();
  const product = {
    ...f.e,
    id: randomUUID(),
    kind: "knowledge",
    locator: "products:product-knowledge-vault/index.md",
  };
  f.c.article.urovo.productClaims = [
    {
      claim: "Specific product capability",
      citations: [
        {
          evidenceId: product.id,
          quote: "Customer installed barcode devices.",
        },
      ],
    },
  ];
  assert.throws(() => evidenceCheck(f.c, [f.e, product]), /正式内部资料/);
  assert.doesNotThrow(() =>
    evidenceCheck(f.c, [
      f.e,
      { ...product, locator: "products:DT50P/brochure/DT50P.md" },
    ]),
  );
});

test("run summaries bound the lead payload and omit raw search snippets", async () => {
  const { runSummary } = await import("../dist/research/store.js");
  const r = run();
  r.leads = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    url: "https://example.com/" + i,
    title: "Item " + i,
    summary: "RAW_SEARCH_SNIPPET",
    publishedAt: "",
    scenes: ["retail"],
    state: "unread",
    priority: i === 99 ? "high" : "normal",
  }));
  const summary = runSummary(r);
  assert.equal(summary.leads.length, 30);
  assert.equal(summary.leadStats.total, 100);
  assert.equal(summary.leads[0].id, "99");
  assert.ok(!JSON.stringify(summary).includes("RAW_SEARCH_SNIPPET"));
  const legacy = runSummary(run());
  assert.equal(legacy.leadStats, undefined);
});

test("publication labels override signature/event dates without inventing a date", async () => {
  const { publicationDates } = await import("../dist/research/dates.js");
  const f = fixture("2026-10-15");
  f.e.content =
    "发布日期：2026\\-10\\-23 10:40\n各企业请执行本方案。\n2026年10月15日\n" +
    f.e.content;
  f.c.article.dateEvidence = { evidenceId: f.e.id, quote: "2026年10月15日" };
  assert.equal(publicationDates(f.e.content)[0].day, "2026-10-23");
  assert.throws(() => evidenceCheck(f.c, [f.e]), /归档日期.*冲突/);
  f.c.article.disclosureDate = "2026-10-23";
  f.c.article.dateEvidence.quote = "发布日期：2026\\-10\\-23";
  assert.doesNotThrow(() => evidenceCheck(f.c, [f.e]));
  assert.deepEqual(
    publicationDates("成文日期：2026-10-15\n项目将于2026-10-23启动"),
    [],
  );
  assert.deepEqual(
    publicationDates("Published on October 23, 2026").map((x) => x.day),
    ["2026-10-23"],
  );
  assert.deepEqual(publicationDates("发布日期：2026-02-30"), []);
});

test("initial capture after end date is not mislabeled as a later enrichment", async (t) => {
  const dir = await temp(t);
  const service = new ResearchService({
    dataDir: dir,
    resourcesDir,
    engine: () => ({ ready() {} }),
  });
  await service.init();
  const f = fixture();
  const created = await service.store.commit(run(), f.c, f.v, [f.e], () => {});
  assert.equal(
    (await service.browse("2026-10-24")).items[0].updatedAfterCutoff,
    false,
  );
  assert.ok(!(await service.export("2026-10-24")).includes("后续补充"));
  const old = await service.store.item(created.id);
  const candidate = {
    ...f.c,
    id: randomUUID(),
    action: "sources",
    targetId: old.id,
    expectedVersion: old.version,
    reason: "追加来源审计",
  };
  await service.store.commit(
    run(),
    candidate,
    { ...f.v, candidateId: candidate.id },
    [f.e],
    () => {},
  );
  assert.equal(
    (await service.browse("2026-10-24")).items[0].updatedAfterCutoff,
    true,
  );
  assert.ok((await service.export("2026-10-24")).includes("后续补充"));
  await service.close();
});
