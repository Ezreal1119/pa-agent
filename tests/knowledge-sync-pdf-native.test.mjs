import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import { nativeRecoveryEligible, verifyNativeRepairs } from '../dist/knowledge-sync/pdf-native-text.js';
import { createConverter } from '../dist/knowledge-sync/converter.js';
import { fileToolConfig } from '../dist/file-tools/config.js';
import { emptyUsage, hash } from '../dist/knowledge-sync/core.js';
import { VisualReviewError } from '../dist/knowledge-sync/visual-review.js';

const prefix = 'Device is downloading data when animated and download is';
const ending = 'complete when static.';
const quote = `${prefix} ${ending}`;
const issue = 'The description in the download row is visibly truncated after "is".';
const native = { spans: [
  { text: prefix, x: 40, y: 100, width: 280, height: 10 },
  { text: ending, x: 40, y: 115, width: 100, height: 10 },
] };
const repair = { issueIndex: 0, visibleQuote: prefix, nativeQuote: quote, spanIds: [0, 1] };
const result = { complete: true, repairs: [repair] };

test('native text recovery recognizes incomplete icon descriptions without admitting missing icon shapes or mixed failures', () => {
  for (const issue of [
    "The table description for the down-arrow icon is incomplete: 'Device is downloading data when animated and download is' stops inside the cell without a visible continuation.",
    "The table description for the key icon is incomplete: 'Device is connected to or disconnected from virtual private' stops inside the cell without a visible continuation.",
    'The sentence stops without its continuation.',
  ]) assert.equal(nativeRecoveryEligible([issue]), true, issue);
  for (const issue of [
    'The icon is incomplete.', 'The text is incomplete and an icon is missing.',
    'The description for the key icon is incomplete and another icon is unreadable.',
    'The diagram is incomplete.', 'The warning label text is incomplete.',
  ]) assert.equal(nativeRecoveryEligible([issue]), false, issue);
  assert.equal(verifyNativeRepairs(prefix,
    ["The table description for the down-arrow icon is incomplete; the sentence stops without a visible continuation."], native, result), quote);
});

test('native recovery accepts only exact, local, prefix-preserving repairs for all issues', () => {
  assert.equal(verifyNativeRepairs(`Download | ${prefix} |`, [issue], native, result), `Download | ${quote} |`);
  for (const value of [
    { complete: false, repairs: [repair] }, { complete: true, repairs: [] },
    { complete: true, repairs: [{ ...repair, nativeQuote: quote.replace('static', 'moving') }] },
    { complete: true, repairs: [{ ...repair, nativeQuote: quote + ' 5V/2A' }] },
    { complete: true, repairs: [{ ...repair, spanIds: [1, 0] }] },
    { complete: true, repairs: [{ ...repair, spanIds: [0, 0] }] },
    { complete: true, repairs: [{ ...repair, spanIds: [0, 99] }] },
    { complete: true, repairs: [{ ...repair, issueIndex: 1 }] },
    { complete: true, repairs: [repair, repair] },
  ]) assert.equal(verifyNativeRepairs(prefix, [issue], native, value), undefined);
  assert.equal(verifyNativeRepairs(prefix + prefix, [issue], native, result), undefined, 'ambiguous visible location');
  assert.equal(verifyNativeRepairs(prefix, [issue, 'Another text line is clipped.'], native, result), undefined);
  for (const bad of ['Warning label is blurred.', 'The text is cut off and an icon is missing.', 'Unrelated content is unreadable.']) {
    assert.equal(nativeRecoveryEligible([bad]), false);
    assert.equal(verifyNativeRepairs(prefix, [bad], native, result), undefined);
  }
  for (const changes of [{ x: 400 }, { y: 300 }, { y: 10 }, { height: 0 }])
    assert.equal(verifyNativeRepairs(prefix, [issue], { spans: [native.spans[0], { ...native.spans[1], ...changes }] }, result), undefined);
  // An alternate native value cannot silently replace a visible number.
  assert.equal(verifyNativeRepairs('Battery capacity is 4000 mAh', [issue],
    { spans: [{ text: 'Battery capacity is 5000 mAh nominal.', x: 0, y: 0, width: 100, height: 10 }] },
    { complete: true, repairs: [{ issueIndex: 0, visibleQuote: 'Battery capacity is 4000 mAh', nativeQuote: 'Battery capacity is 5000 mAh nominal.', spanIds: [0] }] }), undefined);
});

async function fixture(t, mode = 'valid', budget = 10) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-pdf-native-'));
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 300]);
  page.pushOperators(pushGraphicsState(), rectangle(20, 197, 360, 18), clip(), endPath());
  page.drawText(prefix, { x: 20, y: 200, size: 10, font });
  page.drawText(ending, { x: 20, y: 185, size: 10, font });
  page.pushOperators(popGraphicsState());
  const source = path.join(root, 'source.pdf'), work = path.join(root, 'work');
  const bytes = await pdf.save(); await fs.writeFile(source, bytes);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const isNative = body.messages[0].content.includes('native PDF text spans');
    let value = { complete: false, text: `Download | ${prefix} |`, issues: [issue] };
    if (isNative) {
      const evidence = JSON.parse(body.messages[1].content[0].text);
      const ids = evidence.nativeSpans.map(s => s.id);
      value = { complete: true, repairs: [{ ...repair, spanIds: ids,
        nativeQuote: mode === 'forged' ? quote + ' altered.' : quote }] };
      if (mode === 'error') { res.writeHead(500); res.end('unavailable'); return; }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const config = fileToolConfig(root, { markitdown: path.resolve('.data/file-runtime/bin/markitdown'), timeoutMs: 20000,
    vision: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', timeoutMs: 1000 } }, {});
  const converter = createConverter(config, 'unused', budget, async () => () => {});
  const usage = emptyUsage();
  const run = () => converter(source, work, new AbortController().signal, usage, async () => {});
  return { root, source, work, requests, usage, run, bytes: Buffer.from(bytes) };
}

test('clipped PDF sentence is recovered with exact native evidence, accounted and source-bound', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const converted = await f.run();
  assert.equal(f.requests.length, 2); assert.equal(f.usage.requests, 2); assert.equal(f.usage.recorded, 2);
  assert.match(converted.markdown, /download is complete when static/);
  assert(converted.coverage.some(line => line.includes('same-region PDF native text')));
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
  const audit = JSON.parse(await fs.readFile(path.join(f.work, 'image-0.png.native-review.json'), 'utf8'));
  assert.equal(audit.status, 'verified'); assert.equal(audit.sourceHash, hash(f.bytes));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.work, 'image-0.png.json'), 'utf8')).nativeSourceHash, hash(f.bytes));
  await f.run(); assert.equal(f.requests.length, 2);
  // Recover a crash between audit persistence and the successful OCR-cache write.
  await fs.rm(path.join(f.work, 'conversion.json')); await fs.rm(path.join(f.work, 'image-0.png.json'));
  const recovered = await f.run(); assert.match(recovered.markdown, /download is complete when static/);
  assert.equal(f.requests.length, 2);
  const changed = await PDFDocument.load(f.bytes); changed.setTitle('Same pixels, changed source');
  await fs.writeFile(f.source, await changed.save());
  const refreshed = await f.run();
  assert.notEqual(refreshed.sourceHash, hash(f.bytes));
  assert.equal(f.requests.length, 4, 'native repair cache cannot cross a source hash boundary');
});

test('forged repairs, optional HTTP failure and exhausted budget preserve pending visual review', { timeout: 60000 }, async t => {
  for (const [mode, budget, calls] of [['forged', 10, 2], ['error', 10, 2], ['valid', 1, 1]]) await t.test(mode + budget, async t => {
    const f = await fixture(t, mode, budget);
    await assert.rejects(f.run(), VisualReviewError);
    assert.equal(f.requests.length, calls);
    assert.equal(await fs.stat(path.join(f.work, 'image-0.png.json')).catch(() => null), null);
    await assert.rejects(f.run(), VisualReviewError);
    assert.equal(f.requests.length, calls, 'no repeated optional spending on unchanged evidence');
  });
});
