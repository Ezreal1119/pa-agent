import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createConverter } from '../dist/knowledge-sync/converter.js';
import { fileToolConfig } from '../dist/file-tools/config.js';
import { emptyUsage } from '../dist/knowledge-sync/core.js';
import { automaticMinorOmission } from '../dist/knowledge-sync/minor-visual-omissions.js';
import { nativeRecoveryEligible, hasNativeCompletion, verifyNativeRepairs } from '../dist/knowledge-sync/pdf-native-text.js';
import { onlyMissingPrecedingContext } from '../dist/knowledge-sync/pdf-continuation.js';
import { visualIssue } from '../dist/knowledge-sync/visual-review.js';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/rt30-visual-regressions.json', import.meta.url), 'utf8'));
const partial = (row, issues = row.issues) => visualIssue('source', 'pixels', `page-${row.page}.png`, `Page ${row.page}`, row.text, issues);

test('actual RT30 issues: exactly four incidental screenshots qualify with same-page native and readable instructions', () => {
  const accepted = [];
  for (const row of fixture.cases) {
    const decision = automaticMinorOmission(partial(row), [], row.nativeText);
    assert.equal(!!decision, row.incidental, `Page ${row.page}`);
    if (decision) {
      accepted.push(row.page);
      assert.equal(decision.policyVersion, 2); assert.equal(decision.decisions[0].kind, 'incidental');
      assert.equal(automaticMinorOmission(partial(row), []), undefined, 'a statement in OCR alone is insufficient');
      assert.equal(automaticMinorOmission({ ...partial(row), text: 'Unrelated screenshot' }, [], row.nativeText), undefined);
      for (const suffix of [' A safety warning is also unreadable.', ' The selected value is missing.', ' The model and PIN definition are obscured.', ' Another operational instruction is clipped.', ' Privacy permissions are unclear.'])
        assert.equal(automaticMinorOmission(partial(row, row.issues.map(s => s + suffix)), [], row.nativeText), undefined);
    }
  }
  assert.deepEqual(accepted, [36, 46, 60, 68]);
});

test('real PDF worker supplies native instructions for incidental acceptance, without an extra native review request', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rt30-incidental-'));
  const row = fixture.cases.find(c => c.page === 36);
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([600, 400]).drawText(row.nativeText, { x: 20, y: 320, size: 8, font });
  const source = path.join(root, 'fixture.pdf'), work = path.join(root, 'work');
  await fs.writeFile(source, await doc.save());
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {} calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ complete: false, text: row.text, issues: row.issues }) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const cfg = fileToolConfig(root, { markitdown: path.resolve('.data/file-runtime/bin/markitdown'), timeoutMs: 20000,
    vision: { apiKey: 'fixture', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 } }, {});
  const convert = createConverter(cfg, 'unused', 10, async () => () => {});
  const result = await convert(source, work, new AbortController().signal, emptyUsage(), async () => {});
  assert.equal(calls, 1); assert.equal(result.automaticOmissions[0].decisions[0].kind, 'incidental');
  assert.equal(result.visualResolutions, undefined);
  assert.match(result.markdown, /selected PTP control and complete PTP instruction are retained/);
});

test('generic instructions do not excuse missing target controls, explicit target names or a task about status icons', () => {
  const get = page => fixture.cases.find(c => c.page === page);
  const status = get(60);
  assert.equal(automaticMinorOmission(partial(status), [], status.nativeText + ' Battery status icons show charging warnings.'), undefined);
  const bluetooth = get(46);
  assert.equal(automaticMinorOmission(partial(bluetooth), [], bluetooth.nativeText + ' Select "the required device".'), undefined);
  assert.equal(automaticMinorOmission(partial(bluetooth), [], bluetooth.nativeText + ' Select CT48.'), undefined);
  const app = get(68);
  assert.equal(automaticMinorOmission(partial(app), [], app.nativeText + ' Select "the required application".'), undefined);
  assert.equal(automaticMinorOmission(partial(app), [], app.nativeText + ' Select Google Maps.'), undefined);
  const ptp = get(36);
  assert.equal(automaticMinorOmission({ ...partial(ptp), text: ptp.nativeText }, [], ptp.nativeText), undefined, 'selected PTP option must be visibly retained');
});

test('actual RT30 native layer completes both icon descriptions without changing visible wording or values', () => {
  const n = fixture.native;
  assert.equal(nativeRecoveryEligible(n.issues), true);
  assert.equal(hasNativeCompletion(n.text, n), true);
  const repairs = [0, 2].map((id, issueIndex) => ({ issueIndex, visibleQuote: n.spans[id].text,
    nativeQuote: n.spans[id].text + ' ' + n.spans[id + 1].text, spanIds: [id, id + 1] }));
  const recovered = verifyNativeRepairs(n.text, n.issues, n, { complete: true, repairs });
  assert.match(recovered, /download is complete when static\./);
  assert.match(recovered, /private network \(VPN\)\./);
  assert.equal(verifyNativeRepairs(n.text, n.issues, n, { complete: true, repairs: repairs.slice(0, 1) }), undefined);
  assert.equal(verifyNativeRepairs(n.text, n.issues, n, { complete: true,
    repairs: repairs.map(r => ({ ...r, nativeQuote: r.nativeQuote + ' new product facts' })) }), undefined);
});

test('actual RT30 page 70 is a matching continued sentence, not lost preceding text; genuine mixed issues still block', () => {
  const { head, issues } = fixture.continuation;
  assert.equal(onlyMissingPrecedingContext('Applications\n\n' + head, issues, head), true);
  assert.equal(onlyMissingPrecedingContext('Applications\n\n' + head, [...issues, 'An operational warning is unreadable.'], head), false);
  assert.equal(onlyMissingPrecedingContext('Applications\n\nDifferent head.', issues, head), false);
});
