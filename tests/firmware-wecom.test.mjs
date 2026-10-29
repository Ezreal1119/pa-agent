import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWebServer } from '../dist/web/server.js';
import { createFirmwareExtractor } from '../dist/firmware/matcher.js';
import { AgentApi } from '../integrations/wecom-bridge/api.mjs';
import { BridgeStore } from '../integrations/wecom-bridge/store.mjs';
import { WecomBridge } from '../integrations/wecom-bridge/bridge.mjs';
import { FirmwareNotifier } from '../integrations/wecom-bridge/firmware-notifications.mjs';
import { commandInput } from '../integrations/wecom-bridge/commands.mjs';
import { bridgeConfig } from '../integrations/wecom-bridge/config.mjs';

const filename = 'SQ27M_EN_XX_WE__DS_FI_S02_U_251205_02_rel_uFWsign_VendorEN.zip';
const criteria = { model: 'SQ27M', date: '251205', index: '02' };
const searchResult = candidates => ({ candidates, total: candidates.length, truncated: false, complete: true, matching: 'model_date_index_and' });
const candidate = { id: 'b'.repeat(32), filename, path: '/FTP7/OS/13.0/SQ27M/EN/XX/' + filename, size: 1234567, modified: '20261028100000', score: 1, exact: true, differences: [] };
const message = (text, userId = 'alice', chat) => ({ headers: { req_id: randomUUID() }, body: { msgtype: 'text', msgid: randomUUID(), chattype: chat ? 'group' : 'single', ...(chat ? { chatid: chat } : {}), from: { userid: userId }, text: { content: text } } });
const until = async fn => { const end = Date.now() + 6000; while (!await fn()) { if (Date.now() > end) throw new Error('wait timeout'); await new Promise(r => setTimeout(r, 10)); } };
const client = () => ({ texts: [], async replyStream(frame, id, text, finish) { if (finish) this.texts.push(text); }, async sendMessage(target, value) { this.texts.push(value.markdown.content); }, disconnect() {} });

test('real Web API + Bridge enforces /firmware entry, switch, ownership, confirmation, notices and final link', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-wecom-')); const token = 'bridge-test-token-'.repeat(4);
  let ready = true, submissions = 0; let job;
  const local = { async ready() { return ready; }, async search() { return searchResult([candidate]); }, async lookup() { return job; }, async submit() { submissions++; job = { id: 'c'.repeat(32), candidate, state: 'running', stage: 'downloading', bytes: 100, total_bytes: candidate.size }; return job; }, async job() { return job; }, async cancel() { job.state = 'cancelled'; return job; } };
  const app = await createWebServer({ cwd: root, dataDir: path.join(root, '.data'), resourcesDir: path.resolve('resources'), admin: { account: 'admin', password: 'test-passphrase' }, bridgeToken: token, model: { apiKey: '', baseUrl: '', modelId: '' }, fileTools: { enabled: false }, firmware: { client: local, extractor: async () => criteria, pollMs: 10 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const base = `http://127.0.0.1:${app.server.address().port}`; const api = new AgentApi(base, token, 5000);
  const auth = await (await fetch(base + '/api/auth/status')).json();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': auth.token }, body: JSON.stringify({ account: 'admin', password: 'test-passphrase' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Local-Token': auth.token, 'Content-Type': 'application/json' };
  const store = await new BridgeStore(path.join(root, 'bridge')).open(); const bot = client();
  const bridge = new WecomBridge({ config: { bots: [{ botId: 'bot', secret: 'fake' }], token, concurrency: 2, queueLimit: 5, timeoutMs: 5000 }, store, api, clients: new Map([['bot', bot]]), log: { warn() {}, error() {} } });
  t.after(async () => { await bridge.close(); await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start(); bridge.authenticated('bot');
  const toggle = async enabled => { const current = await (await fetch(base + '/api/agent-settings', { headers })).json(); const response = await fetch(base + '/api/agent-settings', { method: 'PUT', headers, body: JSON.stringify({ ...current.settings, firmware: { enabled } }) }); assert.equal(response.status, 200); return response.json(); };
  await bridge.receive('bot', message('/firmware')); await bridge.idle(); assert.match(bot.texts.at(-1), /维护中/); assert.equal(submissions, 0);
  await toggle(true); ready = false; await bridge.receive('bot', message('/firmware')); await bridge.idle(); assert.match(bot.texts.at(-1), /维护中/);
  ready = true; await bridge.receive('bot', message('/firmware')); await bridge.idle(); assert.match(bot.texts.at(-1), /请输入 OS/);
  await bridge.receive('bot', message('/firmware', 'bob')); await bridge.idle(); assert.match(bot.texts.at(-1), /任务处理中/);
  await bridge.receive('bot', message(filename)); await bridge.idle(); assert.match(bot.texts.at(-1), /AI 提取/); assert.equal(submissions, 0);
  const stateFile = path.join(root, '.data/firmware/state.json'); const state = () => fs.readFile(stateFile, 'utf8').then(JSON.parse);
  await until(async () => (await state()).active?.phase === 'confirm'); await bridge.firmwareNotifier.active; await bridge.firmwareNotifier.pump();
  assert.ok(bot.texts.some(text => text.includes('是否下载并上传')));
  const code = (await state()).active.code;
  await bridge.receive('bot', message(`确认 ${code}`, 'bob')); await bridge.idle(); assert.equal(submissions, 0);
  await bridge.receive('bot', message(`确认 ${code}`)); await bridge.idle(); await until(() => submissions === 1);
  await toggle(false); job.stage = 'uploading'; job.state = 'succeeded'; job.result = { uploaded: true, filename, size: candidate.size, download_url: 'https://temp.patrick-shenzhen.org/firmware/' + filename };
  await until(async () => !(await state()).active); await bridge.firmwareNotifier.active; await bridge.firmwareNotifier.pump();
  assert.ok(bot.texts.some(text => text.includes(job.result.download_url)));
  assert.equal(submissions, 1);
  await bridge.receive('bot', message('/firmware')); await bridge.idle(); assert.match(bot.texts.at(-1), /维护中/);
  const unauthorized = await fetch(base + '/api/wecom/firmware/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(unauthorized.status, 401);
});

test('SDK extracts structured conditions with a single constrained tool before FTP search', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-model-')); let calls = 0, assertion;
  const model = createServer(async (req, res) => {
    try {
      const parts = []; for await (const c of req) parts.push(c); const body = JSON.parse(Buffer.concat(parts)); calls++;
      assert.deepEqual(body.tools.map(x => x.function.name), ['extract_firmware_query']); assert.ok(JSON.stringify(body.messages).includes('帮我下载'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', model: 'fixture', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: 'assistant' }); chunk({ tool_calls: [{ index: 0, id: 'match-call', type: 'function', function: { name: 'extract_firmware_query', arguments: JSON.stringify(criteria) } }] }); chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    } catch (error) { assertion = error; res.writeHead(500); res.end('fixture assertion failed'); }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { model.closeAllConnections(); await new Promise(r => model.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const extractor = createFirmwareExtractor(() => ({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, modelId: 'fixture', contextWindow: 32000, maxTokens: 4096 }), root);
  assert.deepEqual(await extractor('帮我下载 SQ27M 的 251205_02 固件', AbortSignal.timeout(5000)), criteria); if (assertion) throw assertion; assert.equal(calls, 1);
});

test('notification delivery checkpoint survives ACK failure and restart without repeating acknowledged text', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-notice-')); const store = await new BridgeStore(root).open(); const bot = client();
  const notice = { id: randomUUID(), flowId: 'd'.repeat(32), claim: randomUUID(), botId: 'bot', chatType: 'single', userId: 'alice', target: 'alice', text: '上传完成，测试链接', created: Date.now() };
  let failAck = true, acked = false;
  const api = { async json(route) { if (route.endsWith('/claim')) return { notice: acked ? null : notice }; if (failAck) throw new Error('ACK response lost'); acked = true; return { ok: true }; } };
  const make = () => new FirmwareNotifier({ store, api, clients: new Map([['bot', bot]]), isConnected: () => true, scope: () => ({}), log: { warn() {} } });
  let notifier = make().start(); t.after(async () => { await notifier.close(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await notifier.active; assert.equal(bot.texts.length, 1); await notifier.close(); failAck = false; notifier = make().start(); await notifier.active;
  assert.equal(bot.texts.length, 1); assert.equal(acked, true);
});

test('command parsing requires exact firmware command and never treats attachments or another group member as confirmation', () => {
  assert.equal(commandInput(message('/firmwareish').body, {}, 'alice'), undefined);
  assert.equal(commandInput(message('/firmware ' + filename).body, {}, 'alice').kind, 'firmware');
  const scope = { firmwareUser: 'alice', firmwareUntil: Date.now() + 60000 };
  assert.equal(commandInput(message('确认 ABCDEF', 'bob', 'g').body, scope, 'bob'), undefined);
  assert.equal(commandInput(message('确认 ABCDEF', 'alice', 'g').body, scope, 'alice').command, false);
  const quoted = message('/firmware'); quoted.body.quote = { text: { content: 'untrusted' } }; assert.equal(commandInput(quoted.body, {}, 'alice').kind, 'notice');
});

test('group firmware strips only exact bot mentions at input edges, including screenshot examples', () => {
  const parse = (text, scope = {}, name) => commandInput(message(text, 'alice', 'g').body, scope, 'alice', name);
  for (const text of ['/firmware @AI Patrick', '@AI Patrick /firmware', '@AI Patrick\u2005/firmware\u2005@AI Patrick']) {
    assert.deepEqual(parse(text), { kind: 'firmware', command: true, text: '' });
  }
  const scope = { firmwareUser: 'alice', firmwareUntil: Date.now() + 60000 };
  const screenshot = 'SQ68MB_EN_XX_WE__DS_FI_S01_U_260422_01_rel_uFWsign_VendorEN';
  for (const text of [screenshot, '选择 1', '确认 ABCDEF', '取消', '状态']) {
    assert.deepEqual(parse(`${text} @AI Patrick`, scope), { kind: 'firmware', command: false, text });
    assert.deepEqual(parse(`@AI Patrick ${text}`, scope), { kind: 'firmware', command: false, text });
  }
  assert.deepEqual(parse(`/firmware ${screenshot} @AI Patrick`), { kind: 'firmware', command: true, text: screenshot });
  assert.deepEqual(parse('@固件助手 (EN)+ /firmware', {}, '固件助手 (EN)+'), { kind: 'firmware', command: true, text: '' });
  assert.equal(parse('确认 ABCDEF @其他人 @AI Patrick', scope).text, '确认 ABCDEF @其他人');
  assert.equal(parse('确认 ABCDEF @AI Patrick Jr', scope).text, '确认 ABCDEF @AI Patrick Jr');
  assert.equal(parse('确认 ABCDEF x@AI Patrick', scope).text, '确认 ABCDEF x@AI Patrick');
  assert.equal(parse('确认 @AI Patrick ABCDEF', scope).text, '确认 @AI Patrick ABCDEF');
  assert.equal(parse('@其他人 /firmware'), undefined);
  assert.equal(parse('@AI Patrick /firmware', {}, 'Other Bot'), undefined);
  assert.equal(parse('@AI Patrick /firmwareish'), undefined);
  assert.equal(parse('普通问题 @AI Patrick'), undefined);
  assert.equal(parse('@AI Patrick /role'), undefined, 'other commands keep their existing parsing');
  assert.equal(commandInput(message('/firmware @AI Patrick').body, {}, 'alice').text, '@AI Patrick', 'private text is unchanged');
  assert.equal(commandInput(message('确认 ABCDEF @AI Patrick', 'bob', 'g').body, scope, 'bob'), undefined);
});

test('group mentions do not bypass firmware plain-text, quote or length boundaries', () => {
  const scope = { firmwareUser: 'alice', firmwareUntil: Date.now() + 60000 };
  for (const text of ['@AI Patrick\n/firmware', '/firmware\n@AI Patrick', '@AI Patrick /firmware\0']) {
    assert.equal(commandInput(message(text, 'alice', 'g').body, scope, 'alice').kind, 'notice');
  }
  for (const text of ['确认 ABCDEF\n@AI Patrick', '@AI Patrick', '确认 ABCDEF @AI Patrick' + ' '.repeat(501)]) {
    assert.equal(commandInput(message(text, 'alice', 'g').body, scope, 'alice').kind, 'notice');
  }
  const quoted = message('@AI Patrick /firmware', 'alice', 'g').body; quoted.quote = { msgtype: 'text', text: { content: filename } };
  assert.equal(commandInput(quoted, scope, 'alice').kind, 'notice');
  const mixed = message('', 'alice', 'g').body; mixed.msgtype = 'mixed'; mixed.mixed = { msg_item: [{ msgtype: 'text', text: { content: '/firmware @AI Patrick' } }] };
  assert.equal(commandInput(mixed, scope, 'alice').kind, 'notice');
});

test('bot mention display names default compatibly and are isolated per configured bot', () => {
  const env = { WECOM_ENABLED: 'true', WECOM_BOT_ID: 'bot', WECOM_BOT_SECRET: 'test' };
  assert.equal(bridgeConfig(env, '/tmp').bots[0].name, 'AI Patrick');
  assert.equal(bridgeConfig({ ...env, WECOM_BOT_NAME: '助手 (EN)+' }, '/tmp').bots[0].name, '助手 (EN)+');
  const bots = bridgeConfig({ ...env, WECOM_BOTS: JSON.stringify([{ botId: 'one', secret: 's', name: 'One Bot' }, { botId: 'two', secret: 't', name: 'Two Bot' }]) }, '/tmp').bots;
  assert.deepEqual(bots.map(bot => bot.name), ['One Bot', 'Two Bot']);
  for (const name of ['', ' ', '@Bot', 'Bot\nName', 'x'.repeat(81), 3]) assert.throws(() => bridgeConfig({ ...env, WECOM_BOT_NAME: name }, '/tmp'), /显示名/);
});

test('group Web + Bridge flow handles natural requests, mentions, owner confirmation and running cancellation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-group-'));
  const token = 'group-test-token-'.repeat(4);
  const alternate = { ...candidate, id: 'e'.repeat(32), filename: filename.replace('VendorEN', 'VendorXX'), path: candidate.path.replace('VendorEN', 'VendorXX') };
  let job, submissions = 0, cancellations = 0, searched;
  const local = { async ready() { return true; }, async search(query) { searched = query; return searchResult([alternate]); }, async lookup() { return job; }, async submit(id) { submissions++; assert.equal(id, alternate.id); job = { id: 'c'.repeat(32), candidate: alternate, state: 'running', stage: 'downloading', bytes: 100, total_bytes: candidate.size }; return job; }, async job() { return job; }, async cancel() { cancellations++; job.state = 'cancelled'; return job; } };
  const app = await createWebServer({ cwd: root, dataDir: path.join(root, '.data'), resourcesDir: path.resolve('resources'), admin: { account: 'admin', password: 'test-passphrase' }, bridgeToken: token, model: { apiKey: '', baseUrl: '', modelId: '' }, fileTools: { enabled: false }, firmware: { client: local, extractor: async () => criteria, pollMs: 10 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = await (await fetch(base + '/api/auth/status')).json();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': auth.token }, body: JSON.stringify({ account: 'admin', password: 'test-passphrase' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Local-Token': auth.token, 'Content-Type': 'application/json' };
  const settings = (await (await fetch(base + '/api/agent-settings', { headers })).json()).settings;
  assert.equal((await fetch(base + '/api/agent-settings', { method: 'PUT', headers, body: JSON.stringify({ ...settings, firmware: { enabled: true } }) })).status, 200);
  const store = await new BridgeStore(path.join(root, 'bridge')).open(); const bot = client(), targets = [];
  const sendMessage = bot.sendMessage.bind(bot); bot.sendMessage = async (target, value) => { targets.push(target); await sendMessage(target, value); };
  const bridge = new WecomBridge({ config: { bots: [{ botId: 'bot', secret: 'fake', name: 'AI Patrick' }, { botId: 'custom', secret: 'fake', name: '固件助手 (EN)+' }], token, concurrency: 2, queueLimit: 5, timeoutMs: 5000 }, store, api: new AgentApi(base, token, 5000), clients: new Map([['bot', bot], ['custom', bot]]), log: { warn() {}, error() {} } });
  t.after(async () => { await bridge.close(); await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start(); bridge.authenticated('bot'); bridge.authenticated('custom');
  const state = () => fs.readFile(path.join(root, '.data/firmware/state.json'), 'utf8').then(JSON.parse);
  const send = async (text, user = 'alice', chat = 'g', botId = 'bot') => { await bridge.receive(botId, message(text, user, chat)); await bridge.idle(); };
  await send('/firmware @AI Patrick'); assert.match(bot.texts.at(-1), /请输入 OS/);
  await send('帮我下载 SQ27M 的 251205_02 固件 @AI Patrick'); await until(async () => (await state()).active?.phase === 'confirm');
  assert.deepEqual(searched, criteria); assert.equal(submissions, 0);
  await bridge.firmwareNotifier.pump();
  const code = (await state()).active.code; assert.ok(code);
  await send(`/firmware 确认 ${code} @AI Patrick`, 'bob'); assert.match(bot.texts.at(-1), /任务处理中/); assert.equal(submissions, 0);
  await send(`/firmware 确认 ${code} @AI Patrick`, 'alice', 'other-group'); assert.match(bot.texts.at(-1), /任务处理中/); assert.equal(submissions, 0);
  await send(`确认 ${code} @其他人 @AI Patrick`); assert.match(bot.texts.at(-1), /尚未开始/); assert.equal(submissions, 0);
  await send(`确认 ${code} @AI Patrick`); await until(() => submissions === 1);
  await send('@AI Patrick /firmware 状态'); assert.match(bot.texts.at(-1), /下载/);
  await send('/firmware 取消 @AI Patrick'); await until(async () => !(await state()).active);
  assert.equal(cancellations, 1); assert.equal(submissions, 1);
  await bridge.firmwareNotifier.pump(); assert.ok(targets.length); assert.ok(targets.every(target => target === 'g'));
  await send('@AI Patrick /firmware'); await send('取消 @AI Patrick'); assert.equal(bot.texts.at(-1), '已取消固件流程。');
  await send('@固件助手 (EN)+ /firmware', 'alice', 'g', 'custom'); assert.match(bot.texts.at(-1), /请输入 OS/);
  await send('取消 @固件助手 (EN)+', 'alice', 'g', 'custom'); assert.equal(bot.texts.at(-1), '已取消固件流程。');
});

test('terminal notice exits only its matching input mode so ordinary chat is not swallowed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-input-exit-')); const store = await new BridgeStore(root).open(); const bot = client();
  const flowId = 'e'.repeat(32), scope = { firmwareUser: 'alice', firmwareFlow: flowId, firmwareUntil: Date.now() + 60000 };
  const notice = { id: randomUUID(), claim: randomUUID(), flowId, botId: 'bot', chatType: 'single', userId: 'alice', target: 'alice', text: '固件查询暂时不可用，请重新发送 /firmware。' };
  let acked = false;
  const api = { async json(route) { if (route.endsWith('/claim')) return { notice: acked ? null : notice }; acked = true; return { ok: true }; } };
  const notifier = new FirmwareNotifier({ store, api, clients: new Map([['bot', bot]]), isConnected: () => true, scope: () => scope, log: { warn() {} } }).start();
  t.after(async () => { await notifier.close(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await notifier.active; assert.equal(scope.firmwareUser, undefined);
  assert.equal(commandInput(message('现在查询产品规格').body, scope, 'alice'), undefined);
});
