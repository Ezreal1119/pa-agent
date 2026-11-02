import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { UsageLedger } from '../dist/usage/ledger.js';

const ledgerModule = pathToFileURL(path.resolve('dist/usage/ledger.js')).href;
const classifierModule = pathToFileURL(path.resolve('dist/library-import/classifier.js')).href;
const model = { apiKey: 'fixture-only', modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 2048 };
const childPreamble = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageLedger } from ${JSON.stringify(ledgerModule)};
import { createClassifier } from ${JSON.stringify(classifierModule)};
const root = process.argv[1], model = ${JSON.stringify(model)};
`;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-sandbox-')));
  const ledger = new UsageLedger(root); await ledger.init();
  const inbox = path.join(root, 'inbox'); await fs.mkdir(inbox);
  t.after(async () => { await fs.chmod(root, 0o700); await fs.rm(root, { recursive: true, force: true }); });
  return { root, ledger, inbox };
}
function child(t, root, writable, source) {
  let task;
  const done = new Promise((resolve, reject) => {
    task = execFile(process.execPath, ['--permission', '--allow-fs-read=*', ...[writable].flat().map(p => `--allow-fs-write=${p}`), '--input-type=module', '-e', childPreamble + source, root], { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve(stdout);
    });
  });
  void done.catch(() => {});
  t.after(() => { if (task.exitCode === null) task.kill(); });
  return { task, done };
}

test('Library classification and receipt settlement succeed with only the ledger writable, including a read-only parent', async t => {
  const template = await fs.readFile('deploy/product-expert-library-import.service', 'utf8');
  const dropin = await fs.readFile('deploy/product-expert-library-import-usage-ledger.conf', 'utf8');
  const oldTemplate = template.replace(/^ReadWritePaths=.*\/usage-ledger\s*$/m, '');
  for (const profile of [template, oldTemplate + '\n' + dropin]) {
  const f = await fixture(t);
  // Derive the actual allowed paths from both fresh-install and upgrade units.
  const allowed = [...profile.matchAll(/^ReadWritePaths=(.+)$/gm)].flatMap(m => m[1].trim().split(/\s+/)).map(p => p.replace('/opt/ProductExpertCloud/.data', f.root));
  await fs.chmod(f.root, 0o500);
  const { done } = child(t, f.root, allowed, `
    // Node permissions enforce the same narrow write boundary even as root.
    await assert.rejects(fs.mkdir(path.join(root, 'usage-ledger.lock')), { code: 'ERR_ACCESS_DENIED' });
    await assert.rejects(fs.writeFile(path.join(root, 'unrelated'), 'blocked'), { code: 'ERR_ACCESS_DENIED' });
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ category: 'specs', reason: '规格表' }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }); };
    const usage = [];
    const classify = createClassifier(model, 'low', undefined, root);
    const result = await classify({ name: 'fixture.pdf', documentType: 'Specifications', displayPath: 'Fixture / Specifications' }, AbortSignal.timeout(5000), async value => { usage.push(value); });
    assert.equal(result.category, 'specs'); assert.equal(requests, 1); assert.equal(result.usage.recorded, 1);
    const summary = await new UsageLedger(root).summary('2000-01-01', new Date().toISOString());
    assert.equal(summary.requests, 1); assert.equal(summary.priced, 1); assert.equal(summary.pending, 0); assert.ok(summary.cny > 0);
    console.log(JSON.stringify(summary));
  `);
  const summary = JSON.parse(await done); assert.equal(summary.priced, 1);
  const receipt = (await fs.readdir(f.ledger.directory)).find(n => /^[a-f0-9-]{36}\.json$/.test(n));
  const record = JSON.parse(await fs.readFile(path.join(f.ledger.directory, receipt), 'utf8'));
  assert.equal(record.source, 'library-classification'); assert.ok(record.finished);
  assert.equal((await fs.stat(path.join(f.ledger.directory, receipt))).mode & 0o777, 0o600);
  assert.equal(await fs.lstat(f.root + '/usage-ledger.lock').catch(() => null), null);
  }
});

test('missing ledger write access fails before any model request and preserves existing receipts', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.ledger.directory, 'coverage.json'), 'utf8');
  const { done } = child(t, f.root, f.inbox, `
    let requests = 0; globalThis.fetch = async () => { requests++; throw Error('Must not call a model'); };
    await assert.rejects(createClassifier(model, 'low', undefined, root)({ name: 'fixture.pdf', documentType: 'Specifications', displayPath: 'Fixture' }, AbortSignal.timeout(5000), async () => {}), { code: 'ERR_ACCESS_DENIED' });
    assert.equal(requests, 0); console.log('blocked-before-request');
  `);
  assert.match(await done, /blocked-before-request/);
  assert.equal(await fs.readFile(path.join(f.ledger.directory, 'coverage.json'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.ledger.directory), ['coverage.json']);
});

test('main-process accounting and a restricted importer share the internal cross-process lock and preserve the cutoff', async t => {
  const f = await fixture(t), through = '2098-01-01T00:00:00.000Z';
  await f.ledger.summary('2000-01-01', through);
  const release = await lockfile.lock(f.ledger.directory, { realpath: false, lockfilePath: path.join(f.ledger.directory, '.accounting.lock') });
  let output = '', released = false;
  try {
    const { task, done } = child(t, f.root, f.ledger.directory, `
      const receipt = await new UsageLedger(root).start('library-classification', model);
      console.log('ready-to-settle');
      await receipt.finish({ prompt_tokens: 100, completion_tokens: 10 });
      console.log('settled');
    `);
    task.stdout.on('data', part => { output += part; });
    const deadline = Date.now() + 5000;
    while (!output.includes('ready-to-settle')) { if (Date.now() > deadline) throw Error('child did not become ready'); await new Promise(r => setTimeout(r, 10)); }
    assert.equal(await Promise.race([done.then(() => 'bypassed'), new Promise(r => setTimeout(() => r('waiting'), 150))]), 'waiting');
    assert.ok(!output.includes('settled\n'));
    await release(); released = true; assert.match(await done, /settled/);
  } finally { if (!released) await release(); }
  assert.equal((await f.ledger.summary('2000-01-01', through)).requests, 0);
  const next = await f.ledger.summary(through, '2098-01-02'); assert.equal(next.requests, 1); assert.equal(next.priced, 1);
});

test('an internal lock symlink is rejected without following it or changing another directory', async t => {
  const f = await fixture(t), target = path.join(f.root, 'unrelated'); await fs.mkdir(target);
  await fs.symlink(target, path.join(f.ledger.directory, '.accounting.lock'));
  await assert.rejects(f.ledger.summary('2000-01-01', '2098-01-01'), /Linked paths/);
  assert.deepEqual(await fs.readdir(target), []);
});
