import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

class Target {
  constructor() { this.events = new Map(); }
  addEventListener(type, callback) { const list = this.events.get(type) ?? []; list.push(callback); this.events.set(type, list); }
  async emit(type, extra = {}) { for (const callback of this.events.get(type) ?? []) await callback({ preventDefault() {}, ...extra }); }
}
class Element extends Target {
  constructor() {
    super(); this.children = []; this.dataset = {}; this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.className = ''; this._top = 0;
    const classes = new Set(); this.classList = { add: (...values) => values.forEach(v => classes.add(v)), remove: (...values) => values.forEach(v => classes.delete(v)), toggle: (v, on) => { if (on ?? !classes.has(v)) classes.add(v); else classes.delete(v); }, contains: v => classes.has(v) };
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, next) { node.remove(); const at = next ? this.children.indexOf(next) : this.children.length; this.children.splice(at, 0, node); node.parentNode = this; }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  remove() { if (this.parentNode) { const list = this.parentNode.children; list.splice(list.indexOf(this), 1); this.parentNode = null; } }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return Boolean(this.parentNode); }
  closest(selector) { return selector === '.message' && this.className.split(' ').includes('message') ? this : this.parentNode?.closest(selector); }
  getBoundingClientRect() {
    if (this.className.split(' ').includes('message')) {
      const top = this.parentNode.children.indexOf(this) * 100 - this.scrollContainer.scrollTop;
      return { top, bottom: top + 100 };
    }
    return { top: 0, bottom: 400 };
  }
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
  setAttribute() {}
  focus() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
}
const messages = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => ({ id: `m${start + i}`, role: (start + i) % 2 ? 'user' : 'assistant', text: `Message ${start + i}`, timestamp: start + i, toolCallCount: 0 }));
const response = (items, nextCursor = null) => ({ title: 'Conversation', messages: items, files: [], runs: [], rounds: 100, page: { hasMore: nextCursor !== null, nextCursor } });
async function fixture() {
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = new Target(); Object.assign(document, { body: new Element(), documentElement: new Element(), getElementById: get, createElement: () => { const node = new Element(); node.scrollContainer = get('chat-scroll'); return node; }, querySelectorAll: () => [], querySelector: () => null });
  const window = new Target(); Object.assign(window, { matchMedia: () => new Target(), location: { replace() {} } });
  const storage = new Map(), requests = []; let handler = () => response([]);
  Object.defineProperty(get('chat-scroll'), 'scrollHeight', { get: () => get('messages').children.length * 100 });
  Object.defineProperty(get('chat-scroll'), 'clientHeight', { value: 400 });
  const context = vm.createContext({ document, window, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, location: { search: '' }, navigator: { clipboard: {} }, AbortController, URLSearchParams, TextDecoder, performance, crypto: { randomUUID }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, marked: { parse: value => value }, DOMPurify: { sanitize: value => value }, fetch: async (url, init = {}) => {
    requests.push({ url, init }); if (url === '/api/status') return new Promise(() => {});
    const result = await handler(url, init); return result instanceof Response ? result : Response.json(result);
  } });
  vm.runInContext(await fs.readFile('resources/web/app.js', 'utf8'), context);
  vm.runInContext("state.status = { configured: true, fileTools: { enabled: false, tools: [] } }; state.token = 'fixture';", context);
  return { get, requests, setHandler(fn) { handler = fn; }, call: code => vm.runInContext(code, context), state: () => JSON.parse(vm.runInContext('JSON.stringify(state)', context)) };
}

test('opening requests only the latest page and prepending preserves both the visible row and old DOM', async () => {
  const f = await fixture(); f.setHandler(url => url.includes('before=') ? response(messages(41, 70), 'older') : response(messages(71, 100), 'before71'));
  await f.call("openSession('session-a')");
  assert.equal(f.requests.filter(r => r.url !== '/api/status').length, 1); assert.match(f.requests.at(-1).url, /\/history\?limit=30$/);
  assert.equal(f.get('messages').children.length, 30); assert.equal(f.get('chat-scroll').scrollTop, f.get('chat-scroll').scrollHeight);
  const first = f.get('messages').children[0]; f.get('chat-scroll').scrollTop = 50;
  const before = first.getBoundingClientRect().top;
  await f.call('loadOlderHistory()');
  assert.equal(f.get('messages').children.length, 60); assert.equal(f.get('messages').children[30], first);
  assert.equal(first.getBoundingClientRect().top, before);
});

test('navigation aborts stale loads, clears old content and only applies the most recent response', async () => {
  const f = await fixture(); let finishA, signalA;
  f.setHandler((url, init) => url.includes('session-a') ? new Promise(resolve => { finishA = resolve; signalA = init.signal; }) : response(messages(1, 2)));
  const a = f.call("openSession('session-a')"); await Promise.resolve();
  await f.call("openSession('session-b')"); assert.equal(signalA.aborted, true);
  finishA(response(messages(90, 100))); await a;
  assert.equal(f.state().current, 'session-b'); assert.equal(f.get('messages').children.length, 2);
  f.setHandler(() => Response.json({ error: 'Unavailable' }, { status: 503 }));
  await f.call("openSession('session-c')");
  assert.equal(f.get('messages').children.length, 0); assert.equal(f.get('send').disabled, true); assert.equal(f.get('history-retry').hidden, false);
  f.setHandler(() => response(messages(3, 4))); await f.get('history-retry').emit('click');
  assert.equal(f.get('send').disabled, false); assert.equal(f.get('messages').children.length, 2);
});

test('pagination failures retain messages and cursor; retry fetches the same page once', async () => {
  const f = await fixture(); let attempts = 0;
  f.setHandler(url => {
    if (!url.includes('before=')) return response(messages(31, 60), 'before31');
    attempts++; if (attempts === 1) return Response.json({ error: 'Try again' }, { status: 503 });
    return response(messages(1, 30));
  });
  await f.call("openSession('session-a')"); await f.call('loadOlderHistory()');
  assert.equal(f.get('messages').children.length, 30); assert.equal(f.state().history.page.nextCursor, 'before31');
  assert.equal(f.get('history-retry').hidden, false); await f.get('history-retry').emit('click');
  assert.equal(f.get('messages').children.length, 60); assert.equal(f.state().history.page.hasMore, false);
  assert.equal(attempts, 2); assert.equal(new Set(f.requests.filter(r => r.url.includes('before=')).map(r => r.url)).size, 1);
});

test('a late older-page response cannot prepend into another session or a new chat', async () => {
  const f = await fixture(); let finish, signal;
  f.setHandler((url, init) => url.includes('before=') ? new Promise(resolve => { finish = resolve; signal = init.signal; }) : response(messages(31, 60), 'before31'));
  await f.call("openSession('session-a')"); const older = f.call('loadOlderHistory()');
  f.call('newChat()'); assert.equal(signal.aborted, true);
  finish(response(messages(1, 30))); await older;
  assert.equal(f.state().current, null); assert.equal(f.get('messages').children.length, 0);
});

test('concurrent older-page triggers share one load, and an obsolete cursor offers reopening', async () => {
  const f = await fixture(); let finish, calls = 0;
  f.setHandler(url => {
    if (!url.includes('before=')) return response(messages(31, 60), 'before31');
    calls++; return new Promise(resolve => { finish = resolve; });
  });
  await f.call("openSession('session-a')"); const pending = f.call('loadOlderHistory()');
  await f.call('loadOlderHistory()'); assert.equal(calls, 1);
  finish(Response.json({ error: 'History changed. Reopen the conversation.' }, { status: 409 })); await pending;
  assert.equal(f.get('messages').children.length, 30); assert.equal(f.get('history-retry').textContent, 'Reopen conversation');
  await f.get('history-retry').emit('click'); assert.equal(f.state().history.error, '');
});

test('completion merges by ID without rebuilding unchanged history, bridges multi-page runs and preserves reading position', async () => {
  const f = await fixture(); f.setHandler(url => url.includes('before=81') ? response(messages(51, 80), '51') : url.includes('before=51') ? response(messages(21, 50), '21') : response(messages(1, 40)));
  await f.call("openSession('session-a')");
  const retained = f.get('messages').children[10]; f.get('chat-scroll').scrollTop = 1050;
  const top = retained.getBoundingClientRect().top;
  f.contextData = response(messages(81, 110), '81');
  f.call('globalThis.latest = ' + JSON.stringify(f.contextData)); await f.call('mergeLatestHistory(latest)');
  assert.equal(f.get('messages').children.length, 110); assert.equal(f.get('messages').children[10], retained);
  assert.equal(retained.getBoundingClientRect().top, top);
  assert.deepEqual(f.state().history.messages.map(message => message.id), messages(1, 110).map(message => message.id));
});
