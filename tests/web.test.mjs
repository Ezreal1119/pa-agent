import { memoryFixturePath, writeMemoryFixture } from './memory-fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import nodeTest from 'node:test';
import { createWebServer } from '../dist/web/server.js';
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);

async function fixture(t, configured = true, modelId = "fixture") {
  const root = await mkdtemp(path.join(tmpdir(), 'expert-web-test-'));
  const dataDir = path.join(root, '.data');
  for (const name of ['ums-expert', 'urovo-product-expert']) {
    await mkdir(path.join(dataDir, name), { recursive: true });
    await writeFile(path.join(dataDir, name, 'SKILL.md'), `${name} RULE`);
    await writeMemoryFixture(dataDir, name, `${name} MEMORY`);
  }
  const requests = []; let handler; let delayMs = 0;
  const model = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    if (handler) return handler(req, res, body);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant' }, null], [{ content: '**Test answer**\n\n| A | B |\n|---|---|\n| 1 | 2 |' }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const settings = { apiKey: 'test-secret-never-expose', modelId, baseUrl: `http://127.0.0.1:${model.address().port}/v1` };
  const admin = { account: 'fixture-admin', password: 'fixture-admin-password-only' };
  let app = await createWebServer({ fileTools: { enabled: false }, cwd: root, dataDir, admin, resourcesDir: path.resolve('resources'), model: configured ? settings : { apiKey: '', modelId: '', baseUrl: '' } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let url = `http://127.0.0.1:${app.server.address().port}`;
  let token; let cookie;
  async function authenticate() {
    token = (await (await fetch(`${url}/api/auth/status`)).json()).token;
    const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(admin) });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0];
  }
  await authenticate();
  const request = (route, method = 'GET', body, headers = {}) => fetch(url + route, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Local-Token': token, Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  t.after(async () => { await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, settings, requests, request, get auth() { return { token, cookie, admin }; }, requestWithHost(host) { return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/api/status`, { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
  }); }, setHandler(fn) { handler = fn; }, setDelay(ms) { delayMs = ms; }, async restart(fromEnv = false, adminFromEnv = false) {
    await app.close();
    const keys = [...(fromEnv ? ['API_KEY', 'BASE_URL', 'MODEL_ID', 'CONTEXT_WINDOW', 'MAX_TOKENS'] : []), ...(adminFromEnv ? ['ADMIN_ACCOUNT', 'ADMIN_PASSWORD'] : [])];
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      app = await createWebServer({ fileTools: { enabled: false }, cwd: root, dataDir, admin: adminFromEnv ? undefined : admin, resourcesDir: path.resolve('resources'), model: fromEnv ? undefined : settings });
    } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); url = `http://127.0.0.1:${app.server.address().port}`; await authenticate();
  } };
}
function events(text) { return text.split('\n\n').flatMap(frame => { const event = frame.match(/^event: (.+)/m)?.[1]; const data = frame.match(/^data: (.+)/m)?.[1]; return event && data ? [{ event, data: JSON.parse(data) }] : []; }); }
async function createSession(f) { const response = await f.request('/api/sessions', 'POST', {}); assert.equal(response.status, 201); return (await response.json()).id; }

test('unconfigured app serves assets and resource status without leaking credentials or exposing data files', async t => {
  const f = await fixture(t, false);
  for (const route of ['/', '/app.js', '/style.css', '/vendor/marked.js', '/vendor/purify.js']) { const res = await f.request(route); assert.equal(res.status, 200, route); assert.ok(res.headers.get('content-security-policy')); }
  const status = await (await f.request('/api/status')).json();
  assert.equal(status.configured, false); assert.ok(status.skills.every(s => s.files.every(f => f.ready)));
  assert.equal((await f.request('/api/sessions', 'POST', {})).status, 409);
  assert.equal((await f.request('/.data/ums-expert/MEMORY.md')).status, 404);
  assert.equal((await f.request('/.env')).status, 404);
});

test('model connection is .env-only and Agent preferences never rewrite model credentials', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request('/api/config', 'POST', { ...f.settings, persist: true })).status, 410);
  const envText = `API_KEY=${JSON.stringify(f.settings.apiKey)}\nBASE_URL=${JSON.stringify(f.settings.baseUrl)}\nMODEL_ID=${JSON.stringify(f.settings.modelId)}\n`;
  await writeFile(path.join(f.root, '.env'), envText, {mode:0o600});
  const preferences = (await (await f.request('/api/agent-settings')).json()).settings;
  assert.equal((await f.request('/api/agent-settings', 'PUT', preferences)).status, 200);
  assert.equal(await readFile(path.join(f.root, '.env'), 'utf8'), envText);
  assert.equal((await stat(path.join(f.dataDir || path.join(f.root,'.data'), 'web-agent-settings.json'))).mode & 0o777, 0o600);
  const status = await (await f.request('/api/status')).text(); assert.ok(!status.includes(f.settings.apiKey)); assert.equal(JSON.parse(status).configured,false);
  await f.restart(true); assert.equal((await (await f.request('/api/status')).json()).configured, true);
});

test('local API rejects forged host, foreign origins, and missing mutation token', async t => {
  const f = await fixture(t);
  assert.equal(await f.requestWithHost('evil.example'), 403);
  assert.equal((await f.request('/api/status', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/sessions', 'POST', {}, { 'X-Local-Token': '' })).status, 403);
});

test('web chat streams text and actual injection diagnostics, retains five rounds and restores on restart', async t => {
  const f = await fixture(t);
  const id = await createSession(f);
  for (let n = 1; n <= 6; n++) {
    const response = await f.request(`/api/sessions/${id}/run`, 'POST', { text: `question-${n}` }); assert.equal(response.status, 200);
    const stream = events(await response.text());
    assert.ok(stream.some(e => e.event === 'text' && e.data.delta.includes('Test answer')));
    const context = stream.find(e => e.event === 'context').data;
    assert.equal(context.userRounds, Math.min(n, 5));
    assert.ok(context.skills.every(s => s.skillCopies === 1 && s.memoryCopies === 1));
    assert.ok(stream.some(e => e.event === 'done' && !e.data.failed));
  }
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests.at(-1).messages.filter(m => m.role === 'user').length, 5);
  await f.restart();
  const saved = await (await f.request(`/api/sessions/${id}`)).json(); assert.equal(saved.rounds, 6); assert.equal(saved.messages.length, 12);
  const list = await (await f.request('/api/sessions')).json(); assert.equal(list.sessions[0].id, id);
  const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'question-7' })).text());
  assert.equal(stream.find(e => e.event === 'context').data.userRounds, 5);
});

test('busy chat rejects duplicate execution or config changes and stop interrupts the running model', async t => {
  const f = await fixture(t);
  const id = await createSession(f);
  let started; const waiting = new Promise(resolve => { started = resolve; });
  f.setHandler((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': pending\n\n'); started(); });
  const running = f.request(`/api/sessions/${id}/run`, 'POST', { text: 'slow' }).then(response => response.text());
  await waiting;
  assert.equal((await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'duplicate' })).status, 409);
  const preferences=(await(await f.request('/api/agent-settings')).json()).settings;
  assert.equal((await f.request('/api/agent-settings', 'PUT', preferences)).status, 409);
  assert.equal((await f.request(`/api/sessions/${id}/stop`, 'POST', {})).status, 200);
  const stream = events(await running); assert.ok(stream.some(e => e.event === 'error' && e.data.message.includes('stopped')));
  const stopped = stream.find(e => e.event === 'done').data.run; assert.equal(stopped.status, 'stopped'); assert.ok(stopped.elapsedMs >= 0); assert.ok(stopped.finishedAt);
  assert.equal((await (await f.request(`/api/sessions/${id}`)).json()).running, false);
});

test('each DeepSeek effort reaches the HTTP payload, timed runs survive reload/restart without entering model context', async t => {
  const f = await fixture(t, true, 'deepseek-flash');
  f.setDelay(35);
  const id = await createSession(f);
  const status = await (await f.request('/api/status')).json();
  assert.equal(status.reasoning.supported, true); assert.equal(status.reasoning.default, 'low');
  const modes = ['off', 'low', 'high', 'max'];
  for (const [index, effort] of modes.entries()) {
    const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: `effort-${effort}`, effort })).text());
    const payload = f.requests.at(-1);
    assert.deepEqual(payload.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' });
    assert.equal(payload.reasoning_effort, effort === 'off' ? 'none' : effort);
    assert.ok(payload.max_tokens > 0, 'DeepSeek must receive the max_tokens field');
    const context = stream.find(e => e.event === 'context').data;
    assert.equal(context.effort, payload.reasoning_effort); assert.equal(context.thinking, payload.thinking.type);
    const done = stream.find(e => e.event === 'done').data;
    assert.equal(done.run.status, 'completed'); assert.equal(done.run.sequence, index + 1); assert.equal(done.run.round, index + 1);
    assert.equal(done.run.effort, effort); assert.ok(done.run.elapsedMs >= 25); assert.ok(done.run.firstTextMs >= 25);
    assert.ok(done.run.firstTextMs <= done.run.elapsedMs); assert.ok(Date.parse(done.run.finishedAt) >= Date.parse(done.run.startedAt));
    assert.equal(done.messages.filter(m => m.role === 'user').at(-1).run.id, done.run.id);
    assert.ok(!JSON.stringify(payload).includes('web-run-metrics-v1'));
    assert.ok(!JSON.stringify(payload).includes('"elapsedMs"'));
  }
  await f.restart();
  const saved = await (await f.request(`/api/sessions/${id}`)).json();
  assert.equal(saved.runs.length, 4); assert.deepEqual(saved.runs.map(run => run.effort), modes);
  assert.ok(saved.runs.every(run => run.elapsedMs >= 25 && run.status === 'completed'));
  assert.equal(saved.messages.filter(m => m.role === 'user').length, 4);
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'default-low' })).text();
  assert.equal(f.requests.at(-1).reasoning_effort, 'low');
});

test('invalid or unsupported effort is rejected instead of silently claiming it took effect', async t => {
  const f = await fixture(t);
  const id = await createSession(f);
  assert.equal((await (await f.request('/api/status')).json()).reasoning.supported, false);
  assert.equal((await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'no', effort: 'high' })).status, 400);
  assert.equal((await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'no', effort: 'medium' })).status, 400);
  assert.equal(f.requests.length, 0);
  const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'provider defaults' })).text());
  assert.equal(stream.find(e => e.event === 'done').data.run.effort, 'provider-default');
  assert.equal(f.requests[0].reasoning_effort, undefined);
});

test('thinking and reasoning content remain compatible through tool calls and effort switches', async t => {
  const f = await fixture(t, true, 'deepseek-flash');
  const id = await createSession(f);
  const source = path.join(f.root, 'reference.md'); await writeFile(source, 'VERIFIED SOURCE');
  let toolSent = false;
  f.setHandler((_req, res, payload) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (!toolSent) {
      toolSent = true;
      chunk({ reasoning_content: 'fixture-private-reasoning' });
      chunk({ tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: source }) } }] });
      chunk({}, 'tool_calls');
    } else {
      assert.ok(payload.messages.filter(m => m.role === 'assistant').every(m => typeof m.reasoning_content === 'string'));
      assert.ok(payload.messages.some(m => m.role === 'assistant' && m.reasoning_content.includes('fixture-private-reasoning')));
      chunk({ content: 'Verified final answer' }); chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'read reference', effort: 'max' })).text());
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(p => p.reasoning_effort === 'max' && p.thinking.type === 'enabled'));
  assert.ok(!JSON.stringify(stream).includes('fixture-private-reasoning'), 'reasoning must not be exposed to the UI');
  assert.equal(stream.find(e => e.event === 'done').data.runs.length, 1, 'tool subrequests belong to a single timed run');
  const second = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'quick followup', effort: 'off' })).text());
  assert.equal(f.requests.at(-1).thinking.type, 'disabled'); assert.equal(f.requests.at(-1).reasoning_effort, 'none');
  assert.equal(second.find(e => e.event === 'done').data.runs.length, 2);
});

test('failed model requests retain their effort and duration alongside the session', async t => {
  const f = await fixture(t, true, 'deepseek-flash'); const id = await createSession(f);
  f.setHandler((_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture rejected', type: 'invalid_request_error' } })); });
  const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'expected failure', effort: 'high' })).text());
  const result = stream.find(e => e.event === 'done').data;
  assert.equal(result.failed, true); assert.equal(result.run.status, 'failed'); assert.equal(result.run.effort, 'high'); assert.ok(result.run.elapsedMs >= 0); assert.equal(result.run.firstTextMs, null);
  await f.restart();
  const saved = await (await f.request(`/api/sessions/${id}`)).json(); assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].status, 'failed'); assert.equal(saved.runs[0].elapsedMs, result.run.elapsedMs);
});

function replyChunks(res, toolCalls, text = 'Tool inspection answer') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'tool-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant' });
  if (toolCalls) {
    chunk({ tool_calls: toolCalls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
    chunk({}, 'tool_calls');
  } else { chunk({ content: text }); chunk({}, 'stop'); }
  res.end('data: [DONE]\n\n');
}

test('tool inspector counts calls rather than requests, preserves order/errors/timings and isolates rounds and sessions', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const source = path.join(f.root, 'reference.md'); await writeFile(source, 'FULL TOOL OUTPUT <script>bad()</script>');
  let step = 0;
  f.setHandler((_req, res) => {
    step++;
    replyChunks(res, step === 1 ? [
      { id: 'read-success', name: 'read', args: { path: source } },
      { id: 'read-error', name: 'read', args: { path: path.join(f.root, 'missing.md') } },
      { id: 'ls-reference', name: 'ls', args: { path: f.root } },
    ] : step === 2 ? [{ id: 'read-again', name: 'read', args: { path: source } }] : null);
  });
  const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'inspect tools' })).text());
  const done = stream.find(e => e.event === 'done').data;
  assert.equal(f.requests.length, 3); assert.equal(done.run.toolCallCount, 4);
  assert.equal(done.runs[0].toolCallCount, 4);
  assert.equal(done.messages.at(-1).toolCallCount, 4); assert.equal(done.messages.at(-1).toolRunId, done.run.id);
  assert.ok(!JSON.stringify(done).includes('FULL TOOL OUTPUT'), 'tool bodies load only when the inspector is opened');
  const getTools = async (sessionId = id, runId = done.run.id) => f.request(`/api/sessions/${sessionId}/runs/${runId}/tools`);
  let tools = await (await getTools()).json();
  assert.equal(tools.count, 4); assert.deepEqual(tools.calls.map(c => c.id), ['read-success', 'read-error', 'ls-reference', 'read-again']);
  assert.equal(tools.calls[0].arguments.path, source); assert.ok(tools.calls[0].result.content[0].text.includes('FULL TOOL OUTPUT'));
  assert.equal(tools.calls[1].status, 'failed'); assert.equal(tools.calls[1].result.isError, true);
  assert.ok(tools.calls.every(c => c.startedAt && c.finishedAt && c.elapsedMs >= 0)); assert.ok(tools.calls[2].result.content[0].text.includes('reference.md'));
  assert.equal((await getTools(id, 'unknown-run')).status, 404);
  const other = await createSession(f); assert.equal((await getTools(other)).status, 404);
  for (let n = 0; n < 6; n++) {
    const next = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: `no-tools-${n}` })).text()).find(e => e.event === 'done').data;
    assert.equal(next.run.toolCallCount, 0);
    const empty = await (await getTools(id, next.run.id)).json(); assert.equal(empty.count, 0); assert.deepEqual(empty.calls, []);
  }
  await f.restart();
  const restored = await (await f.request(`/api/sessions/${id}`)).json(); assert.equal(restored.runs[0].toolCallCount, 4); assert.equal(restored.messages[1].toolCallCount, 4);
  assert.deepEqual(await (await getTools()).json(), tools);
  assert.ok(f.requests.at(-1).messages.filter(m => m.role === 'user').length <= 5);
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes('web-run-metrics-v1'));
});

test('legacy JSONL tool records can be inspected without invented timing or metadata migrations', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const source = path.join(f.root, 'old.md'); await writeFile(source, 'LEGACY TOOL RESULT');
  let called = false;
  f.setHandler((_req, res) => { replyChunks(res, called ? null : [{ id: 'legacy-read', name: 'read', args: { path: source } }]); called = true; });
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'legacy question' })).text();
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const [saved] = await SessionManager.list(f.root, path.join(f.root, '.data/sessions'));
  const entries = (await readFile(saved.path, 'utf8')).trim().split('\n').map(JSON.parse);
  // Remove UI metadata from this isolated fixture to emulate a pre-feature transcript.
  const kept = entries.filter(e => !(e.type === 'custom' && e.customType === 'web-run-metrics-v1'));
  const removed = new Map(entries.filter(e => !kept.includes(e)).map(e => [e.id, e.parentId]));
  for (const entry of kept) while (removed.has(entry.parentId)) entry.parentId = removed.get(entry.parentId);
  await writeFile(saved.path, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
  await f.restart();
  const messages = (await (await f.request(`/api/sessions/${id}`)).json()).messages;
  assert.equal(messages.at(-1).toolCallCount, 1); assert.equal(messages.at(-1).toolRunId, 'legacy-round-1');
  const tools = await (await f.request(`/api/sessions/${id}/runs/legacy-round-1/tools`)).json();
  assert.equal(tools.count, 1); assert.equal(tools.calls[0].status, 'completed'); assert.equal(tools.calls[0].elapsedMs, null); assert.equal(tools.calls[0].startedAt, null);
  assert.ok(tools.calls[0].result.content[0].text.includes('LEGACY TOOL RESULT'));
});

test('stopping after a read-only tool preserves the call, its result and timing across restart', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const source = path.join(f.root, 'stop-read.md'); await writeFile(source, 'SOURCE BEFORE STOP');
  let entered; const waiting = new Promise(resolve => { entered = resolve; }); let called = false;
  f.setHandler((_req, res) => {
    if (!called) { called = true; return replyChunks(res, [{ id: 'stop-read', name: 'read', args: { path: source } }]); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': pending\n\n'); entered();
  });
  const response = await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'stop during tool' });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = '';
  while (!events(output).some(e => e.event === 'tool' && e.data.state === 'running')) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); output += decoder.decode(chunk.value, { stream: true });
  }
  await waiting;
  await f.request(`/api/sessions/${id}/stop`, 'POST', {});
  while (true) { const chunk = await reader.read(); output += decoder.decode(chunk.value, { stream: !chunk.done }); if (chunk.done) break; }
  const done = events(output).find(e => e.event === 'done').data;
  assert.equal(done.run.status, 'stopped'); assert.equal(done.run.toolCallCount, 1);
  const route = `/api/sessions/${id}/runs/${done.run.id}/tools`;
  const tools = await (await f.request(route)).json(); assert.equal(tools.count, 1); assert.ok(tools.calls[0].elapsedMs >= 0); assert.ok(tools.calls[0].result);
  await f.restart(); assert.deepEqual(await (await f.request(route)).json(), tools);
});

test('interrupted tool runs retain their association and unknown completion after recovery', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const source = path.join(f.root, 'interrupted.md'); await writeFile(source, 'INTERRUPTED SOURCE');
  let called = false;
  f.setHandler((_req, res) => { replyChunks(res, called ? null : [{ id: 'crash-read', name: 'read', args: { path: source } }]); called = true; });
  const done = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'crash fixture' })).text()).find(e => e.event === 'done').data;
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const [saved] = await SessionManager.list(f.root, path.join(f.root, '.data/sessions'));
  const entries = (await readFile(saved.path, 'utf8')).trim().split('\n').map(JSON.parse);
  const startIndex = entries.findIndex(e => e.type === 'custom' && e.data?.toolCalls?.length === 1 && e.data.toolCalls[0].elapsedMs === null);
  assert.ok(startIndex > 0); assert.equal(entries[startIndex].data.round, 1);
  await writeFile(saved.path, entries.slice(0, startIndex + 1).map(e => JSON.stringify(e)).join('\n') + '\n');
  await f.restart();
  const restored = await (await f.request(`/api/sessions/${id}`)).json();
  assert.equal(restored.runs[0].status, 'interrupted'); assert.equal(restored.runs[0].toolCallCount, 1);
  assert.equal(restored.messages.at(-1).toolRunId, done.run.id); assert.ok(restored.messages.at(-1).text.includes('No text answer yet'));
  const tools = await (await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();
  assert.equal(tools.count, 1); assert.equal(tools.calls[0].status, 'interrupted'); assert.equal(tools.calls[0].result, null); assert.equal(tools.calls[0].elapsedMs, null);
});

test('new and restored agents advertise read-only retrieval plus memory tools and reject general mutation/shell calls', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const source = path.join(f.root, 'protected.md'); await writeFile(source, 'KEEP KNOWLEDGE');
  const newFile = path.join(f.root, 'should-not-exist.md');
  let called = false;
  f.setHandler((_req, res, payload) => {
    assert.deepEqual(payload.tools.map(t => t.function.name).sort(), ['find', 'get_file_link_from_library', 'grep', 'ls', 'memory', 'read']);
    if (!called) {
      called = true;
      return replyChunks(res, [
        { id: 'blocked-bash', name: 'bash', args: { command: `rm -f '${source}'` } },
        { id: 'blocked-write', name: 'write', args: { path: newFile, content: 'unexpected' } },
        { id: 'blocked-edit', name: 'edit', args: { path: source, oldText: 'KEEP KNOWLEDGE', newText: 'BROKEN' } },
        { id: 'blocked-powershell', name: 'powershell', args: { command: `Remove-Item '${source}'` } },
      ]);
    }
    replyChunks(res, null, 'Only read-only tools are available');
  });
  const done = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'force a forbidden tool' })).text()).find(e => e.event === 'done').data;
  assert.equal(done.run.toolCallCount, 4);
  const tools = await (await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();
  assert.ok(tools.calls.every(c => c.status === 'failed' && c.result.isError));
  assert.ok(tools.calls.every(c => JSON.stringify(c.result).includes('not found')));
  assert.equal(await readFile(source, 'utf8'), 'KEEP KNOWLEDGE'); await assert.rejects(stat(newFile), { code: 'ENOENT' });
  await f.restart();
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'resume read-only' })).text();
  assert.equal(await readFile(source, 'utf8'), 'KEEP KNOWLEDGE');
});

test('read/grep/find/ls retrieve knowledge under a Git-ignored data directory without shell commands', async t => {
  const f = await fixture(t); const id = await createSession(f);
  await mkdir(path.join(f.root, '.git')); await writeFile(path.join(f.root, '.gitignore'), '.data/\n');
  const shared = path.join(f.root, '.data/urovo-product-expert/_shared'); await mkdir(shared);
  const source = path.join(shared, 'pda-info-summary-fixture.md'); await writeFile(source, 'line one\nREADONLY_REFERENCE_42\nline three\n');
  let called = false;
  f.setHandler((_req, res) => {
    if (!called) {
      called = true;
      return replyChunks(res, [
        { id: 'readonly-ls', name: 'ls', args: { path: shared, limit: 10 } },
        { id: 'readonly-find', name: 'find', args: { path: shared, pattern: 'pda-info-summary*', limit: 10 } },
        { id: 'readonly-grep', name: 'grep', args: { path: shared, pattern: 'READONLY_REFERENCE_42', context: 1, limit: 10 } },
        { id: 'readonly-read', name: 'read', args: { path: source, offset: 2, limit: 1 } },
      ]);
    }
    replyChunks(res, null, 'Verified read-only knowledge retrieval');
  });
  const done = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'find and read knowledge' })).text()).find(e => e.event === 'done').data;
  const tools = await (await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();
  assert.equal(tools.count, 4); assert.ok(tools.calls.every(c => c.status === 'completed'), JSON.stringify(tools.calls));
  assert.ok(tools.calls.slice(0, 2).every(c => JSON.stringify(c.result).includes('pda-info-summary-fixture.md')));
  assert.ok(tools.calls.slice(2).every(c => JSON.stringify(c.result).includes('READONLY_REFERENCE_42')));
  assert.equal(await readFile(source, 'utf8'), 'line one\nREADONLY_REFERENCE_42\nline three\n');
});

test('session rename persists in JSONL across restart and stays out of model context', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const run = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'original question' })).text()).find(e => e.event === 'done').data.run;
  const title = 'renamed-session-metadata-fixture';
  assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title: `  ${title}  ` })).status, 200);
  assert.equal((await (await f.request('/api/sessions')).json()).sessions.find(s => s.id === id).title, title);
  await f.restart();
  const restored = await (await f.request(`/api/sessions/${id}`)).json(); assert.equal(restored.title, title); assert.equal(restored.runs[0].id, run.id);
  assert.equal(restored.rounds, 1);
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'continue conversation' })).text();
  assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes(title), 'session names must not enter model history');
  assert.equal((await (await f.request(`/api/sessions/${id}`)).json()).title, title);
});

test('renaming an empty session persists immediately and the session can still execute after restart', async t => {
  const f = await fixture(t); const id = await createSession(f);
  for (const title of ['', '  ', 'a'.repeat(81), 'two\nlines', '\u0000bad']) assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title })).status, 400);
  assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title: '新对话' })).status, 200);
  await f.restart();
  const empty = await (await f.request(`/api/sessions/${id}`)).json(); assert.equal(empty.title, '新对话'); assert.equal(empty.rounds, 0);
  const stream = events(await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'first prompt after rename' })).text());
  assert.equal(stream.find(e => e.event === 'done').data.failed, false);
  assert.equal((await (await f.request(`/api/sessions/${id}`)).json()).title, '新对话', 'explicit title must not be replaced by auto title');
});

test('delete removes JSONL, messages, metrics and cache without resurrecting the session', async t => {
  const f = await fixture(t); const id = await createSession(f); const other = await createSession(f);
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'disposable conversation' })).text();
  await (await f.request(`/api/sessions/${other}/run`, 'POST', { text: 'keep this conversation' })).text();
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const saved = (await SessionManager.list(f.root, path.join(f.root, '.data/sessions'))).find(s => s.id === id);
  assert.equal((await f.request(`/api/sessions/${id}`, 'DELETE')).status, 200);
  await assert.rejects(stat(saved.path), { code: 'ENOENT' });
  for (const [route, method, body] of [[`/api/sessions/${id}`, 'GET'], [`/api/sessions/${id}`, 'DELETE'], [`/api/sessions/${id}`, 'PATCH', { title: 'resurrect' }], [`/api/sessions/${id}/run`, 'POST', { text: 'resurrect' }], [`/api/sessions/${id}/runs/legacy-round-1/tools`, 'GET']]) assert.equal((await f.request(route, method, body)).status, 404);
  assert.ok(!(await (await f.request('/api/sessions')).json()).sessions.some(s => s.id === id));
  await f.restart(); assert.equal((await f.request(`/api/sessions/${id}`)).status, 404);
  assert.equal((await f.request(`/api/sessions/${other}`)).status, 200);
  const empty = await createSession(f); assert.equal((await f.request(`/api/sessions/${empty}`, 'DELETE')).status, 200); assert.equal((await f.request(`/api/sessions/${empty}`)).status, 404);
});

test('session management rejects active runs and unauthorized mutation requests', async t => {
  const f = await fixture(t); const id = await createSession(f);
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await f.request(`/api/sessions/${id}`, method, method === 'PATCH' ? { title: 'blocked' } : undefined, { 'X-Local-Token': '' })).status, 403);
    assert.equal((await f.request(`/api/sessions/${id}`, method, method === 'PATCH' ? { title: 'blocked' } : undefined, { Origin: 'https://evil.example' })).status, 403);
  }
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.setHandler((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': pending\n\n'); entered(); });
  const running = f.request(`/api/sessions/${id}/run`, 'POST', { text: 'active conversation' }).then(r => r.text()); await waiting;
  assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title: 'blocked' })).status, 409);
  assert.equal((await f.request(`/api/sessions/${id}`, 'DELETE')).status, 409);
  await f.request(`/api/sessions/${id}/stop`, 'POST', {}); await running;
  assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title: 'allowed after stopping' })).status, 200);
  assert.equal((await f.request(`/api/sessions/${id}`, 'DELETE')).status, 200);
});

test('saved session rename/delete do not require loading a model or available knowledge files', async t => {
  const f = await fixture(t); const id = await createSession(f);
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'saved session' })).text();
  await rm(memoryFixturePath(path.join(f.root, '.data'))); await f.restart();
  assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title: 'manage without inference' })).status, 200);
  assert.equal((await f.request(`/api/sessions/${id}`, 'DELETE')).status, 200);
});

test('session management refuses symlink targets and unknown IDs without modifying unrelated files', async t => {
  const f = await fixture(t); const id = await createSession(f);
  await (await f.request(`/api/sessions/${id}/run`, 'POST', { text: 'session path fixture' })).text();
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const [saved] = await SessionManager.list(f.root, path.join(f.root, '.data/sessions'));
  const original = await readFile(saved.path, 'utf8'); const outside = path.join(f.root, 'outside.jsonl');
  await writeFile(outside, original); await rm(saved.path); await symlink(outside, saved.path);
  assert.equal((await f.request(`/api/sessions/${id}`, 'PATCH', { title: 'must not append' })).status, 400);
  assert.equal((await f.request(`/api/sessions/${id}`, 'DELETE')).status, 400);
  assert.equal(await readFile(outside, 'utf8'), original);
  assert.equal((await f.request('/api/sessions/unknown-session-id', 'DELETE')).status, 404);
  assert.equal((await f.request('/api/sessions/unknown-session-id', 'PATCH', { title: 'unknown' })).status, 404);
});

test('anonymous visitors see login and cannot read or mutate Agent data even with a local token', async t => {
  const f = await fixture(t); const id = await createSession(f);
  const anonymous = { Cookie: '' };
  const root = await f.request('/', 'GET', undefined, anonymous); assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/login');
  assert.ok((await (await f.request('/login', 'GET', undefined, anonymous)).text()).includes('Sign in to your workspace'));
  assert.equal((await f.request('/login.js', 'GET', undefined, anonymous)).status, 200);
  const status = await (await f.request('/api/auth/status', 'GET', undefined, anonymous)).json();
  assert.equal(status.authenticated, false); assert.equal(status.configured, true); assert.ok(status.token); assert.ok(!JSON.stringify(status).includes(f.auth.admin.password));
  for (const [route, method, body] of [
    ['/api/status', 'GET'], ['/api/sessions', 'GET'], ['/app.js', 'GET'], [`/api/sessions/${id}`, 'GET'],
    ['/api/sessions', 'POST', {}], ['/api/agent-settings', 'GET'], ['/api/agent-settings', 'PUT', {}], ['/api/config', 'POST', f.settings], [`/api/sessions/${id}`, 'DELETE'],
    [`/api/sessions/${id}`, 'PATCH', { title: 'blocked' }], [`/api/sessions/${id}/run`, 'POST', { text: 'blocked' }],
    [`/api/sessions/${id}/runs/legacy-round-1/tools`, 'GET'],
  ]) assert.equal((await f.request(route, method, body, anonymous)).status, 401, route);
  assert.equal(f.requests.length, 0);
});

test('login validates credentials, uses a protected cookie, and logout invalidates it on the server', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/login', 'POST', { account: f.auth.admin.account, password: 'wrong' }, { Cookie: '' })).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', { account: 'wrong', password: f.auth.admin.password }, { Cookie: '' })).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', f.auth.admin, { Cookie: '', 'X-Local-Token': '' })).status, 403);
  assert.equal((await f.request('/api/auth/login', 'POST', f.auth.admin, { Cookie: '', Origin: 'https://evil.example' })).status, 403);
  const login = await f.request('/api/auth/login', 'POST', f.auth.admin, { Cookie: '' }); assert.equal(login.status, 200);
  const header = login.headers.get('set-cookie'); assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=604800/);
  assert.ok(!header.includes(f.auth.admin.password)); assert.ok(!header.includes(f.auth.admin.account));
  const cookie = header.split(';')[0];
  assert.equal((await f.request('/api/status', 'GET', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await f.request('/api/status', 'GET', undefined, { Cookie: cookie + 'tampered' })).status, 401);
  const logout = await f.request('/api/auth/logout', 'POST', {}, { Cookie: cookie }); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/api/status', 'GET', undefined, { Cookie: cookie })).status, 401);
});

test('login failures are rate limited and server restart invalidates previous cookies', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 10; n++) assert.equal((await f.request('/api/auth/login', 'POST', { account: 'wrong', password: 'wrong' }, { Cookie: '' })).status, 401);
  const limited = await f.request('/api/auth/login', 'POST', f.auth.admin, { Cookie: '' }); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const oldCookie = f.auth.cookie; await f.restart();
  assert.equal((await f.request('/api/status', 'GET', undefined, { Cookie: oldCookie })).status, 401);
  assert.equal((await f.request('/api/status')).status, 200);
});

test('administrator credentials load from .env and survive saving Agent settings without exposure', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.env'), `ADMIN_ACCOUNT=${JSON.stringify(f.auth.admin.account)}\nADMIN_PASSWORD=${JSON.stringify(f.auth.admin.password)}\nAPI_KEY=${JSON.stringify(f.settings.apiKey)}\nBASE_URL=${JSON.stringify(f.settings.baseUrl)}\nMODEL_ID=${JSON.stringify(f.settings.modelId)}\n`);
  await f.restart(true, true);
  const status = await (await f.request('/api/status')).text(); assert.ok(!status.includes(f.auth.admin.account)); assert.ok(!status.includes(f.auth.admin.password));
  assert.equal((await f.request('/api/agent-settings', 'PUT', (await(await f.request('/api/agent-settings')).json()).settings)).status, 200);
  const env = await readFile(path.join(f.root, '.env'), 'utf8'); assert.ok(env.includes(`ADMIN_ACCOUNT=${JSON.stringify(f.auth.admin.account)}`)); assert.ok(env.includes(`ADMIN_PASSWORD=${JSON.stringify(f.auth.admin.password)}`));
  await f.restart(true, true); assert.equal((await f.request('/api/status')).status, 200);
});

test('missing or partial administrator configuration fails closed with setup instructions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'expert-login-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const admin of [{ account: '', password: '' }, { account: 'admin', password: '' }, { account: '', password: 'secret' }]) {
    const app = await createWebServer({ fileTools: { enabled: false }, cwd: root, admin, resourcesDir: path.resolve('resources') });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try {
      const url = `http://127.0.0.1:${app.server.address().port}`;
      const status = await (await fetch(url + '/api/auth/status')).json(); assert.equal(status.configured, false); assert.equal(status.authenticated, false);
      assert.equal((await fetch(url + '/api/status')).status, 401);
      const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': status.token }, body: JSON.stringify({ account: 'admin', password: 'secret' }) });
      assert.equal(login.status, 503); assert.match((await login.json()).error, /ADMIN_ACCOUNT.*ADMIN_PASSWORD/);
    } finally { await app.close(); }
  }
});

test('the single memory tool routes all three actions through the SDK, inject once next run, restore, and leave skill memories untouched', async t => {
  const f=await fixture(t); const id=await createSession(f);
  const {ExtraMemoryStore}=await import('../dist/agent/extra-memory.js');
  const store=new ExtraMemoryStore(path.join(f.root,'.data'));
  const empty=await store.snapshot();await store.change({action:'add',expected_revision:empty.revision,content:'EXTRA_ORIGINAL_SENTINEL'});
  const originalSkills=await Promise.all(['ums-expert','urovo-product-expert'].map(name=>readFile(memoryFixturePath(path.join(f.root,'.data'),name),'utf8')));
  let action='add';let step=0;let entryId;let revision;let seenSystems=[];
  f.setHandler((_req,res,payload)=>{
    const system=payload.messages.filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content).join('\n');seenSystems.push(system);
    assert.equal(system.split('## Extra agent memory\nSource:').length-1,1);
    assert.ok(system.includes('EXTRA_ORIGINAL_SENTINEL'));
    if(step++===0 && action!=='none') {
      const expected_revision=system.match(/## Extra agent memory\nSource: [^\n]+\nRevision: ([a-f0-9]{64})/)[1];
      replyChunks(res,[{id:`extra-${action}`,name:'memory',args:{action,expected_revision,...(action==='add'?{content:'EXTRA_NEW_SENTINEL'}:action==='edit'?{id:entryId,content:'EXTRA_EDITED_SENTINEL'}:{id:entryId})}}]);
    } else {
      if(action!=='none') {
        const tool=payload.messages.findLast(m=>m.role==='tool');const result=JSON.parse(tool.content);entryId=result.id;revision=result.revision;
        assert.match(revision,/^[a-f0-9]{64}$/);
      }
      replyChunks(res,null,`memory ${action} complete`);
    }
  });
  async function run(next,text){action=next;step=0;seenSystems=[];const stream=events(await(await f.request(`/api/sessions/${id}/run`,'POST',{text})).text());const done=stream.find(e=>e.event==='done').data;assert.equal(done.failed,false);assert.equal(done.context.extraMemoryCopies,1);return done;}
  const added=await run('add','请记住这条测试信息');assert.equal(added.run.toolCallCount,1);assert.ok(seenSystems.every(s=>!s.includes('EXTRA_NEW_SENTINEL')));
  const fileAfterAdd=(await store.snapshot()).text;assert.ok(fileAfterAdd.includes('unknown@email.com'));
  const edited=await run('edit','修改刚才新增的记忆');assert.equal(edited.run.toolCallCount,1);assert.ok(seenSystems.every(s=>s.includes('EXTRA_NEW_SENTINEL')&&!s.includes('EXTRA_EDITED_SENTINEL')));
  await f.restart();
  const removed=await run('delete','删除刚才的额外记忆');assert.equal(removed.run.toolCallCount,1);assert.ok(seenSystems.every(s=>s.includes('EXTRA_EDITED_SENTINEL')));
  await run('none','普通问答不修改记忆');assert.ok(seenSystems.every(s=>!s.includes('EXTRA_EDITED_SENTINEL')));
  assert.equal((await store.snapshot()).revision,revision);
  assert.deepEqual(await Promise.all(['ums-expert','urovo-product-expert'].map(name=>readFile(memoryFixturePath(path.join(f.root,'.data'),name),'utf8'))),originalSkills);
  const calls=await(await f.request(`/api/sessions/${id}/runs/${added.run.id}/tools`)).json();assert.equal(calls.calls[0].name,'memory');assert.equal(calls.calls[0].status,'completed');
});

test('memory tool path overrides and skill IDs cannot write skill memories', async t=>{
  const f=await fixture(t);const id=await createSession(f);let sent=false;
  const {ExtraMemoryStore}=await import('../dist/agent/extra-memory.js');const store=new ExtraMemoryStore(path.join(f.root,'.data'));const revision=(await store.snapshot()).revision;
  const protectedFile=memoryFixturePath(path.join(f.root,'.data'));const original=await readFile(protectedFile,'utf8');
  f.setHandler((_req,res)=>{
    if(!sent){sent=true;return replyChunks(res,[
      {id:'override-path',name:'memory',args:{action:'add',content:'must not reach a skill',expected_revision:revision,path:protectedFile}},
      {id:'skill-id',name:'memory',args:{action:'delete',id:'mem_skill_123',expected_revision:revision}},
    ]);}
    replyChunks(res,null,'Restricted to extra memory');
  });
  const done=events(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'attempt forbidden memory targets'})).text()).find(e=>e.event==='done').data;
  const calls=await(await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();assert.ok(calls.calls.every(c=>c.status==='failed'));
  assert.equal(await readFile(protectedFile,'utf8'),original);assert.equal((await store.snapshot()).text,'');
});

test('single memory tool rejects obsolete tool names, unknown actions and missing or contradictory action arguments', async t=>{
  const f=await fixture(t);const id=await createSession(f);let sent=false;
  const {ExtraMemoryStore}=await import('../dist/agent/extra-memory.js');const store=new ExtraMemoryStore(path.join(f.root,'.data'));const expected_revision=(await store.snapshot()).revision;
  f.setHandler((_req,res,payload)=>{
    assert.deepEqual(payload.tools.map(t=>t.function.name).sort(),['find','get_file_link_from_library','grep','ls','memory','read']);
    if(!sent){sent=true;return replyChunks(res,[
      {id:'old-memory-name',name:'memory_add',args:{content:'obsolete',expected_revision}},
      {id:'invalid-action',name:'memory',args:{action:'list',expected_revision}},
      {id:'missing-content',name:'memory',args:{action:'add',expected_revision}},
      {id:'missing-id',name:'memory',args:{action:'edit',content:'no id',expected_revision}},
      {id:'contradictory-delete',name:'memory',args:{action:'delete',id:'mem_nonexistent',content:'not valid for delete',expected_revision}},
    ]);}
    replyChunks(res,null,'Invalid requests refused');
  });
  const done=events(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'validate memory arguments'})).text()).find(e=>e.event==='done').data;
  const calls=await(await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();
  assert.equal(calls.count,5);assert.ok(calls.calls.every(c=>c.status==='failed'));assert.equal((await store.snapshot()).text,'');
});

test('global effort and individual file toggles reach actual new and restored SDK sessions and survive restart', async t=>{
 const f=await fixture(t,true,'deepseek-flash');const a=await createSession(f);const b=await createSession(f);
 await(await f.request(`/api/sessions/${a}/run`,'POST',{text:'original'})).text();
 const preference=(await(await f.request('/api/agent-settings')).json()).settings;
 preference.effort='high';
 for(const name of Object.keys(preference.fileTools.tools))preference.fileTools.tools[name]=name==='pdf_read';
 assert.equal((await f.request('/api/agent-settings','PUT',preference)).status,200);
 assert.equal((await(await f.request('/api/status')).json()).reasoning.default,'high');
 for(const id of [a,b]){
  const data=events(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'global preference'})).text()).find(e=>e.event==='done').data;assert.equal(data.failed,false);assert.equal(data.run.effort,'high');
  const request=f.requests.at(-1);assert.equal(request.reasoning_effort,'high');assert.deepEqual(request.tools.map(t=>t.function.name).sort(),['find','get_file_link_from_library','grep','ls','memory','pdf_read','read']);
 }
 await f.restart();assert.deepEqual((await(await f.request('/api/agent-settings')).json()).settings,preference);
 await(await f.request(`/api/sessions/${a}/run`,'POST',{text:'restored preference'})).text();assert.equal(f.requests.at(-1).reasoning_effort,'high');assert.ok(f.requests.at(-1).tools.some(t=>t.function.name==='pdf_read'));assert.equal((await(await f.request(`/api/sessions/${a}`)).json()).messages.filter(m=>m.role==='user').length,3);
 for(const name of Object.keys(preference.fileTools.tools))preference.fileTools.tools[name]=false;assert.equal((await f.request('/api/agent-settings','PUT',preference)).status,200);
 await(await f.request(`/api/sessions/${a}/run`,'POST',{text:'off'})).text();assert.deepEqual(f.requests.at(-1).tools.map(t=>t.function.name).sort(),['find','get_file_link_from_library','grep','ls','memory','read']);
 preference.fileTools.tools.pdf_read=false;preference.fileTools.tools.image_read=true;preference.effort='off';assert.equal((await f.request('/api/agent-settings','PUT',preference)).status,200);
 await(await f.request(`/api/sessions/${b}/run`,'POST',{text:'fast with image tool'})).text();assert.equal(f.requests.at(-1).thinking.type,'disabled');assert.deepEqual(f.requests.at(-1).tools.map(t=>t.function.name).sort(),['find','get_file_link_from_library','grep','image_read','ls','memory','read']);
});

test('Agent settings enforce authentication, CSRF, schema and provider capability without accepting model fields', async t=>{
 const f=await fixture(t);const current=(await(await f.request('/api/agent-settings')).json()).settings;
 assert.equal((await f.request('/api/agent-settings','PUT',current,{'X-Local-Token':''})).status,403);
 assert.equal((await f.request('/api/agent-settings','PUT',current,{Cookie:''})).status,401);
 for(const body of [{...current,effort:'bad'},...[null,[],{},true,{enabled:'true',tools:{search:true,fetch:true}},{enabled:true,tools:{search:true}},{enabled:true,tools:{search:true,fetch:true,bash:true}},{enabled:true,tools:{search:'yes',fetch:true}},{enabled:true,tools:{search:true,fetch:true},apiKey:'injection'}].map(webTools=>({...current,webTools})),...[{enabled:'true'},null,[],{},{enabled:true,endpoint:'https://other.example'}].map(libraryLinks=>({...current,libraryLinks})),{...current,modelId:'injection'},{...current,fileTools:{enabled:true,tools:{bash:true}}},{...current,fileTools:{...current.fileTools,enabled:'true'}}])assert.equal((await f.request('/api/agent-settings','PUT',body)).status,400);
 assert.equal((await f.request('/api/agent-settings','PUT',{...current,effort:'high'})).status,400);
 assert.deepEqual((await(await f.request('/api/agent-settings')).json()).settings,current);
 const page=await(await f.request('/')).text();assert.ok(page.includes('Agent settings'));assert.ok(!page.includes('id="api-key"'));assert.ok(!page.includes('id="base-url"'));assert.ok(!page.includes('data-effort='));
});

test('Agent preferences reject linked or malformed storage without changing other files', async t=>{
 const {AgentSettingsStore}=await import('../dist/web/agent-settings.js');
 const root=await mkdtemp(path.join(tmpdir(),'expert-agent-preferences-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const defaults={effort:'low',libraryLinks:{enabled:true},webTools:{tools:{search:false,fetch:false}},fileTools:{tools:Object.fromEntries(['pdf_read','docx_read','pptx_read','excel_read','excel_patch_template','image_read','excel_create','text_file_create'].map(name=>[name,true]))}};
 const store=new AgentSettingsStore(root);const sentinel=path.join(root,'env-fixture');await writeFile(sentinel,'DO_NOT_CHANGE');await symlink(sentinel,store.file);
 await assert.rejects(store.save(defaults),/regular file/);assert.equal(await readFile(sentinel,'utf8'),'DO_NOT_CHANGE');await rm(store.file);
 await writeFile(store.file,'malformed JSON');await assert.rejects(store.load(defaults));
 await rm(store.file);assert.deepEqual(await store.load(defaults),defaults);await store.save(defaults);assert.deepEqual(await store.load(defaults),defaults);
});


test('legacy Agent preferences default library links on and persist an explicit off without rewriting existing switches', async t=>{
 const {AgentSettingsStore}=await import('../dist/web/agent-settings.js');
 const root=await mkdtemp(path.join(tmpdir(),'expert-links-preferences-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const legacy={effort:'high',fileTools:{enabled:false,tools:Object.fromEntries(['pdf_read','docx_read','pptx_read','excel_read','excel_patch_template','image_read'].map(name=>[name,name==='pdf_read']))}};
 const store=new AgentSettingsStore(root);await writeFile(store.file,JSON.stringify(legacy));
 const loaded=await store.load({...legacy,libraryLinks:{enabled:true}});assert.deepEqual(loaded,{...legacy,fileTools:{tools:Object.fromEntries([...Object.keys(legacy.fileTools.tools),'excel_create','text_file_create'].map(name=>[name,false]))},libraryLinks:{enabled:true},webTools:{tools:{search:false,fetch:false}}});
 loaded.libraryLinks.enabled=false;await store.save(loaded);
 assert.deepEqual(await new AgentSettingsStore(root).load({...legacy,libraryLinks:{enabled:true}}),loaded);
 assert.equal((await stat(store.file)).mode&0o777,0o600);
});

test('master-free preferences preserve legacy effective states and enable a single file tool without another switch', async t=>{
 const {validateAgentSettings}=await import('../dist/web/agent-settings.js');
 const f=await fixture(t);const original=(await(await f.request('/api/agent-settings')).json()).settings;
 assert.ok(!('enabled' in original.fileTools));assert.ok(!('enabled' in original.webTools));
 assert.ok(Object.values(original.fileTools.tools).every(value=>value===false));
 const legacy={...original,fileTools:{enabled:false,tools:Object.fromEntries(Object.keys(original.fileTools.tools).map(name=>[name,true]))},webTools:{enabled:false,tools:{search:true,fetch:true}}};
 const migrated=validateAgentSettings(legacy);assert.deepEqual(migrated,original);
 const on=validateAgentSettings({...legacy,fileTools:{...legacy.fileTools,enabled:true},webTools:{enabled:true,tools:{search:true,fetch:false}}});
 assert.ok(Object.values(on.fileTools.tools).every(Boolean));assert.deepEqual(on.webTools,{tools:{search:true,fetch:false}});
 original.fileTools.tools.pdf_read=true;
 const saved=await f.request('/api/agent-settings','PUT',original);assert.equal(saved.status,200);assert.deepEqual((await saved.json()).settings,original);
 const status=await(await f.request('/api/status')).json();assert.equal(status.fileTools.enabled,true);assert.deepEqual(status.fileTools.tools,['pdf_read']);
 const id=await createSession(f);await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'Only PDF should be enabled'})).text();
 assert.deepEqual(f.requests.at(-1).tools.map(tool=>tool.function.name).sort(),['find','get_file_link_from_library','grep','ls','memory','pdf_read','read']);
 await f.restart();assert.deepEqual((await(await f.request('/api/agent-settings')).json()).settings,original);
 const disk=JSON.parse(await readFile(path.join(f.root,'.data/web-agent-settings.json'),'utf8'));assert.ok(!('enabled' in disk.fileTools));assert.ok(!('enabled' in disk.webTools));
});

test('all Web pages and fixed scripts use English and settings contain only individual tool switches', async t=>{
 const f=await fixture(t,false);
 for(const route of ['/','/login','/wecom-contacts','/app.js','/login.js','/contacts.js']){
  const response=await f.request(route,'GET',undefined,route==='/login'?{Cookie:''}:{});assert.equal(response.status,200,route);const body=await response.text();assert.doesNotMatch(body,/\p{Script=Han}/u,route);
  if(route.endsWith('.js'))continue;assert.match(body,/<html lang="en-US">/);
  if(route==='/'){assert.ok(!body.includes('id="web-tools-enabled"'));assert.ok(!body.includes('id="file-tools-enabled"'));assert.match(body,/Enable web search/);assert.match(body,/Enable page fetching/);}
  if(route==='/login')assert.match(body,/Sign-in lasts 7 days/);
 }
 const moved=await f.request('/mcp-usage');assert.equal(moved.status,302);assert.equal(moved.headers.get('location'),'/?settings=mcp');
 const bad=await f.request('/api/auth/login','POST',{account:'wrong',password:'wrong'});assert.equal(bad.status,401);assert.equal((await bad.json()).error,'Incorrect account or password.');
});
