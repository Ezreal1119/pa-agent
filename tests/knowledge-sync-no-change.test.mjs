import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPlan } from '../dist/knowledge-sync/validation.js';
import { SyncService } from '../dist/knowledge-sync/service.js';
import { catalog, hash, emptyUsage } from '../dist/knowledge-sync/core.js';
import { formatSyncSummary } from '../dist/sync-notifications/service.js';

const source = 'RFG91/accessories/guide_202611041234/guide.md';
const text = '# Accessories\nCable: USB Type-C.\n';
const feedback = '重复资料，不替换现有附件指南，保留当前版本。';
const base = new Map([[source, text], ['product-knowledge-vault/products/RFG91.md', `# RFG91\n${source}`]]);
const decision = (overrides = {}) => ({ action: 'no_change', existingSource: source,
  noChangeEvidence: { existingHash: hash(text), administratorInstruction: feedback },
  reason: '已比较全文；管理员要求保留现有指南。', summary: '附件指南无需更新，保留当前版本。',
  products: ['RFG91'], slot: 'accessories', oldPaths: [], reviewedPaths: [source],
  versionEvidence: 'No business differences', authorizedException: false, ...overrides });

test('no-change requires current administrator evidence, a current source, and zero changes', () => {
  assert.equal(buildPlan(base, new Map(), decision(), text, feedback).changes.length, 0);
  for (const [d, staged, answer, deletion, association, wecom] of [
    [decision(), new Map(), ''],
    [decision(), new Map(), '请更新'],
    [decision({ noChangeEvidence: { existingHash: '0'.repeat(64), administratorInstruction: feedback } }), new Map(), feedback],
    [decision({ existingSource: 'product-knowledge-vault/products/RFG91.md' }), new Map(), feedback],
    [decision({ existingSource: 'RFG91/accessories/missing/source.md' }), new Map(), feedback],
    [decision(), new Map([['product-knowledge-vault/products/RFG91.md', 'changed']]), feedback],
    [decision({ oldPaths: [source] }), new Map(), feedback],
    [decision({ newPath: 'RFG91/accessories/new/source.md' }), new Map(), feedback],
    [decision({ authorizedException: true }), new Map(), feedback],
    [decision(), new Map(), feedback, true],
    [decision(), new Map(), feedback, false, { path: source }],
    [decision(), new Map(), feedback, false, undefined, {}],
  ]) assert.throws(() => buildPlan(base, staged, d, text, answer, deletion, association, wecom));
});

test('semantic duplicate finishes without library changes and survives restart as unchanged', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-no-change-'));
  const options = { dataDir: root, maxBytes: 1024 * 1024, timeoutMs: 30000,
    modelId: () => 'fixture', redact: error => error.message,
    converter: () => async file => ({ markdown: '# Accessories\nUSB Type-C cable.\n',
      sourceHash: hash(await fs.readFile(file)), version: 5, coverage: ['Fixture'], visual: emptyUsage() }),
    planner: () => async input => ({ decision: input.feedback ? decision() : decision({ action: 'review', noChangeEvidence: undefined }), staged: new Map() }),
  };
  let service = new SyncService(options);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, value] of base) {
    const file = path.join(service.root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
  }
  await service.init();
  const before = await catalog(service.root);
  const uploaded = await service.upload('repeat.txt', (async function* () { yield Buffer.from('Different layout, same guide'); })());
  let job = await service.start([uploaded.id]); await service.waitFor(job.id); job = await service.get(job.id);
  assert.equal(job.items[0].status, 'needs_review');
  let prepared;
  const publish = service.publisher.publish.bind(service.publisher);
  service.publisher.publish = async (id, plan, signal) => {
    prepared = JSON.parse(await fs.readFile(path.join(service.directory, 'jobs', job.id + '.json'), 'utf8'));
    assert.equal(prepared.items[0].plan.decision.action, 'no_change', 'decision must be durable before committing');
    assert.equal(prepared.items[0].status, 'waiting_to_publish');
    return publish(id, plan, signal);
  };
  await service.resync(job.id, job.items[0].id, feedback); await service.waitFor(job.id); job = await service.get(job.id);
  assert.equal(job.items[0].status, 'unchanged', job.items[0].reason);
  assert.equal(job.items[0].sourceDeleted, true);
  assert.equal(job.items[0].plan.changes.length, 0);
  assert.deepEqual(await catalog(service.root), before);
  assert.equal((await service.incoming()).length, 0);
  await service.close();
  // Simulate a restart after transaction commit but before the final report save.
  await fs.writeFile(path.join(service.directory, 'jobs', job.id + '.json'), JSON.stringify(prepared));
  service = new SyncService(options); await service.init();
  job = await service.get(job.id);
  assert.equal(job.items[0].status, 'unchanged');
  assert.equal(job.items[0].stage, 'Completed · no changes');
  assert.match(job.items[0].cleanupError, /No-change completion recovered/);
  await service.cleanup(job.id, job.items[0].id);
  await assert.rejects(service.resync(job.id, job.items[0].id, feedback), /already committed/);
  assert.deepEqual(await catalog(service.root), before);
  const notice = formatSyncSummary({ origin: 'manual', status: 'completed', finished: new Date().toISOString(), total: 1,
    counts: { unchanged: 1 }, items: [{ name: 'repeat.txt', status: 'unchanged', summary: job.items[0].summary }] });
  assert.match(notice, /无需变更 1/); assert.match(notice, /已完成，无需变更/); assert.match(notice, /已入库 0/);
});

test('knowledge changing during a no-change plan preserves the input and blocks completion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-no-change-stale-'));
  let service;
  const options = { dataDir: root, maxBytes: 1024 * 1024, timeoutMs: 30000, modelId: () => 'fixture', redact: e => e.message,
    converter: () => async file => ({ markdown: text, sourceHash: hash(await fs.readFile(file)), version: 5, coverage: [], visual: emptyUsage() }),
    planner: () => async input => {
      if (!input.feedback) return { decision: decision({ action: 'review', noChangeEvidence: undefined }), staged: new Map() };
      await fs.writeFile(path.join(service.root, source), text + 'New version');
      return { decision: decision(), staged: new Map() };
    },
  };
  service = new SyncService(options);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(service.root, source); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  await service.init();
  const uploaded = await service.upload('repeat.txt', (async function* () { yield Buffer.from(text); })());
  const job = await service.start([uploaded.id]); await service.waitFor(job.id);
  const initial = await service.get(job.id);
  await service.resync(job.id, initial.items[0].id, feedback); await service.waitFor(job.id);
  const item = (await service.get(job.id)).items[0];
  assert.equal(item.status, 'failed'); assert.match(item.reason, /Knowledge changed/);
  assert.equal((await service.incoming()).length, 1);
});
