import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { createConverter } from '../dist/knowledge-sync/converter.js';
import { VisualReviewError } from '../dist/knowledge-sync/visual-review.js';
import { SyncService } from '../dist/knowledge-sync/service.js';
import { fileToolConfig } from '../dist/file-tools/config.js';
import { emptyUsage } from '../dist/knowledge-sync/core.js';

const hub = 'product-knowledge-vault/products/DT610.md';
const index = 'product-knowledge-vault/index.md';
const target = 'DT610/others/visual_202610260930/source.md';
const incomplete = { complete: false, text: 'Readable product details DT610', issues: ['Small label line is blurred/illegible.'] };
async function fixture(t, { width = 100, handler = () => incomplete } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-visual-review-'));
  const requests = [], seen = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const result = handler(requests.length, body);
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.status ? { error: { message: 'fixture failure' } } : {
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const canvas = createCanvas(width, 100); const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, 100); ctx.fillStyle = 'black'; ctx.fillRect(20, 20, 25, 25);
  const png = canvas.toBuffer('image/png'); const source = path.join(root, 'source.png'), work = path.join(root, 'work');
  await fs.writeFile(source, png);
  const config = fileToolConfig(root, { timeoutMs: 10000, vision: {
    baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', model: 'fixture', timeoutMs: 5000,
  } }, {});
  const converter = createConverter(config, 'unused', 128, async () => () => {});
  const options = { dataDir: path.join(root, 'data'), maxBytes: 30 * 1048576, timeoutMs: 20000,
    modelId: () => 'fixture', redact: e => e.message, converter: () => converter,
    planner: () => async input => {
      seen.push(input);
      return { decision: { action: 'add', reason: 'Verified product', summary: 'Add source', products: ['DT610'], slot: 'others', oldPaths: [], newPath: target,
        versionEvidence: 'Fixture', authorizedException: false, reviewedPaths: [hub, index] },
        staged: new Map([[hub, `# DT610\n${target}`], [index, '[[products/DT610|DT610]]']]) };
    },
  };
  for (const [file, text] of [[hub, '# DT610'], [index, '[[products/DT610|DT610]]']]) {
    const dest = path.join(options.dataDir, 'urovo-product-expert', file); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, text);
  }
  let service = new SyncService(options); await service.init();
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, png, source, work, requests, seen, converter, options,
    get service() { return service; },
    restart: async () => { await service.close(); service = new SyncService(options); await service.init(); },
    run: resolutions => converter(source, work, new AbortController().signal, emptyUsage(), async () => {}, resolutions),
    start: async () => {
      const uploaded = await service.upload('source.png', { headers: {}, async *[Symbol.asyncIterator]() { yield png; } });
      const job = await service.start([uploaded.id]); await service.waitFor(job.id); return service.get(job.id);
    },
  };
}
const submit = (item, action, text) => ({ revision: item.visualReview.revision, decisions: [{ issueId: item.visualReview.issues[0].id, action, ...(text === undefined ? {} : { text }) }] });
const resync = async (f, job, submission, force = false) => {
  await f.service.resync(job.id, job.items[0].id, '', force, submission); await f.service.waitFor(job.id); return f.service.get(job.id);
};

test('all incomplete regions are retained separately; unchanged retry spends no requests and never creates a complete cache', async t => {
  const f = await fixture(t, { width: 2000 }); let review;
  await assert.rejects(f.run(), error => { assert(error instanceof VisualReviewError); review = error.review; return true; });
  assert.equal(review.issues.length, 2); assert.equal(f.requests.length, 2);
  assert.match(await fs.readFile(path.join(f.work, 'partial.md'), 'utf8'), /Readable product details/);
  assert.equal(await fs.stat(path.join(f.work, 'conversion.json')).catch(() => null), null);
  for (const issue of review.issues) {
    assert.equal(await fs.stat(path.join(f.work, issue.file + '.json')).catch(() => null), null);
    assert.match(await fs.readFile(path.join(f.work, issue.file + '.partial.json'), 'utf8'), /blurred/);
  }
  await assert.rejects(f.run(), VisualReviewError); assert.equal(f.requests.length, 2);
  const resolutions = review.issues.map(i => ({ issueId: i.id, sourceHash: review.sourceHash, action: 'accept' }));
  const result = await f.run(resolutions); assert.equal(f.requests.length, 2);
  assert.equal(result.visualResolutions.length, 2); assert.match(result.markdown, /accepted this local omission/);
  await assert.rejects(f.run(), VisualReviewError); assert.equal(f.requests.length, 2, 'approved cache cannot bypass a new run without the decisions');
});

test('accepting or supplementing requires a separate publication confirmation and records the limitation in source', async t => {
  for (const action of ['accept', 'supplement']) await t.test(action, async t => {
    const f = await fixture(t); let job = await f.start(); let item = job.items[0];
    assert.equal(item.status, 'needs_review'); assert.equal(f.seen.length, 0); assert.equal(f.requests.length, 1);
    const detail = await f.service.visualDetail(job.id, item.id, item.visualReview.issues[0].id);
    assert.equal(detail.text, incomplete.text); assert((await f.service.visualImage(job.id, item.id, item.visualReview.issues[0].id)).length > 0);
    await f.restart(); job = await f.service.get(job.id); item = job.items[0];
    job = await resync(f, job, submit(item, action, action === 'supplement' ? 'Correct missing line: batch 17.' : undefined));
    item = job.items[0]; assert.equal(item.status, 'awaiting_confirmation', item.reason);
    assert.equal(f.requests.length, 1); assert.equal(item.visualUsage.requests, 0);
    assert.equal((await f.service.incoming()).length, 1); assert.equal(item.attempts[0].visualReview.issues.length, 1);
    const summary = f.service.summary(job.id);
    assert.equal(summary.items[0].visualResolutions[0].text, undefined);
    const source = item.plan.changes.find(c => c.path === target).after;
    assert.match(source, /Visual evidence limitation/); assert.match(source, /blurred\/illegible/);
    assert.match(source, action === 'accept' ? /must not be inferred/ : /Correct missing line: batch 17/);
    assert.equal(f.seen[0].feedback, '', 'visual acceptance does not authorize unrelated product/version exceptions');
    await f.service.confirm(job.id, item.id); await f.service.waitFor(job.id);
    assert.equal((await f.service.get(job.id)).items[0].status, 'published');
    assert.equal(await fs.readFile(path.join(f.service.root, target), 'utf8'), source);
  });
});

test('decisions are explicit and bound to current issue, revision, pixels and source bytes', async t => {
  const f = await fixture(t); let job = await f.start(); const item = job.items[0];
  const valid = submit(item, 'accept');
  for (const value of [{ ...valid, revision: '0'.repeat(64) }, { ...valid, decisions: [] },
    { ...valid, decisions: [{ issueId: '0'.repeat(64), action: 'accept' }] }, submit(item, 'supplement', '  '),
    { ...valid, decisions: [...valid.decisions, ...valid.decisions] }])
    await assert.rejects(f.service.resync(job.id, item.id, '', false, value));
  await assert.rejects(f.service.resync(job.id, item.id, '', true, valid), /cannot be combined/);
  await fs.appendFile(path.join(f.service.inbox, item.name), 'changed');
  await assert.rejects(f.service.resync(job.id, item.id, '', false, valid), /Original input changed/);
  assert.equal(f.requests.length, 1); assert.equal(f.seen.length, 0);
});

test('retry only removes the chosen partial checkpoint and retains other region results and decisions', async t => {
  let retrying = false;
  const f = await fixture(t, { width: 2000, handler: () => retrying ? { complete: true, text: 'Now readable', issues: [] } : incomplete });
  let job = await f.start(); const issue = job.items[0].visualReview.issues[0];
  job = await resync(f, job, submit(job.items[0], 'accept'));
  assert.equal(job.items[0].status, 'needs_review'); assert.equal(job.items[0].visualReview.issues.length, 1); assert.equal(f.requests.length, 2);
  assert.equal(job.items[0].visualResolutions[0].issueId, issue.id);
  retrying = true; job = await resync(f, job, submit(job.items[0], 'retry'));
  assert.equal(job.items[0].status, 'awaiting_confirmation', job.items[0].reason);
  assert.equal(f.requests.length, 3); assert.equal(job.items[0].visualUsage.requests, 1);
  assert.match(job.items[0].plan.changes.find(c => c.path === target).after, /Now readable/);
});

test('a stale attempt cannot approve a repeated issue even if its content revision is identical', async t => {
  const f = await fixture(t); const first = await f.start();
  const old = first.items[0], acceptance = submit(old, 'accept');
  const current = await resync(f, first, submit(old, 'retry'));
  assert.equal(current.items[0].status, 'needs_review');
  assert.equal(current.items[0].visualReview.revision, old.visualReview.revision);
  await assert.rejects(f.service.resync(first.id, old.id, '', false, acceptance), /pending visual review/);
  assert.equal(f.seen.length, 0);
});

test('a changed source after preview cannot be published under old visual approval', async t => {
  const f = await fixture(t); let job = await f.start(); job = await resync(f, job, submit(job.items[0], 'accept'));
  assert.equal(job.items[0].status, 'awaiting_confirmation');
  await fs.appendFile(path.join(f.service.inbox, job.items[0].name), 'changed');
  await f.service.confirm(job.id, job.items[0].id); await f.service.waitFor(job.id);
  job = await f.service.get(job.id); assert.equal(job.items[0].status, 'failed'); assert.match(job.items[0].reason, /Original input changed/);
  assert.equal(await fs.stat(path.join(f.service.root, target)).catch(() => null), null);
});

test('malformed model responses and HTTP failures remain technical failures', async t => {
  for (const result of [{ status: 503 }, { complete: false, text: 'partial', issues: [5] }, { complete: 'false', text: '', issues: [] }]) await t.test(JSON.stringify(result), async t => {
    const f = await fixture(t, { handler: () => result }); const job = await f.start();
    assert.equal(job.items[0].status, 'failed'); assert.equal(job.items[0].visualReview, undefined);
    assert.equal(f.seen.length, 0); assert.equal(f.requests.length, 1);
  });
});

test('visual evidence HTTP routes retain administrator authentication and CSRF/revision checks', async t => {
  const f = await fixture(t); const job = await f.start(); const item = job.items[0], issue = item.visualReview.issues[0];
  await f.service.close();
  const { createWebServer } = await import('../dist/web/server.js');
  const app = await createWebServer({ cwd: f.root, dataDir: f.options.dataDir, resourcesDir: path.resolve('resources'),
    admin: { account: 'admin', password: 'fixture-password' }, model: { apiKey: 'fixture', baseUrl: 'http://127.0.0.1', modelId: 'fixture' },
    sync: { converter: () => f.converter, planner: f.options.planner }, bridgeToken: 'fixture-machine-key-01234567890123456789' });
  t.after(() => app.close()); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const route = `/api/sync/jobs/${job.id}/items/${item.id}/visual-issues/${issue.id}`;
  assert.equal((await fetch(base + route)).status, 401);
  assert.equal((await fetch(base + route + '/image')).status, 401);
  assert.equal((await fetch(base + route, { headers: { Authorization: 'Bearer fixture-machine-key-01234567890123456789' } })).status, 401);
  const auth = await (await fetch(base + '/api/auth/status')).json();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-token': auth.token },
    body: JSON.stringify({ account: 'admin', password: 'fixture-password' }) });
  const Cookie = login.headers.get('set-cookie').split(';')[0]; const headers = { Cookie };
  const detail = await fetch(base + route, { headers }); assert.equal(detail.status, 200); assert.equal((await detail.json()).text, incomplete.text);
  const image = await fetch(base + route + '/image', { headers }); assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png'); assert.match(image.headers.get('cache-control'), /no-store/);
  assert((await image.arrayBuffer()).byteLength > 0);
  const summary = await (await fetch(base + `/api/sync/jobs/${job.id}?view=summary`, { headers })).json();
  assert(summary.items[0].visualReview); assert(!JSON.stringify(summary).includes(incomplete.text));
  const url = base + `/api/sync/jobs/${job.id}/resync`; const body = JSON.stringify({ itemId: item.id, feedback: '', visualReview: submit(item, 'accept') });
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })).status, 403);
  const stale = await fetch(url, { method: 'POST', headers: { ...headers, Origin: base, 'x-local-token': auth.token, 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: item.id, visualReview: { ...submit(item, 'accept'), revision: '0'.repeat(64) } }) });
  assert.equal(stale.status, 409);
});
