import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
import { createAgentRuntime, SessionManager } from '../dist/index.js';
import { recentRounds } from '../dist/agent/context-window.js';
import { SessionRetention } from '../dist/agent/retention.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'product-expert-test-'));
  const dataDir = path.join(root, '.data');
  for (const name of ['ums-expert', 'urovo-product-expert']) {
    await mkdir(path.join(dataDir, name), { recursive: true });
    await writeFile(path.join(dataDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n${name}-RULE-v1`);
    await writeFile(path.join(dataDir, name, 'MEMORY.md'), `${name}-MEMORY-v1`);
  }
  await mkdir(path.join(dataDir, 'memory')); await writeFile(path.join(dataDir, 'memory/MEMORY.md'), 'extra-MEMORY-v1');
  const requests = [];
  let handle;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    const response = handle ? await handle(body) : { content: 'answer' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (response.tool) {
      chunk({ tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: response.tool }) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: response.content });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let runtime;
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) session.dispose();
    runtime?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, dataDir, requests, sessions,
    setHandler(value) { handle = value; },
    async runtime() {
      runtime = await createAgentRuntime({ fileTools: { enabled: false }, cwd: root, dataDir, resourcesDir: path.resolve('resources'), model: { apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'fixture' } });
      return runtime;
    },
  };
}

function systemText(body) { return body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n'); }
function userTexts(body) { return body.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('')); }

// This test observes actual HTTP requests produced by the installed SDK, not a mock hook.
test('each run injects the product skill and memory while UMS stays on demand; six-plus rounds and resume stay bounded', async t => {
  const f = await fixture(t);
  const runtime = await f.runtime();
  const session = await runtime.createSession();
  f.sessions.push(session);
  for (let n = 1; n <= 7; n++) {
    if (n === 3) {
      await writeFile(path.join(f.dataDir, 'urovo-product-expert', 'SKILL.md'), 'urovo-product-expert-RULE-v2');
      await writeFile(path.join(f.dataDir, 'urovo-product-expert', 'MEMORY.md'), 'urovo-product-expert-MEMORY-v2');
      await writeFile(path.join(f.dataDir, 'memory/MEMORY.md'), 'extra-MEMORY-v2');
    }
    await session.prompt(`question-${n}`);
    const body = f.requests.at(-1);
    const text = systemText(body);
    assert.equal(text.split('## Skill: ums-expert').length - 1, 0);
    assert.equal(text.split('## Skill: urovo-product-expert').length - 1, 1);
    assert.equal(text.split('## Extra agent memory\nSource:').length - 1, 1);
    assert.ok(text.includes(n >= 3 ? 'extra-MEMORY-v2' : 'extra-MEMORY-v1'));
    assert.ok(!text.includes('ums-expert-MEMORY-v1'));
    assert.ok(!text.includes('ums-expert-RULE-v1'));
    assert.ok(text.includes(n >= 3 ? 'urovo-product-expert-RULE-v2' : 'urovo-product-expert-RULE-v1'));
    assert.ok(text.includes(n >= 3 ? 'urovo-product-expert-MEMORY-v2' : 'urovo-product-expert-MEMORY-v1'));
    assert.deepEqual(userTexts(body), Array.from({ length: Math.min(n, 5) }, (_, i) => `question-${Math.max(1, n - 4) + i}`));
  }
  const file = session.sessionFile;
  const persisted = await readFile(file, 'utf8');
  assert.ok(persisted.includes('question-1'), 'disk history is independent from the context window');
  assert.ok(!persisted.includes('MEMORY-v'), 'injected knowledge must not accumulate in transcripts');
  session.dispose();
  const restored = await runtime.createSession(SessionManager.open(file, runtime.config.sessionsDir, f.root));
  f.sessions.push(restored);
  await restored.prompt('question-8');
  assert.deepEqual(userTexts(f.requests.at(-1)), ['question-4', 'question-5', 'question-6', 'question-7', 'question-8']);
  assert.equal(restored.autoCompactionEnabled, false);
});

test('tool steps retain matched calls/results and use one knowledge snapshot until next run', async t => {
  const f = await fixture(t);
  const runtime = await f.runtime();
  const session = await runtime.createSession();
  f.sessions.push(session);
  for (let n = 1; n <= 5; n++) await session.prompt(`old-${n}`);
  const source = path.join(f.root, 'reference.md');
  await writeFile(source, 'VERIFIED_REFERENCE');
  let toolSent = false;
  f.setHandler(async body => {
    if (!toolSent) {
      toolSent = true;
      await writeFile(path.join(f.dataDir, 'urovo-product-expert', 'MEMORY.md'), 'urovo-product-expert-MEMORY-v2');
      await writeFile(path.join(f.dataDir, 'memory/MEMORY.md'), 'extra-MEMORY-v2');
      return { tool: source };
    }
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.ok(JSON.stringify(body.messages.at(-1).content).includes('VERIFIED_REFERENCE'));
    return { content: 'tool-answer' };
  });
  const before = f.requests.length;
  await session.prompt('read-reference');
  assert.equal(f.requests.length - before, 2);
  for (const body of f.requests.slice(before)) {
    assert.deepEqual(userTexts(body), ['old-2', 'old-3', 'old-4', 'old-5', 'read-reference']);
    assert.ok(systemText(body).includes('urovo-product-expert-MEMORY-v1'));
    assert.ok(!systemText(body).includes('urovo-product-expert-MEMORY-v2'));
    assert.ok(systemText(body).includes('extra-MEMORY-v1')); assert.ok(!systemText(body).includes('extra-MEMORY-v2'));
  }
  f.setHandler(() => ({ content: 'done' }));
  await session.prompt('next');
  const body = f.requests.at(-1);
  assert.ok(systemText(body).includes('urovo-product-expert-MEMORY-v2'));
  assert.ok(systemText(body).includes('extra-MEMORY-v2'));
  const calls = body.messages.flatMap(m => m.tool_calls ?? []).map(c => c.id);
  const results = body.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id);
  assert.deepEqual(calls, results);
});

test('missing required resources fail before inference, and concurrent preflight is rejected', async t => {
  const f = await fixture(t);
  const runtime = await f.runtime();
  const session = await runtime.createSession();
  f.sessions.push(session);
  const first = session.prompt('one');
  await assert.rejects(session.prompt('two'), /already running/);
  await first;
  const count = f.requests.length;
  await rm(path.join(f.dataDir, 'urovo-product-expert', 'MEMORY.md'));
  await assert.rejects(session.prompt('missing-memory'), /ENOENT/);
  assert.equal(f.requests.length, count);
  await writeFile(path.join(f.dataDir, 'urovo-product-expert', 'MEMORY.md'), 'restored');
  await rm(path.join(f.dataDir, 'urovo-product-expert', 'SKILL.md'));
  await assert.rejects(session.prompt('missing-skill'), /ENOENT/);
  assert.equal(f.requests.length, count);
});

test('round pruning removes legacy summaries and keeps whole tool sequences', () => {
  const input = [
    { role: 'compactionSummary', summary: 'ancient' },
    { role: 'toolResult', toolCallId: 'orphan' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'x' }] },
    { role: 'toolResult', toolCallId: 'x' },
    { role: 'assistant', content: 'a-answer' },
    { role: 'branchSummary', summary: 'ancient-branch' },
    { role: 'user', content: 'b' },
  ];
  assert.deepEqual(recentRounds(input, 2), input.slice(2).filter(m => m.role !== 'branchSummary'));
  assert.deepEqual(recentRounds(input, 1), input.slice(-1));
  assert.deepEqual(recentRounds(input.slice(0, 2)), []);
});

test('retention deletes only expired SDK sessions, protects active runs and ignores symlinks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'session-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'sessions');
  await mkdir(directory);
  const retention = new SessionRetention(directory);
  const header = `${JSON.stringify({ type: 'session', id: 'fixture' })}\n`;
  const now = Date.now();
  const old = new Date(now - 31 * 86400000);
  for (const name of ['old.jsonl', 'fresh.jsonl', 'active.jsonl', 'unknown.jsonl', 'other.md']) {
    await writeFile(path.join(directory, name), name === 'unknown.jsonl' ? 'unrelated data' : header);
    if (name !== 'fresh.jsonl' && name !== 'active.jsonl') await utimes(path.join(directory, name), old, old);
  }
  const outside = path.join(root, 'outside.jsonl');
  await writeFile(outside, header);
  await utimes(outside, old, old);
  await symlink(outside, path.join(directory, 'linked.jsonl'));
  await symlink(root, path.join(directory, 'linked-dir'));
  const release = await retention.activate(path.join(directory, 'active.jsonl'));
  await utimes(path.join(directory, 'active.jsonl'), old, old);
  assert.deepEqual(await retention.cleanup(now), [path.join(directory, 'old.jsonl')]);
  for (const name of ['fresh.jsonl', 'active.jsonl', 'unknown.jsonl', 'other.md', 'linked.jsonl']) await stat(path.join(directory, name));
  await stat(outside);
  release();
  await assert.rejects(retention.activate(path.join(directory, 'active.jsonl')), /expired/);
  assert.deepEqual(await retention.cleanup(now), [path.join(directory, 'active.jsonl')]);
});

test('a loaded session cleaned after inactivity cannot silently recreate a broken transcript', async t => {
  const f = await fixture(t);
  const runtime = await f.runtime();
  const session = await runtime.createSession();
  f.sessions.push(session);
  await session.prompt('initial');
  const file = session.sessionFile;
  const old = new Date(Date.now() - 31 * 86400000);
  await utimes(file, old, old);
  assert.deepEqual(await runtime.cleanupSessions(), [file]);
  const count = f.requests.length;
  await assert.rejects(session.prompt('expired'), /cleaned up/);
  assert.equal(f.requests.length, count);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('startup cleans expired history, and live model/tool execution is protected during a sweep', async t => {
  const f = await fixture(t);
  const sessionsDir = path.join(f.dataDir, 'sessions');
  await mkdir(sessionsDir);
  const stale = path.join(sessionsDir, 'stale.jsonl');
  await writeFile(stale, `${JSON.stringify({ type: 'session', id: 'expired' })}\n`);
  const old = new Date(Date.now() - 31 * 86400000);
  await utimes(stale, old, old);
  const runtime = await f.runtime();
  await assert.rejects(stat(stale), { code: 'ENOENT' });
  const session = await runtime.createSession();
  f.sessions.push(session);
  await session.prompt('initial');
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  f.setHandler(async () => { entered(); await waiting; return { content: 'done' }; });
  const running = session.prompt('slow');
  await started;
  try {
    await utimes(session.sessionFile, old, old);
    assert.deepEqual(await runtime.cleanupSessions(), []);
    await stat(session.sessionFile);
  } finally { finish(); }
  await running;
  assert.ok((await stat(session.sessionFile)).mtimeMs > Date.now() - 60000);
});

test('independent sessions never share conversation history', async t => {
  const f = await fixture(t);
  const runtime = await f.runtime();
  const a = await runtime.createSession();
  const b = await runtime.createSession();
  f.sessions.push(a, b);
  await a.prompt('private-a');
  await b.prompt('private-b');
  assert.deepEqual(userTexts(f.requests.at(-1)), ['private-b']);
  await a.prompt('followup-a');
  assert.deepEqual(userTexts(f.requests.at(-1)), ['private-a', 'followup-a']);
});

test('UMS is discoverable and read on demand without loading its MEMORY, including restored sessions', async t=>{
 const f=await fixture(t);const skill=path.join(f.dataDir,'ums-expert/SKILL.md');const memory=path.join(f.dataDir,'ums-expert/MEMORY.md');
 await rm(memory);const runtime=await f.runtime();let session=await runtime.createSession();f.sessions.push(session);
 await session.prompt('A normal product question');let payload=f.requests.at(-1);assert.ok(systemText(payload).includes(skill));assert.ok(!JSON.stringify(payload).includes('ums-expert-RULE-v1'));assert.ok(systemText(payload).includes('urovo-product-expert-MEMORY-v1'));
 let requested=false;f.setHandler(body=>{if(!requested){requested=true;return{tool:skill};}assert.ok(JSON.stringify(body.messages.at(-1).content).includes('ums-expert-RULE-v1'));return{content:'UMS answer'};});
 await session.prompt('Read the UMS skill and explain UMS groups.');assert.equal(requested,true);assert.ok(!systemText(f.requests.at(-1)).includes('## Skill: ums-expert'));assert.ok(!JSON.stringify(f.requests.at(-1)).includes('ums-expert-MEMORY'));
 const file=session.sessionFile;session.dispose();session=await runtime.createSession(SessionManager.open(file,runtime.config.sessionsDir,f.root));f.sessions.push(session);f.setHandler(()=>({content:'restored answer'}));await session.prompt('A follow-up question');assert.ok(systemText(f.requests.at(-1)).includes(skill));assert.ok(!systemText(f.requests.at(-1)).includes('ums-expert-RULE-v1'));
});
test('missing UMS deployment does not block startup or ordinary runs',async t=>{
 const f=await fixture(t);await rm(path.join(f.dataDir,'ums-expert'),{recursive:true});const runtime=await f.runtime();const session=await runtime.createSession();f.sessions.push(session);await session.prompt('product only');assert.ok(!systemText(f.requests.at(-1)).includes('<name>ums-expert</name>'));assert.ok(systemText(f.requests.at(-1)).includes('urovo-product-expert-MEMORY-v1'));
});
