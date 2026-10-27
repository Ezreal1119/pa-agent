import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { PDFDocument, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import { createConverter } from "../dist/knowledge-sync/converter.js";
import { fileToolConfig } from "../dist/file-tools/config.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";
import { nextContinuationPage, continuationQuotes, containsContinuationQuote, matchesContinuationHead } from "../dist/knowledge-sync/pdf-continuation.js";

const tail = "10. Supports flexible anti-metal labels with a";
const head = "thickness not exceeding 1.5 mm.";
const boundaryIssue = "The 'Other Attributes' cell text is cut off at the bottom page boundary, ending mid-sentence.";
const screenshotIssue = 'The specifications table sentence is cut off at the page boundary after "POS terminal and the".';
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

async function fixture(t, handler, { pages = 2, budget = 128, timeoutMs = 1000, format = "pdf", pageTexts = [tail, head] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-pdf-continuation-"));
  const source = path.join(root, `fixture.${format}`), work = path.join(root, "work");
  if (format === "docx") {
    // Exercise the real DOCX -> LibreOffice PDF -> page-image worker, using
    // explicit pagination and a generic font so no Windows fonts are required.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    const paragraphs = Array.from({ length: pages }, (_, i) => `<w:p>${i ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : ""}<w:r><w:rPr><w:rFonts w:ascii="serif" w:hAnsi="serif"/></w:rPr><w:t>${i ? pageTexts[1] : pageTexts[0]}</w:t></w:r></w:p>`).join("");
    zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="8000" w:h="6000"/><w:pgMar w:top="400" w:right="400" w:bottom="400" w:left="400"/></w:sectPr></w:body></w:document>`);
    await fs.writeFile(source, await zip.generateAsync({ type: "nodebuffer" }));
  } else {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
      const page = pdf.addPage([400, 300]);
      page.drawText(i ? pageTexts[1] : pageTexts[0], { x: 20, y: i ? 260 : 20, size: 12, font });
    }
    await fs.writeFile(source, await pdf.save());
  }
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
    timeoutMs: format === "docx" ? 45000 : 15000,
    markitdown: path.resolve(".data/file-runtime/bin/markitdown"),
    vision: { apiKey: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture", timeoutMs },
  }, {});
  let acquired = 0, released = 0;
  const converter = createConverter(config, format === "docx" ? process.env.SYNC_SOFFICE_COMMAND || "soffice" : "unused", budget, async () => {
    acquired++;
    return () => { released++; };
  });
  const usage = emptyUsage();
  const run = (signal = new AbortController().signal, totals = usage) => converter(source, work, signal, totals, async () => {});
  return { root, source, work, original, requests, usage, run, gates: () => [acquired, released] };
}

test("only whole PDF/DOCX pages with exclusively bottom-boundary issues and an immediate whole following page are eligible", () => {
  const a = whole(12), b = whole(13), c = whole(14);
  assert.equal(nextContinuationPage("source.pdf", a, [a, b, c], incomplete), b);
  assert.equal(nextContinuationPage("source.docx", a, [a, b, c], incomplete), b);
  assert.equal(nextContinuationPage("source.DOCX", a, [a, b, c], incomplete), b);
  const invalid = [
    ["source.doc", a, [a, b], incomplete],
    ["source.xlsx", a, [a, b], incomplete],
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
  for (const args of invalid) {
    assert.equal(nextContinuationPage(...args), undefined);
    if (args[0] === "source.pdf") assert.equal(nextContinuationPage("source.docx", ...args.slice(1)), undefined);
  }
  assert.deepEqual(continuationQuotes(reviewed), { tail, head });
  for (const continuation of [undefined, {}, { confirmed: false, tail, head }, { confirmed: true, tail: "a", head }, { confirmed: true, tail, head: "x".repeat(501) }]) {
    assert.equal(continuationQuotes({ ...reviewed, continuation }), undefined);
  }
  assert.equal(continuationQuotes({ ...reviewed, text: "Unrelated transcription" }), undefined);
  assert.equal(continuationQuotes({ ...reviewed, text: "label count 12 mm", continuation: { confirmed: true, tail: "label count 1² mm", head } }), undefined,
    "do not normalize distinct digits or units into matching continuation evidence");
});

test("page boundary/page break wording enters review without admitting side clipping or unrelated failures", () => {
  const a = whole(1), b = whole(2);
  for (const source of ["source.pdf", "source.docx"]) {
    for (const issue of [
      screenshotIssue,
      "The sentence is cut off at a page boundary.",
      "The table row ends mid-sentence across page boundaries.",
      "Text is truncated at the page-boundary.",
      "The cell is cut off at the page break.",
      "The sentence continues across a page-break.",
      boundaryIssue,
    ]) assert.equal(nextContinuationPage(source, a, [a, b], { ...incomplete, issues: [issue] }), b, issue);
    for (const issues of [
      ["The table is at a page boundary."],
      ["Text cut off inside a table cell."],
      ["Text cut off at the left page boundary."],
      ["Text cut off at the right-hand page edge, near a page boundary."],
      ["Text is truncated at the top of the page boundary."],
      ["Text is truncated at the top edge near a page break."],
      ["Missing numbers at the page boundary; the cell is cut off."],
      ["The cropped sentence is cut off at the page boundary."],
      [screenshotIssue, "Unreadable serial number"],
      [screenshotIssue, "The diagram is cut off inside a cell"],
    ]) assert.equal(nextContinuationPage(source, a, [a, b], { ...incomplete, issues }), undefined, issues.join("; "));
    assert.equal(nextContinuationPage(source, a, [a], { ...incomplete, issues: [screenshotIssue] }), undefined);
    assert.equal(nextContinuationPage(source, { ...a, label: a.label.replace("x=0", "x=50") }, [a, b], { ...incomplete, issues: [screenshotIssue] }), undefined);
  }
});

const cradleTail = "Supports wireless communication between the POS terminal and the";
const cradleNext = "cradle.\n\n| Interfaces | USB Type-C*1 (Power)\nLAN*1 (RJ45)\nRS232*1 (RJ45)\nUSB Type-A*1 (HOST)\nUSB Type-C*1 (Device) |\n| Physical | L x W x H (mm): 221*93*46mm |\n| Adaptor | 5V/2A |";
const cradleTarget = `| Communication | Bluetooth & Wi-Fi\n${cradleTail} |`;

test("short continuations require a target ending and a complete next-page prefix; table layout never erases values", () => {
  const value = { text: cradleTarget, continuation: { confirmed: true, tail: cradleTail, head: "cradle." } };
  assert.deepEqual(continuationQuotes(value), { tail: cradleTail, head: "cradle." });
  assert.equal(continuationQuotes({ ...value, text: `${cradleTarget}\nUnrelated later target text` }), undefined);
  for (const badHead of ["", "...", "| --- |", " ", "x".repeat(501)]) {
    assert.equal(continuationQuotes({ ...value, continuation: { ...value.continuation, head: badHead } }), undefined);
  }
  assert.equal(matchesContinuationHead(cradleNext, "cradle."), true);
  assert.equal(matchesContinuationHead("| | cradle. |", "cradle."), true);
  assert.equal(matchesContinuationHead("Other content before cradle.", "cradle."), false);
  assert.equal(matchesContinuationHead("cradle.X", "cradle."), false);
  assert.equal(matchesContinuationHead("5V/2A", "5V"), false);
  assert.equal(matchesContinuationHead("---", "---"), false);
  assert.equal(matchesContinuationHead(cradleNext, "cradle. Interfaces USB Type-C*1 (Power)"), true);
  assert.equal(containsContinuationQuote("| Label | Value |\n| --- | :---: |\n| Device | USB Type-C\\*1 |", "Device USB Type-C*1"), true);
  for (const [actual, quote] of [
    ["| Value | 1² mm |", "Value 12 mm"],
    ["| Value | -5 V |", "Value 5 V"],
    ["| Value | 5V/2A |", "Value 5V 2A"],
    ["| Value | 1*2 |", "Value 12"],
    ["| Value | A\\|B |", "Value A B"],
    ["A | B", "A B"],
    ["prefix ends |", "prefix ends other"],
  ]) assert.equal(containsContinuationQuote(actual, quote), false, `${actual} must not match ${quote}`);
});

test("DOCX cradle continuation and plain-text table quotes verify against an independent Markdown transcription", { timeout: 120000 }, async t => {
  for (const quote of ["cradle.", "cradle. Interfaces USB Type-C*1 (Power)"]) await t.test(quote, async t => {
    const f = await fixture(t, async (_req, res, body, call, { work }) => {
      if (call === 1) return respond(res, { ...incomplete, text: cradleTarget, issues: [screenshotIssue] });
      if (call === 2) {
        assert.match(body.messages[0].content, /never pad it/);
        assert.equal(body.messages[1].content.filter(c => c.type === "image_url").length, 2);
        assert.ok(body.messages[1].content[2].text.includes(screenshotIssue.replaceAll('"', '\\"')));
        return respond(res, { complete: true, text: cradleTarget, issues: [], continuation: { confirmed: true, tail: cradleTail, head: quote } });
      }
      assert.equal(await fs.stat(path.join(work, "image-0.png.json")).catch(() => null), null);
      const audit = JSON.parse(await fs.readFile(path.join(work, "image-0.png.continuation.json"), "utf8"));
      assert.equal(audit.verification.status, "pending");
      respond(res, { complete: true, text: cradleNext, issues: [] });
    }, { format: "docx", pageTexts: [cradleTail, "cradle."] });
    const result = await f.run();
    assert.equal(f.requests.length, 3);
    assert.match(result.coverage.join("\n"), /cross-page continuation verified/);
    assert.match(result.markdown, /221\*93\*46mm/);
    const audit = JSON.parse(await fs.readFile(path.join(f.work, "image-0.png.continuation.json"), "utf8"));
    assert.equal(audit.sourceHash, result.sourceHash);
    assert.equal(audit.result.continuation.head, quote);
    assert.deepEqual(audit.priorIssues, [screenshotIssue]);
    assert.equal(audit.target.file, "image-0.png");
    assert.equal(audit.following.file, "image-1.png");
    assert.equal(audit.following.imageHash, JSON.parse(await fs.readFile(path.join(f.work, "image-1.png.json"), "utf8")).hash);
    assert.equal(audit.verification.status, "verified");
    assert.equal(audit.verification.followingText, cradleNext);
    const stat = await fs.stat(path.join(f.work, "image-0.png.continuation.json"));
    assert.equal(stat.mode & 0o777, 0o600);
    await f.run();
    assert.equal(f.requests.length, 3);
  });
});

test("a short DOCX continuation found elsewhere cannot certify the next page and leaves diagnostic quotes", { timeout: 60000 }, async t => {
  const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1
    ? { ...incomplete, text: cradleTail }
    : call === 2 ? { complete: true, text: cradleTail, issues: [], continuation: { confirmed: true, tail: cradleTail, head: "cradle." } }
    : { complete: true, text: "Unrelated opening text.\ncradle.", issues: [] }), { format: "docx", pageTexts: [cradleTail, "cradle."] });
  await assert.rejects(f.run(), /continuation quote was not confirmed/);
  const audit = JSON.parse(await fs.readFile(path.join(f.work, "image-0.png.continuation.json"), "utf8"));
  assert.equal(audit.result.continuation.head, "cradle.");
  assert.equal(audit.verification.status, "mismatch");
  assert.match(audit.verification.reason, /not confirmed/);
  assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
});

for (const format of ["pdf", "docx"]) {
test(`ordinary successful ${format} pages keep one request each, the same prompt and reusable caches`, { timeout: 60000 }, async t => {
  const f = await fixture(t, (_req, res, _body, call) => respond(res, { complete: true, text: call === 1 ? tail : head, issues: [] }), { format });
  const result = await f.run();
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.messages[1].content.filter(c => c.type === "image_url").length, 1);
    assert.doesNotMatch(request.messages[0].content, /cross-page continuation review/);
  }
  assert.equal(result.coverage.filter(c => c.endsWith(": inspected")).length, 2);
  assert.doesNotMatch(result.coverage.join("\n"), /continuation/);
  assert.equal(await fs.stat(path.join(f.work, "image-0.png.continuation.json")).catch(() => null), null);
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await fs.readFile(f.source), f.original);
  assert.deepEqual(f.gates(), [2, 2]);
});

test(`${format} table continuation is reviewed once, independently checks the following page, and only then checkpoints`, { timeout: 60000 }, async t => {
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
  }, { format });
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
  if (format === "pdf") {
    const changed = await PDFDocument.load(f.original);
    changed.setTitle("Changed PDF identity");
    await fs.writeFile(f.source, await changed.save());
  } else {
    const changed = await JSZip.loadAsync(f.original);
    changed.file("docProps/core.xml", `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Changed DOCX identity</dc:title></cp:coreProperties>`);
    await fs.writeFile(f.source, await changed.generateAsync({ type: "nodebuffer" }));
  }
  const modified = await f.run(undefined, emptyUsage());
  assert.notEqual(modified.sourceHash, result.sourceHash);
  assert.equal(f.requests.length, 4, "TARGET gets a fresh check; ordinary following-page cache stays reusable");
});

test(`${format}: real clipping, unreadable evidence and last-page truncation require review without complete caches`, { timeout: 120000 }, async t => {
  for (const [name, first, pages, expectedCalls] of [
    ["real clipping", { ...incomplete, issues: [screenshotIssue] }, 2, 3],
    ["mixed issues", { ...incomplete, issues: [screenshotIssue, "Unreadable value in another cell"] }, 2, 2],
    ["last page", { ...incomplete, issues: [screenshotIssue] }, 1, 1],
  ]) await t.test(name, async t => {
    const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1 ? first : { complete: false, text: tail, issues: ["The continuation is absent; actual text is clipped."] }), { pages, format });
    await assert.rejects(f.run(), /Unresolved visual evidence/);
    assert.equal(f.requests.length, expectedCalls);
    assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
    const auditPath = path.join(f.work, "image-0.png.continuation.json");
    if (name === "real clipping") {
      assert.equal(JSON.parse(await fs.readFile(auditPath, "utf8")).verification.status, "rejected");
    } else assert.equal(await fs.stat(auditPath).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
  });
});

test(`${format}: review cannot pass without quotes or with an invented continuation that the following page does not confirm`, { timeout: 120000 }, async t => {
  for (const [name, review, next, calls] of [
    ["no quotes", { complete: true, text: tail, issues: [] }, head, 2],
    ["unconfirmed", { ...reviewed, continuation: { confirmed: false, tail, head } }, head, 2],
    ["invented head", reviewed, "Unrelated following-page text", 3],
  ]) await t.test(name, async t => {
    const f = await fixture(t, (_req, res, _body, call) => respond(res, call === 1 ? incomplete : call === 2 ? review : { complete: true, text: next, issues: [] }), { format });
    await assert.rejects(f.run(), /Unresolved visual evidence.*(?:verifiable continuation quotes|independent transcription)/);
    assert.equal(f.requests.length, calls);
    const audit = JSON.parse(await fs.readFile(path.join(f.work, "image-0.png.continuation.json"), "utf8"));
    assert.equal(audit.verification.status, calls === 2 ? "invalid_quotes" : "mismatch");
    assert.equal(await fs.stat(path.join(f.work, "image-0.png.json")).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.work, "conversion.json")).catch(() => null), null);
  });
});
}

test("retrying a pending DOCX region handles page-boundary wording while reusing the completed following page", { timeout: 60000 }, async t => {
  const f = await fixture(t, (_req, res, _body, call) => respond(res,
    call === 1 ? { ...incomplete, issues: ["Unreadable table ending"] } :
    call === 2 ? { complete: true, text: head, issues: [] } :
    call === 3 ? { ...incomplete, issues: [screenshotIssue] } : reviewed), { format: "docx" });
  await assert.rejects(f.run(), /Unresolved visual evidence/);
  const nextCachePath = path.join(f.work, "image-1.png.json");
  const nextCache = await fs.readFile(nextCachePath, "utf8");
  await assert.rejects(f.run(), /Unresolved visual evidence/);
  assert.equal(f.requests.length, 2, "pending evidence is retained until an explicit retry");
  // Retry this region removes only its partial checkpoint, as SyncService does.
  await fs.rm(path.join(f.work, "image-0.png.partial.json"));
  const result = await f.run();
  assert.equal(f.requests.length, 4, "only the target and its contextual review need new requests");
  assert.match(result.coverage.join("\n"), /cross-page continuation verified/);
  const audit = JSON.parse(await fs.readFile(path.join(f.work, "image-0.png.continuation.json"), "utf8"));
  assert.deepEqual(audit.priorIssues, [screenshotIssue]);
  assert.equal(audit.verification.status, "verified");
  assert.equal(await fs.readFile(nextCachePath, "utf8"), nextCache);
  assert.deepEqual(await fs.readFile(f.source), f.original);
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
  const audit = JSON.parse(await fs.readFile(path.join(f.work, "image-0.png.continuation.json"), "utf8"));
  assert.equal(audit.verification.status, "following_incomplete");
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
