import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWebServer } from '../dist/web/server.js';
import { createFirmwareMatcher } from '../dist/firmware/matcher.js';
import { AgentApi } from '../integrations/wecom-bridge/api.mjs';
import { BridgeStore } from '../integrations/wecom-bridge/store.mjs';
import { WecomBridge } from '../integrations/wecom-bridge/bridge.mjs';
import { FirmwareNotifier } from '../integrations/wecom-bridge/firmware-notifications.mjs';
import { commandInput } from '../integrations/wecom-bridge/commands.mjs';

const filename = 'SQ27M_EN_XX_WE__DS_FI_S02_U_251205_02_rel_uFWsign_VendorEN.zip';
const candidate = { id: 'b'.repeat(32), filename, path: '/FTP7/OS/13.0/SQ27M/EN/XX/' + filename, size: 1234567, modified: '20261028100000', score: 1, exact: true, differences: [] };
const message = (text, userId = 'alice', chat) => ({ headers: { req_id: randomUUID() }, body: { msgtype: 'text', msgid: randomUUID(), chattype: chat ? 'group' : 'single', ...(chat ? { chatid: chat } : {}), from: { userid: userId }, text: { content: text } } });
const until = async fn => { const end = Date.now() + 6000; while (!await fn()) { if (Date.now() > end) throw new Error('wait timeout'); await new Promise(r => setTimeout(r, 10)); } };
const client = () => ({ texts: [], async replyStream(frame, id, text, finish) { if (finish) this.texts.push(text); }, async sendMessage(target, value) { this.texts.push(value.markdown.content); }, disconnect() {} });

test('real Web API + Bridge enforces /firmware entry, switch, ownership, confirmation, notices and final link', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-wecom-')); const token = 'bridge-test-token-'.repeat(4);
  let ready = true, submissions = 0; let job;
  const local = { async ready() { return ready; }, async search() { return [candidate]; }, async lookup() { return job; }, async submit() { submissions++; job = { id: 'c'.repeat(32), candidate, state: 'running', stage: 'downloading', bytes: 100, total_bytes: candidate.size }; return job; }, async job() { return job; }, async cancel() { job.state = 'cancelled'; return job; } };
  const app = await createWebServer({ cwd: root, dataDir: path.join(root, '.data'), resourcesDir: path.resolve('resources'), admin: { account: 'admin', password: 'test-passphrase' }, bridgeToken: token, model: { apiKey: '', baseUrl: '', modelId: '' }, fileTools: { enabled: false }, firmware: { client: local, matcher: async () => [candidate.id], pollMs: 10 } });
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
  await bridge.receive('bot', message(filename)); await bridge.idle(); assert.match(bot.texts.at(-1), /AI 匹配/); assert.equal(submissions, 0);
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

test('SDK firmware matcher uses a single constrained tool and only supplied IDs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-model-')); let calls = 0, assertion;
  const model = createServer(async (req, res) => {
    try {
      const parts = []; for await (const c of req) parts.push(c); const body = JSON.parse(Buffer.concat(parts)); calls++;
      assert.deepEqual(body.tools.map(x => x.function.name), ['firmware']); assert.ok(JSON.stringify(body.messages).includes(candidate.id));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', model: 'fixture', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: 'assistant' }); chunk({ tool_calls: [{ index: 0, id: 'match-call', type: 'function', function: { name: 'firmware', arguments: JSON.stringify({ candidate_ids: [candidate.id], reason: '真实文件名匹配' }) } }] }); chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    } catch (error) { assertion = error; res.writeHead(500); res.end('fixture assertion failed'); }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { model.closeAllConnections(); await new Promise(r => model.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const matcher = createFirmwareMatcher(() => ({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, modelId: 'fixture', contextWindow: 32000, maxTokens: 4096 }), root);
  assert.deepEqual(await matcher(filename, [candidate], AbortSignal.timeout(5000)), [candidate.id]); if (assertion) throw assertion; assert.equal(calls, 1);
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
