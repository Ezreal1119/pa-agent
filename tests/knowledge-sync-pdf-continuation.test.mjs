import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createConverter } from "../dist/knowledge-sync/converter.js";
import { fileToolConfig } from "../dist/file-tools/config.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";
import { nextContinuationPage, continuationQuotes } from "../dist/knowledge-sync/pdf-continuation.js";

const tail = "10. Supports flexible anti-metal labels with a";
const head = "thickness not exceeding 1.5 mm.";
const boundaryIssue = "The 'Other Attributes' cell text is cut off at the bottom page boundary, ending mid-sentence.";
const incomplete = { complete: false, text: tail, issues: [boundaryIssue] };
const reviewed = { complete: true, text: tail, issues: [], continuation: { confirmed: true, tail, head } };
const whole = (page, file = `image-${page - 1}.png`) => ({
  file,
  label: `Page ${page}, region x=0 y=0 width=800 height=600`,
  context: `Full page ${page} is 800×600 px. This region is the entire source. Its left, right, top, bottom edge(s) are the real page boundary.`,
});

function respond(res, result, finish = "stop") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ finish_reason: finish, message: { content: JSON.stringify(result) } }],
  }));
}

async function fixture(t, handler, { pages = 2, budget = 128, timeoutMs = 1000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-pdf-continuation-"));
  const source = path.join(root, "fixture.pdf"), work = path.join(root, "work");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([400, 300]);
    page.drawText(i ? head : tail, { x: 20, y: i ? 260 : 20, size: 12, font });
  }
  await fs.writeFile(source, await pdf.save());
  const original = await fs.readFile(source);
  const requests = [];
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    requests.push(body);
    try { await handler(req, res, body, requests.length, { root, source, work }); }
    catch (error) { res.destroy(error); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = fileToolConfig(root, {
    timeoutMs: 15000,
    markitdown: path.resolve(".data/file-runtime/bin/markitdown"),
    vision: { apiKey: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture", timeoutMs },
  }, {});
  let acquired = 0, released = 0;
  const converter = createConverter(config, "unused", budget, async () => {
    acquired++;
    return () => { released++; };
  });
  const usage = emptyUsage();
  const run = (signal = new AbortController().signal, totals = usage) => converter(source, work, signal, totals, async () => {});
  return { root, source, work, original, requests, usage, run, gates: () => [acquired, released] };
}

test("only a whole PDF page with exclusively bottom-boundary issues and its immediate whole following page is eligible", () => {
  const a = whole(12), b = whole(13), c = whole(14);
  assert.equal(nextContinuationPage("source.pdf", a, [a, b, c], incomplete), b);
  const invalid = [
    ["source.docx", a, [a, b], incomplete],
    ["source.pptx", a, [a, b], incomplete],
    ["source.png", a, [a, b], incomplete],
    ["source.pdf", a, [a, c], incomplete],
    ["source.pdf", a, [a, b, { ...b }], incomplete],
    ["source.pdf", a, [a, { ...b, context: "Full page 13 is 1600×600 px." }], incomplete],
    ["source.pdf", { ...a, label: a.label.replace("x=0", "x=200") }, [a, b], incomplete],
    ["source.pdf", a, [a, b], { ...incomplete, complete: true }],
    ["source.pdf", a, [a, b], { ...incomplete, text: null }],
    ["source.pdf", a, [a, b], { ...incomplete, issues: [] }],
    ["source.pdf", a, [a, b], { ...incomplete, issues: [boundaryIssue, "Unreadable serial number"] }],
    ["source.pdf", a, [a, b], { ...incomplete, issues: ["Text cut off inside the table"] }],
    ["source.pdf", a, [a, b], { ...incomplete, issues: ["Missing text cut off at the bottom page boundary"] }],
  ];
  for (const args of invalid) assert.equal(nextContinuationPage(...args), undefined);
  assert.deepEqual(continuationQuotes(reviewed), { tail, head });
  for (const continuation of [undefined, {}, { confirmed: false, tail, head }, { confirmed: true, tail: "a", head }, { confirmed: true, tail, head: "x".repeat(501) }]) {
    assert.equal(continuationQuotes({ ...reviewed, continuation }), undefined);
  }
  assert.equal(continuationQuotes({ ...reviewed, text: "Unrelated transcription" }), undefined);
  assert.equal(continuationQuotes({ ...reviewed, text: "label count 12 mm", continuation: { confirmed: true, tail: "label count 1² mm", head } }), undefined,
    "do not normalize distinct digits or units into matching continuation evidence");
});

test("ordinary successful PDF pages keep one request each, the same prompt and reusable caches", { timeout: 30000 }, async t => {
  const f = await fixture(t, (_req, res, _body, call) => respond(res, { complete: true, text: call === 1 ? tail : head, issues: [] }));
  const result = await f.run();
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.messages[1].content.filter(c => c.type === "image_url").length, 1);
    assert.doesNotMatch(request.messages[0].content, /cross-page continuation review/);
  }
  assert.equal(result.coverage.filter(c => c.endsWith(": inspected")).length, 2);
  assert.doesNotMatch(result.coverage.join("\n"), /continuation/);
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await fs.readFile(f.source), f.original);
  assert.deepEqual(f.gates(), [2, 2]);
});

test("normal table continuation is reviewed once, independently checks the following page, and only then checkpoints", { timeout: 30000 }, async t => {
  let beforeFollowing;
  const f = await fixture(t, async (_req, res, body, call, { work }) => {
    if (call === 1) respond(res, incomplete);
    else if (call === 2) {
      assert.equal(body.messages[1].content.filter(c => c.type === "image_url").length, 2);
      assert.match(body.messages[1].content[2].text, /Following page \(context only\): Page 2/);
      assert.match(body.messages[0].content, /do not copy the following page into text/);
      respond(res, reviewed);
    } else {
      beforeFollowing = await fs.stat(path.join(work, "image-0.png.json")).catch(() => null);
      assert.equal(body.messages[1].content.filter(c => c.type === "image_url").length, 1);
      respond(res, { complete: true, text: head, issues: [] });
    }
  });
  const result = await f.run();
  assert.equal(beforeFollowing, null, "do not mark TARGET complete before independently verifying the continuation");
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.usage, { input: 30, output: 15, requests: 3, recorded: 3 });
  assert.deepEqual(f.gates(), [3, 3]);
  assert.equal(result.coverage.filter(c => c.endsWith(": inspected")).length, 2);
  assert.match(result.coverage.join("\n"), /cross-page continuation verified/);
  const cache = JSON.parse(await fs.readFile(path.join(f.work, "image-0.png.json"), "utf8"));
  assert.equal(cache.continuationSourceHash, result.sourceHash);
  assert.equal(cache.text, tail, "neighbour text is not duplicated into the TARGET page");
  assert.deepEqual(await fs.readFile(f.source), f.original);
  await f.run();
  await fs.rm(path.join(f.work, "conversion.json"));
  await f.run();
  assert.equal(f.requests.length, 3, "verified page caches also resume without another model call");

  // Same page pixels, different document identity: a reviewed TARGET cache may
  // not be reused solely because its own image still has the same hash.
  const changed = await PDFDocument.load(f.original);
  changed.setTitle("Changed PDF identity");
  await fs.writeFile(f.source, await changed.save());
  const modified = await f.run(undefined, emptyUsage());
  assert.notEqual(modified.sourceHash, result.sourceHash);
  assert.equal(f.requests.length, 4, "TARGET gets a fresh check; ordinary following-page cache stays reusable");
});

test("real clipping, unreadable evidence and last-page truncation require review without complete caches", { timeout: 30000 }, async t => {
  for (const [name, first, pages, expectedCalls] of [
    ["real clipping", incomplete, 2, 3],
    ["mixed issues", { ...incomplete, issues: [boundaryIssue, "Unreadable value in another cell"] }, 2, 2],
    ["last page", incomplete, 1, 1],
  ]) await t.test(name, async t => {
    const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1 ? first : { complete: false, text: tail, issues: ["The continuation is absent; actual text is clipped."] }), { pages });
    await assert.rejects(f.run(), /Unresolved visual evidence/);
    assert.equal(f.requests.length, expectedCalls);
    assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
  });
});

test("review cannot pass without quotes or with an invented continuation that the following page does not confirm", { timeout: 30000 }, async t => {
  for (const [name, review, next, calls] of [
    ["no quotes", { complete: true, text: tail, issues: [] }, head, 2],
    ["unconfirmed", { ...reviewed, continuation: { confirmed: false, tail, head } }, head, 2],
    ["invented head", reviewed, "Unrelated following-page text", 3],
  ]) await t.test(name, async t => {
    const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1 ? incomplete : call === 2 ? review : { complete: true, text: next, issues: [] }));
    await assert.rejects(f.run(), /Unresolved visual evidence.*(?:verifiable continuation quotes|independent transcription)/);
    assert.equal(f.requests.length, calls);
    assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
  });
});

test("following-page failure cannot publish or cache the provisional TARGET evidence", { timeout: 30000 }, async t => {
  const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1 ? incomplete : call === 2 ? reviewed : { complete: false, text: head, issues: ["Unreadable diagram"] }));
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /Unresolved visual evidence/);
    assert.equal(error.review.issues.length, 2);
    assert.match(error.review.issues[1].label, /Page 2/);
    assert.deepEqual(error.review.issues[1].issues, ["Unreadable diagram"]);
    return true;
  });
  assert.equal(f.requests.length, 3);
  assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
});

test("review and following-page verification remain within the original request budget", { timeout: 30000 }, async t => {
  for (const budget of [1, 2]) await t.test(`budget ${budget}`, async t => {
    const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1 ? incomplete : reviewed), { budget });
    await assert.rejects(f.run(), /Vision call budget exceeded at Page/);
    assert.equal(f.requests.length, budget);
    assert.equal(f.usage.requests, budget);
    assert.deepEqual(f.gates(), [budget, budget]);
    assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
  });
});

test("an ordinary timeout keeps its one retry before a single contextual review", { timeout: 30000 }, async t => {
  const f = await fixture(t, (_req, res, _body, call) => {
    if (call === 1) return;
    respond(res, call === 2 ? incomplete : call === 3 ? reviewed : { complete: true, text: head, issues: [] });
  }, { timeoutMs: 150 });
  const result = await f.run();
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.usage, { input: 30, output: 15, requests: 4, recorded: 3 });
  assert.deepEqual(f.gates(), [4, 4]);
  assert.match(result.coverage.join("\n"), /timed out.*retrying once/);
  assert.match(result.coverage.join("\n"), /cross-page continuation verified/);
});

test("review timeout, HTTP error, cancellation, malformed and truncated output never fall back to the rejected result", { timeout: 30000 }, async t => {
  for (const scenario of ["timeout", "http", "cancel", "malformed", "truncated"]) await t.test(scenario, async t => {
    const controller = new AbortController();
    const f = await fixture(t, (_req, res, _body, call) => {
      if (call === 1) return respond(res, incomplete);
      if (scenario === "timeout") return;
      if (scenario === "cancel") return controller.abort(new DOMException("Cancelled fixture", "AbortError"));
      if (scenario === "http") { res.writeHead(503); res.end("unavailable"); return; }
      if (scenario === "malformed") { res.writeHead(200); res.end("{invalid"); return; }
      respond(res, reviewed, "length");
    }, { timeoutMs: 150 });
    await assert.rejects(f.run(controller.signal), scenario === "timeout" ? /timed out.*attempt 1\/1/ : scenario === "http" ? /Vision HTTP 503/ : scenario === "cancel" ? /Vision conversion cancelled/ : scenario === "truncated" ? /truncated/ : /JSON|Unexpected|Expected/);
    assert.equal(f.requests.length, 2, "at most one contextual review request, including on timeout");
    assert.deepEqual(f.gates(), [2, 2]);
    assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
  });
});
