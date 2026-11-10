import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chatHistory, historyPageSize } from '../dist/web/chat-history.js';
import { createWebServer } from '../dist/web/server.js';
import { writeMemoryFixture } from './memory-fixtures.mjs';

const assistant = (text, timestamp, content) => ({ role: 'assistant', content: content ?? [{ type: 'text', text }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp });
function conversation(rounds = 200, size = 2000, manager = SessionManager.inMemory('/tmp')) {
  const messages = [], start = Date.now() - rounds * 2;
  for (let i = 0; i < rounds; i++) {
    for (const message of [{ role: 'user', content: `Question ${i}`, timestamp: start + i * 2 }, assistant(`Answer ${i}\n\n${'x'.repeat(size)}`, start + 1 + i * 2)]) {
      manager.appendMessage(message); messages.push(message);
    }
  }
  return { messages, sessionManager: manager, sessionId: manager.getSessionId() };
}

test('cursor pages cover a long history exactly once and remain stable across appends and reloads', () => {
  const session = conversation();
  const first = chatHistory(session, [], undefined, { limit: 30 });
  assert.equal(first.messages.length, 30); assert.equal(first.messages.at(-1).text.startsWith('Answer 199'), true);
  const all = [...first.messages]; let page = first.page;
  const nextBeforeAppend = chatHistory(session, [], undefined, { limit: 30, before: page.nextCursor });
  const added = { role: 'user', content: 'New question', timestamp: 1800000000000 }; session.sessionManager.appendMessage(added); session.messages.push(added);
  assert.deepEqual(chatHistory(session, [], undefined, { limit: 30, before: page.nextCursor }).messages, nextBeforeAppend.messages);
  while (page.hasMore) {
    const previous = chatHistory(session, [], undefined, { limit: 30, before: page.nextCursor });
    all.unshift(...previous.messages); page = previous.page;
  }
  assert.equal(all.length, 400); assert.equal(new Set(all.map(message => message.id)).size, 400);
  assert.deepEqual(all.map(({ id, ...message }) => message), chatHistory({ ...session, messages: session.messages.slice(0, -1) }, []).messages);
  const clone = { ...session, messages: structuredClone(session.messages) };
  assert.deepEqual(chatHistory(clone, [], undefined, { limit: 30 }).messages.map(m => m.id), chatHistory(session, [], undefined, { limit: 30 }).messages.map(m => m.id));
});

test('invalid sizes, malformed/cross-session/stale cursors fail without silently returning another page', () => {
  for (const value of [0, 101, 1.5, '30', null, true]) assert.throws(() => historyPageSize(value), /page size/);
  const session = conversation(20), other = conversation(20);
  const page = chatHistory(session, [], undefined, { limit: 30 }).page;
  for (const before of ['', '???', 'a'.repeat(2049), Buffer.from('{}').toString('base64url')]) assert.throws(() => chatHistory(session, [], undefined, { limit: 30, before }), error => error.status === 400);
  assert.throws(() => chatHistory(other, [], undefined, { limit: 30, before: page.nextCursor }), error => error.status === 400);
  const stale = Buffer.from(JSON.stringify({ v: 1, session: session.sessionId, before: 'removed-entry' })).toString('base64url');
  assert.throws(() => chatHistory(session, [], undefined, { limit: 30, before: stale }), error => error.status === 409);
  assert.deepEqual(chatHistory(conversation(0), [], undefined, { limit: 30 }).page, { hasMore: false, nextCursor: null });
});

test('page boundaries preserve attachments, generated files, tool placeholders and duplicate timestamps', () => {
  const session = conversation(2, 10), manager = session.sessionManager;
  const lastUser = manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1);
  const file = { id: 'a1234567-1234-1234-1234-123456789abc', direction: 'outputs', name: 'answer.txt', bytes: 4 };
  const input = { ...file, id: 'b1234567-1234-1234-1234-123456789abc', direction: 'inputs', name: 'source.pdf' };
  manager.appendCustomEntry('message-attachments-v1', { runId: 'run', round: 2, timestamp: lastUser.message.timestamp, files: [input] });
  manager.appendCustomEntry('generated-file-v1', { userMessageId: lastUser.id, round: 2, toolCallId: 'tool', file });
  const final = session.messages.pop();
  const call = assistant('', final.timestamp, [{ type: 'toolCall', id: 'tool', name: 'text_file_create', arguments: {} }]);
  manager.appendMessage(call); session.messages.push(call);
  const history = chatHistory(session, [file], undefined, { limit: 2 });
  assert.equal(history.messages[0].attachments[0].id, input.id);
  assert.equal(history.messages[1].toolCallCount, 1); assert.equal(history.messages[1].outputs[0].id, file.id);
  assert.match(history.messages[1].id, /^placeholder-/);
  const repeated = { role: 'user', content: 'same timestamp', timestamp: lastUser.message.timestamp }; manager.appendMessage(repeated); session.messages.push(repeated);
  const ids = chatHistory(session, [file], undefined, { limit: 30 }).messages.map(message => message.id);
  assert.equal(new Set(ids).size, ids.length);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-history-')), dataDir = path.join(root, '.data');
  await fs.mkdir(path.join(dataDir, 'urovo-product-expert'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'urovo-product-expert/SKILL.md'), 'Fixture instructions');
  await writeMemoryFixture(dataDir, 'urovo-product-expert', 'Fixture memory');
  const payloads = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; payloads.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant' }, { content: 'Fixture response' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }); model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const manager = SessionManager.create(root, path.join(dataDir, 'sessions'));
  const seeded = conversation(200, 2000, manager), id = seeded.sessionId;
  const modelOptions = { apiKey: 'fixture-key', modelId: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1` };
  const options = { cwd: root, dataDir, resourcesDir: path.resolve('resources'), fileTools: { enabled: false }, admin: { account: 'admin', password: 'fixture-password' }, model: modelOptions };
  let app, base, headers;
  const start = async () => {
    app = await createWebServer(options); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = `http://127.0.0.1:${app.server.address().port}`;
    const auth = await (await fetch(base + '/api/auth/status')).json();
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': auth.token }, body: JSON.stringify({ account: 'admin', password: 'fixture-password' }) });
    headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Local-Token': auth.token, 'Content-Type': 'application/json' };
  };
  await start();
  t.after(async () => { await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { id, payloads, anonymous: route => fetch(base + route), request: (route, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), restart: async () => { await app.close(); await start(); } };
}

test('HTTP history limits payload, keeps legacy interfaces, survives restart and leaves inference at five turns', { timeout: 60000 }, async t => {
  const f = await fixture(t), route = `/api/sessions/${f.id}`;
  assert.equal((await f.anonymous(route + '/history')).status, 401);
  const created = await (await f.request('/api/sessions', {})).json();
  const empty = await (await f.request(`/api/sessions/${created.id}/history`)).json();
  assert.deepEqual(empty.messages, []); assert.equal(empty.page.hasMore, false);
  let started = performance.now(); const fullText = await (await f.request(route)).text(); const fullMs = performance.now() - started;
  started = performance.now(); const pageText = await (await f.request(route + '/history?limit=30')).text(); const pageMs = performance.now() - started;
  const full = JSON.parse(fullText), page = JSON.parse(pageText);
  assert.equal(full.messages.length, 400); assert.equal(page.messages.length, 30);
  assert.ok(Buffer.byteLength(pageText) < Buffer.byteLength(fullText) / 5);
  assert.equal(full.messages[0].id, undefined); assert.equal(page.rounds, 200); assert.equal(page.contextRounds, 5);
  assert.equal(page.messages.at(-1).text, full.messages.at(-1).text);
  const before = encodeURIComponent(page.page.nextCursor);
  assert.equal((await f.request(`/api/sessions/${created.id}/history?before=${before}`)).status, 400);
  const previous = await (await f.request(route + '/history?before=' + before)).json();
  await f.restart();
  assert.deepEqual((await (await f.request(route + '/history?before=' + before)).json()).messages, previous.messages);
  for (const query of ['limit=0', 'limit=1.5', 'limit=101', 'limit=30&limit=10', 'before=', 'before=bad', 'unexpected=1']) assert.equal((await f.request(route + '/history?' + query)).status, 400);
  for (const historyPageSize of [0, '30', 101]) assert.equal((await f.request(route + '/run', { text: 'invalid', historyPageSize })).status, 400);
  const stream = await (await f.request(route + '/run', { text: 'New question', historyPageSize: 30 })).text();
  const done = stream.split('\n\n').find(frame => frame.startsWith('event: done\n'));
  assert.ok(done, stream); const result = JSON.parse(done.split('\ndata: ')[1]);
  assert.equal(result.messages.length, 30); assert.ok(result.messages.every(message => message.id)); assert.equal(result.page.hasMore, true);
  assert.equal(f.payloads.at(-1).messages.filter(message => message.role === 'user').length, 5);
  const legacy = await (await f.request(route + '/run', { text: 'Legacy question' })).text();
  const legacyDone = JSON.parse(legacy.split('\n\n').find(frame => frame.startsWith('event: done\n')).split('\ndata: ')[1]);
  assert.equal(legacyDone.messages.length, 404); assert.equal(legacyDone.page, undefined);
  console.log(JSON.stringify({ historyBenchmark: { fullBytes: Buffer.byteLength(fullText), pageBytes: Buffer.byteLength(pageText), fullMs: +fullMs.toFixed(1), pageMs: +pageMs.toFixed(1) } }));
});
