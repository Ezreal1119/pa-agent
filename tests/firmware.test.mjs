import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { FirmwareService } from '../dist/firmware/service.js';
import { LocalFirmwareClient, firmwareConfig, FIRMWARE_MAINTENANCE } from '../dist/firmware/client.js';
import { validateQuery, extractedQuery, matchesQuery } from '../dist/firmware/query.js';
import { createFirmwareTool } from '../dist/tools/firmware.js';
import { validateAgentSettings } from '../dist/web/agent-settings.js';

const name = 'SQ27M_EN_XX_WE__DS_FI_S02_U_251205_02_rel_uFWsign_VendorEN.zip';
const criteria = { model: 'SQ27M', date: '251205', index: '02' };
const searchResult = (candidates, extra = {}) => ({ candidates: candidates.slice(0, 12), total: candidates.length, truncated: candidates.length > 12, complete: true, matching: 'model_date_index_and', ...extra });
const base = 'https://temp.patrick-shenzhen.org/firmware/';
const candidate = (extra = {}) => ({ id: randomUUID().replaceAll('-', ''), filename: name, path: '/FTP7/OS/13.0/SQ27M/EN/XX/' + name, size: 1234567, modified: '20261028090000', score: 1, exact: true, differences: [], ...extra });
const owner = (userId = 'alice', botId = 'bot') => ({ userId, botId, target: userId, chatType: 'single' });
const input = (text = '', command = true, user = owner()) => ({ ...user, text, command, msgid: randomUUID() });
const until = async predicate => { const end = Date.now() + 5000; while (!await predicate()) { if (Date.now() > end) throw new Error('wait timeout'); await new Promise(r => setTimeout(r, 5)); } };

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-flow-'));
  let now = Date.now(), enabled = true, ready = true, submits = 0;
  const candidates = options.candidates ?? [candidate()], jobs = new Map();
  const client = {
    async ready() { return ready; }, async search(query) { return searchResult(candidates, options.result); },
    async submit(id, requestId) { submits++; if (jobs.has(requestId)) return jobs.get(requestId); const c = candidates.find(c => c.id === id); const job = { id: randomUUID().replaceAll('-', ''), candidate: c, state: 'running', stage: 'downloading', bytes: 1, total_bytes: c.size }; jobs.set(requestId, job); if (options.loseSubmit && submits === 1) throw new Error('response lost'); return job; },
    async lookup(requestId) { if (!ready) throw new Error('offline'); return jobs.get(requestId); },
    async job(id) { if (!ready) throw new Error('offline'); const job = [...jobs.values()].find(j => j.id === id); if (!job) throw new Error('unknown job'); return job; },
    async cancel(id) { const job = [...jobs.values()].find(j => j.id === id); job.state = 'cancelled'; return job; },
  };
  const create = () => new FirmwareService({ dataDir, client, extractor: options.extractor ?? (async () => criteria), enabled: () => enabled, now: () => now, pollMs: 3600000, publicBase: base });
  let service = create(); await service.start();
  const state = () => fs.readFile(path.join(dataDir, 'firmware/state.json'), 'utf8').then(JSON.parse);
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { get service() { return service; }, client, candidates, jobs, state, get submits() { return submits; }, set enabled(x) { enabled = x; }, set ready(x) { ready = x; }, advance(ms) { now += ms; }, async restart() { await service.close(); service = create(); await service.start(); }, async query(text = name, who = owner()) { await service.command(input(text, true, who)); await until(async () => ['choose', 'confirm'].includes((await state()).active?.phase)); return (await state()).active; }, async confirm(flow, who = owner()) { const result = await service.command(input(`确认 ${flow.code}`, false, who)); await service.tick(); await until(async () => (await state()).active?.jobId); return result; } };
}

test('firmware requires command, real candidate and owner confirmation, then returns only verified upload URL', async t => {
  const f = await fixture(t);
  assert.match((await f.service.command(input(name, false))).text, /重新发送 \/firmware/);
  assert.equal((await f.state()).active, undefined);
  const flow = await f.query(); assert.equal(f.submits, 0);
  assert.match((await f.service.command(input('确认 WRONG', false))).text, /尚未开始/);
  assert.equal(f.submits, 0);
  assert.match((await f.service.command(input(`确认 ${flow.code}`, false, owner('bob')))).text, /任务处理中/);
  await f.confirm(flow); assert.equal(f.submits, 1);
  const job = [...f.jobs.values()][0]; job.state = 'succeeded'; job.result = { uploaded: true, filename: name, size: f.candidates[0].size, download_url: base + name };
  await f.service.tick();
  const db = await f.state(); assert.equal(db.active, undefined);
  assert.match(db.notices.at(-1).text, /下载并上传完成/); assert.ok(db.notices.at(-1).text.includes(base + name));
});

test('global slot covers input, matching and confirmation across bots; idle input expires', async t => {
  const f = await fixture(t); const open = await f.service.command(input()); assert.equal(open.awaiting, true);
  assert.match((await f.service.command(input('', true, owner('alice', 'other-bot')))).text, /任务处理中/);
  f.advance(5 * 60000 + 1); await f.service.tick(); assert.equal((await f.state()).active, undefined);
  assert.equal((await f.service.command(input('', true, owner('bob')))).awaiting, true);
});

test('disabled or offline sends maintenance and does not acquire slot or start a job', async t => {
  const f = await fixture(t); f.enabled = false;
  assert.equal((await f.service.command(input(name))).text, FIRMWARE_MAINTENANCE);
  f.enabled = true; f.ready = false;
  assert.equal((await f.service.command(input(name))).text, FIRMWARE_MAINTENANCE);
  assert.equal((await f.state()).active, undefined); assert.equal(f.submits, 0);
});

test('switch off after preview prevents confirmation; switch off after accepted job continues tracking', async t => {
  const f = await fixture(t); const flow = await f.query(); f.enabled = false;
  assert.equal((await f.service.command(input(`确认 ${flow.code}`, false))).text, FIRMWARE_MAINTENANCE); assert.equal(f.submits, 0);
  f.enabled = true; await f.confirm(flow); f.enabled = false; f.advance(60000); await f.service.tick();
  assert.match((await f.state()).notices.at(-1).text, /从 FTP 下载/); assert.equal((await f.state()).active.jobId, [...f.jobs.values()][0].id);
});

test('lost submit response reconciles by idempotency key, including service restart', async t => {
  const f = await fixture(t, { loseSubmit: true }); const flow = await f.query();
  await f.service.command(input(`确认 ${flow.code}`, false)); await f.service.tick();
  await until(() => f.submits === 1); await until(async () => (await f.state()).active.offline);
  await f.restart(); await f.service.tick();
  await until(async () => (await f.state()).active?.jobId);
  assert.equal(f.submits, 1); assert.equal(f.jobs.size, 1);
});

test('offline active job retains global slot and resumes the same job', async t => {
  const f = await fixture(t); await f.confirm(await f.query()); const id = (await f.state()).active.jobId;
  f.ready = false; await f.service.tick(); assert.equal((await f.state()).active.jobId, id);
  f.ready = true; await f.service.tick();
  assert.match((await f.state()).notices.at(-1).text, /服务已恢复/); assert.equal(f.submits, 1);
  assert.match((await f.service.command(input(name, true, owner('bob')))).text, /任务处理中/);
});

test('fixed progress milestones include both download and upload without duplicates or catch-up spam', async t => {
  const f = await fixture(t); await f.confirm(await f.query()); const job = [...f.jobs.values()][0];
  for (const minute of [1, 2, 3, 5, 7, 10, 15, 20, 30]) {
    const db = await f.state(); const elapsed = db.active.notified.at(-1) ?? 0; f.advance((minute - elapsed) * 60000);
    if (minute >= 7) job.stage = 'uploading';
    await f.service.tick();
  }
  const before = (await f.state()).notices.filter(n => n.text.includes('当前阶段进度')).length;
  await f.service.tick(); assert.equal((await f.state()).notices.filter(n => n.text.includes('当前阶段进度')).length, before);
  assert.equal(before, 9);
  assert.ok((await f.state()).notices.some(n => n.text.includes('上传到 R2')));
  await f.restart(); await f.service.tick(); assert.equal((await f.state()).notices.filter(n => n.text.includes('当前阶段进度')).length, before);
  f.advance(10 * 60000); await f.service.tick(); assert.equal((await f.state()).notices.filter(n => n.text.includes('当前阶段进度')).length, before + 1);
});

test('multiple matches terminate even when a complete filename is exact; the slot is released', async t => {
  const c1 = candidate(), c2 = candidate({ filename: name.replace('VendorEN', 'VendorXX'), path: '/FTP7/OS/13.0/SQ27M/EN/XX/' + name.replace('VendorEN', 'VendorXX') });
  const f = await fixture(t, { candidates: [c1, c2] });
  await f.service.command(input(name)); await until(async () => (await f.state()).notices.length);
  const db = await f.state(); assert.equal(db.active, undefined); assert.equal(f.submits, 0);
  assert.match(db.notices.at(-1).text, /找到 2 个/); assert.ok(db.notices.at(-1).text.includes(c1.filename)); assert.ok(db.notices.at(-1).text.includes(c2.filename));
  assert.equal((await f.service.command(input('', true, owner('bob')))).awaiting, true);
});

test('no matches and incomplete directory enumeration end without a download', async t => {
  for (const options of [{ candidates: [] }, { result: { complete: false } }]) {
    const f = await fixture(t, options); await f.service.command(input(name)); await until(async () => (await f.state()).notices.length);
    const db = await f.state(); assert.equal(db.active, undefined); assert.equal(f.submits, 0); assert.match(db.notices.at(-1).text, /任务已结束/);
  }
});

test('natural language is passed intact to extraction before structured FTP search', async t => {
  const text = '帮我下载“SQ27M的251205_02”的固件'; let seen;
  const f = await fixture(t, { extractor: async request => { seen = request; return criteria; } });
  let searched; const search = f.client.search; f.client.search = async query => { searched = query; return search(query); };
  const flow = await f.query(text); assert.equal(seen, text); assert.deepEqual(searched, criteria); assert.equal(flow.phase, 'confirm'); assert.equal(f.submits, 0);
});

test('missing or invented extraction conditions end before FTP access', async t => {
  for (const extracted of [null, { ...criteria, model: 'SQ68MB' }, { ...criteria, date: '251206' }, { ...criteria, index: '01' }]) {
    const f = await fixture(t, { extractor: async () => extracted }); let searches = 0;
    f.client.search = async () => { searches++; throw new Error('should not search'); };
    await f.service.command(input(name)); await until(async () => (await f.state()).notices.length);
    assert.equal((await f.state()).active, undefined); assert.equal(f.submits, 0); assert.equal(searches, 0);
  }
});

test('replayed WeCom message is idempotent and cannot be replayed by another identity', async t => {
  const f = await fixture(t); const cmd = input('');
  const [a, b] = await Promise.all([f.service.command(cmd), f.service.command(cmd)]); assert.equal(a.flowId, b.flowId);
  await assert.rejects(f.service.command({ ...cmd, ...owner('bob') }), /identity mismatch/);
});

test('invalid structured extraction cannot create transfers', async t => {
  const f = await fixture(t, { extractor: async () => ({ model: '../SQ27M', date: '251205', index: '02' }) }); await f.service.command(input(name));
  await until(async () => (await f.state()).notices.length); assert.equal((await f.state()).active, undefined); assert.equal(f.submits, 0);
});

test('mismatched success URL or package retains lock and emits a single warning, never a link', async t => {
  const f = await fixture(t); await f.confirm(await f.query()); const job = [...f.jobs.values()][0]; job.state = 'succeeded'; job.result = { uploaded: true, filename: name, size: job.candidate.size, download_url: 'https://evil.invalid/a.zip' };
  await f.service.tick(); await f.service.tick();
  const db = await f.state(); assert.ok(db.active); assert.equal(db.notices.filter(n => n.text.includes('结果校验')).length, 1); assert.ok(!JSON.stringify(db.notices).includes('evil.invalid'));
});

test('verified public link encoding agrees with the local service for parentheses and spaces', async t => {
  const filename = name.replace('.zip', '(EU 1).zip'); const c = candidate({ filename, path: '/FTP7/OS/13.0/SQ27M/EN/XX/' + filename });
  const f = await fixture(t, { candidates: [c] }); await f.confirm(await f.query(filename)); const job = [...f.jobs.values()][0];
  const url = base + encodeURIComponent(filename).replace(/[!'()*]/g, x => '%' + x.charCodeAt(0).toString(16).toUpperCase());
  job.state = 'succeeded'; job.result = { uploaded: true, filename, size: c.size, download_url: url };
  await f.service.tick(); const db = await f.state(); assert.equal(db.active, undefined); assert.ok(db.notices.at(-1).text.includes(url));
});

test('owner cancels running task and global slot is released only after confirmed cancellation', async t => {
  const f = await fixture(t); await f.confirm(await f.query());
  await f.service.command(input('取消')); await f.service.tick(); await until(async () => !(await f.state()).active);
  assert.match((await f.state()).notices.at(-1).text, /已取消/); assert.equal([...f.jobs.values()][0].state, 'cancelled');
});

test('durable notification leases bind claims; acknowledged items do not reappear', async t => {
  const f = await fixture(t); await f.query(); const consumer = randomUUID();
  assert.equal((await f.service.claim({ botIds: ['wrong'], consumer })).notice, null);
  const claim = await f.service.claim({ botIds: ['bot'], consumer }); assert.ok(claim.notice);
  assert.equal((await f.service.claim({ botIds: ['bot'], consumer: randomUUID() })).notice, null);
  assert.equal((await f.service.ack({ id: claim.notice.id, claim: 'wrong' })).ok, false);
  await f.restart(); assert.equal((await f.service.ack({ id: claim.notice.id, claim: claim.notice.claim })).ok, true);
  assert.equal((await f.service.claim({ botIds: ['bot'], consumer })).notice, null);
});

test('firmware tool cannot execute outside trusted command matching, and settings validate independent switch', async () => {
  const tool = createFirmwareTool(); const reply = await tool.execute('id', { candidate_ids: [], reason: 'try upload' });
  assert.match(JSON.stringify(reply), /requires_command/);
  assert.throws(() => validateAgentSettings({ effort: 'low', firmware: { enabled: true, token: 'bad' } }));
  assert.throws(() => firmwareConfig({ FIRMWARE_SERVICE_URL: 'http://evil.invalid' }));
  assert.throws(() => firmwareConfig({ FIRMWARE_SERVICE_URL: 'https://user:pass@example.com' }));
});

test('local client preserves auth, short requests and upload=true, validates data and bounds error disclosure', async () => {
  const c = candidate(), calls = [], job = { id: 'a'.repeat(32), candidate: c, state: 'running', stage: 'downloading', bytes: 0, total_bytes: c.size };
  const config = firmwareConfig({ FIRMWARE_SERVICE_URL: 'https://service.example/firmware-api', FIRMWARE_SERVICE_TOKEN: 'secret'.repeat(8) });
  const client = new LocalFirmwareClient(config, async (url, init) => { calls.push({ url, init }); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer ' + config.token); if (url.endsWith('/health')) return Response.json({ ok: true }); if (url.endsWith('/search')) return Response.json(searchResult([c])); return Response.json(job); });
  assert.equal(await client.ready(), true); assert.equal((await client.search(criteria)).candidates[0].filename, name);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { criteria, limit: 12 });
  await client.submit(c.id, 'firmware:one'); assert.equal(JSON.parse(calls.at(-1).init.body).upload, true);
  const bad = new LocalFirmwareClient(config, async () => new Response('private secret credentials', { status: 503 }));
  assert.equal(await bad.ready(), false); await assert.rejects(bad.search(criteria), e => !e.message.includes('secret'));
  await assert.rejects(client.job('../shutdown'), /Invalid/);
});

test('query validation requires calendar dates and exact model/date-index boundaries', () => {
  assert.deepEqual(validateQuery({ ...criteria, model: 'sq27m' }), criteria);
  for (const q of [{ ...criteria, date: '250230' }, { ...criteria, index: '2' }, { ...criteria, model: 'SQ27M/' }]) assert.throws(() => validateQuery(q));
  assert.equal(matchesQuery(name, criteria), true);
  assert.equal(matchesQuery(name.replace('SQ27M_', 'SQ27MB_'), criteria), false);
  assert.equal(matchesQuery(name.replace('_251205_02_', '_251205_01_'), criteria), false);
  assert.throws(() => extractedQuery({ ...criteria, index: '01' }, name));
  assert.equal(extractedQuery({ model: 'SQ27M', date: null, index: '02' }, name), null);
});

test('old unconfirmed flows end on upgrade; accepted running jobs keep their identity', async t => {
  const f = await fixture(t); await f.query();
  const file = path.join(f.service.directory, 'state.json');
  const old = await f.state(); delete old.active.matchVersion; await fs.writeFile(file, JSON.stringify(old));
  await f.restart(); assert.equal((await f.state()).active, undefined); assert.match((await f.state()).notices.at(-1).text, /规则已更新/);
  await f.confirm(await f.query()); const running = await f.state(), id = running.active.jobId;
  delete running.active.matchVersion; await fs.writeFile(file, JSON.stringify(running));
  await f.restart(); await f.service.tick(); assert.equal((await f.state()).active.jobId, id); assert.equal(f.submits, 1);
});

test('local client rejects legacy, hidden ambiguity and wrong-condition results', async () => {
  const config = firmwareConfig({ FIRMWARE_SERVICE_URL: 'https://service.example/firmware-api', FIRMWARE_SERVICE_TOKEN: 'secret'.repeat(8) });
  for (const value of [{ candidates: [candidate()] }, searchResult([candidate()], { total: 2 }), searchResult([candidate({ filename: name.replace('SQ27M_', 'SQ27MB_'), path: '/FTP7/OS/13.0/SQ27MB/EN/XX/' + name.replace('SQ27M_', 'SQ27MB_') })])]) {
    const client = new LocalFirmwareClient(config, async () => Response.json(value));
    await assert.rejects(client.search(criteria));
  }
});
