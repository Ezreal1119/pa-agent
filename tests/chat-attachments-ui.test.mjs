import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

class Target {
  constructor() { this.events = new Map(); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(fn); }
  async emit(type, fields = {}) {
    const event = Object.assign({ target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, fields);
    for (const handler of this.events.get(type) || []) await handler(event);
    return event;
  }
}
class Element extends Target {
  constructor() {
    super(); this.children = []; this.value = ''; this.textContent = ''; this.files = []; this.dataset = {}; this.style = {}; this.hidden = false; this.submits = 0;
    const names = new Set(); this.classList = { add: (...items) => items.forEach(x => names.add(x)), remove: (...items) => items.forEach(x => names.delete(x)), contains: x => names.has(x), toggle: (x, on) => { if (on ?? !names.has(x)) names.add(x); else names.delete(x); } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
  setAttribute() {}
  focus() { this.focused = true; }
  requestSubmit() { this.submits++; }
  click() { this.clicked = true; }
}
const until = async check => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error('wait timeout'); await new Promise(r => setTimeout(r, 2)); } };
const pdf = name => new File(['fixture'], name, { type: 'application/pdf' });
const transfer = files => ({ types: ['Files'], files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })) });
async function fixture() {
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = new Target(); Object.assign(document, { body: new Element(), documentElement: new Element(), getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], querySelector: () => null });
  const window = new Target(); Object.assign(window, { matchMedia: () => new Target(), location: { replace() {} } });
  const storage = new Map(), requests = [], files = new Map(); let hook;
  const context = vm.createContext({ document, window, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, location: { search: '' }, navigator: { clipboard: {} }, File, AbortController, URLSearchParams, TextDecoder, performance, crypto: { randomUUID }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      if (url === '/api/status') return new Promise(() => {}); // Keep initial app boot isolated from the events under test.
      const custom = await hook?.(url, init); if (custom) return custom;
      if (url === '/api/sessions' && init.method === 'POST') return Response.json({ id: 'session-new' });
      if (url === '/api/sessions') return Response.json({ sessions: [] });
      const match = url.match(/^\/api\/sessions\/([^/]+)\/files(?:\?name=(.+))?$/);
      if (match) {
        const list = files.get(match[1]) || []; files.set(match[1], list);
        if (init.method === 'POST') { const file = { id: randomUUID(), name: decodeURIComponent(match[2]), bytes: init.body.size, direction: 'inputs' }; list.push(file); return Response.json({ file }); }
        return Response.json({ files: list });
      }
      throw Error('Unexpected request ' + url);
    } });
  get('composer-area').append(get('composer')); get('composer').append(get('question'), get('file-drop-hint'));
  get('file-input').accept = '.pdf,.png,.jpg,.jpeg,.webp,.txt';
  await vm.runInContext(await fs.readFile('resources/web/app.js', 'utf8'), context);
  const patch = value => { context.patch = value; vm.runInContext('Object.assign(state, patch)', context); };
  patch({ token: 'csrf-fixture', status: { configured: true, fileTools: { enabled: true, tools: ['pdf_read', 'image_read'], maxFileBytes: 100, acceptedExtensions: ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt'] } } });
  return { get, context, document, window, requests, storage, patch, setHook(fn) { hook = fn; }, state: () => JSON.parse(vm.runInContext('JSON.stringify(state)', context)), call: code => vm.runInContext(code, context), uploads: () => requests.filter(r => r.init.method === 'POST' && r.url.includes('/files?')) };
}

test('picker, drop and paste share one authenticated binary upload flow and prepare attachments without sending', async () => {
  for (const method of ['picker', 'drop', 'paste']) {
    const f = await fixture(), file = pdf('测试 specification.pdf'); f.get('question').value = 'Keep this draft';
    let event;
    if (method === 'picker') { f.get('file-input').files = [file]; await f.get('file-input').emit('change'); assert.equal(f.get('file-input').value, ''); }
    else if (method === 'drop') event = await f.get('composer-area').emit('drop', { dataTransfer: transfer([file]) });
    else event = await f.get('question').emit('paste', { clipboardData: transfer([file]) });
    if (event) assert.equal(event.defaultPrevented, true);
    assert.equal(f.uploads().length, 1, 'FileList and clipboard items must not duplicate the same payload');
    const sent = f.uploads()[0]; assert.equal(sent.init.headers['X-Local-Token'], 'csrf-fixture'); assert.equal(sent.init.headers['Content-Type'], 'application/octet-stream'); assert.equal(sent.init.body, file);
    assert.match(sent.url, /^\/api\/sessions\/session-new\/files\?name=/); assert.ok(sent.url.includes(encodeURIComponent(file.name)));
    assert.equal(f.state().pendingIds.length, 1); assert.equal(f.get('attachment-list').children.length, 1);
    assert.equal(f.get('question').value, 'Keep this draft'); assert.equal(f.get('composer').submits, 0); assert.ok(!f.requests.some(r => r.url.endsWith('/run')));
    assert.deepEqual(JSON.parse(f.storage.get('product-expert-pending-session-new')), f.state().pendingIds);
  }
});

test('plain text, HTML and copied paths keep native paste/drop behavior and other fields are unaffected', async () => {
  const f = await fixture(); f.get('question').value = 'draft';
  for (const types of [['text/plain'], ['text/plain', 'text/html'], ['text/uri-list']]) {
    const event = await f.get('question').emit('paste', { clipboardData: { types, files: [], items: [{ kind: 'string' }] } }); assert.equal(event.defaultPrevented, false);
    const drag = await f.get('composer-area').emit('drop', { dataTransfer: { types, files: [] } }); assert.equal(drag.defaultPrevented, false);
  }
  assert.equal(f.document.events.has('paste'), false); assert.equal(f.get('settings-form').events.has('paste'), false);
  assert.equal(f.get('question').value, 'draft'); assert.equal(f.uploads().length, 0);
});

test('clipboard item fallback attaches a screenshot with a usable name and preserves bytes and MIME type', async () => {
  const f = await fixture(), image = new File(['png-fixture'], '', { type: 'image/png' });
  const event = await f.get('question').emit('paste', { clipboardData: { types: [], files: [], items: [{ kind: 'file', getAsFile: () => image }] } });
  assert.equal(event.defaultPrevented, true); assert.equal(f.uploads().length, 1);
  const upload = f.uploads()[0]; assert.match(decodeURIComponent(upload.url), /clipboard-\d+-1\.png$/); assert.equal(upload.init.body.type, 'image/png'); assert.equal(await upload.init.body.text(), 'png-fixture');
});

test('unsupported files, oversized files, directories and attachment overflow are rejected before starting an upload', async () => {
  for (const mode of ['type', 'size', 'directory', 'count']) {
    const f = await fixture(); let data;
    if (mode === 'type') data = transfer([pdf('good.pdf'), new File(['zip'], 'archive.zip')]);
    if (mode === 'size') data = transfer([pdf('good.pdf'), new File(['x'.repeat(101)], 'large.pdf')]);
    if (mode === 'directory') data = { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => null }] };
    if (mode === 'count') { f.patch({ pendingIds: Array.from({ length: 20 }, (_, i) => String(i)) }); data = transfer([pdf('extra.pdf')]); }
    const event = await f.get('composer-area').emit('drop', { dataTransfer: data }); assert.equal(event.defaultPrevented, true);
    assert.equal(f.uploads().length, 0); assert.ok(!f.requests.some(r => r.init.method === 'POST')); assert.equal(f.state().busy, false);
    assert.match(f.get('run-note').textContent + f.get('toast').textContent, /unsupported|size limit|Folders|20 files/);
  }
});

test('disabled, busy or unreadable file payloads cannot start an upload or navigate away', async () => {
  for (const mode of ['disabled', 'busy', 'unreadable']) {
    const f = await fixture(); if (mode === 'disabled') f.patch({ status: { fileTools: { enabled: false, tools: [] } } }); if (mode === 'busy') f.patch({ busy: true });
    const data = mode === 'unreadable' ? { types: ['Files'], items: [{ kind: 'file', getAsFile: () => null }], files: [] } : transfer([pdf('file.pdf')]);
    const event = await f.get('question').emit('paste', { clipboardData: data }); assert.equal(event.defaultPrevented, true); assert.equal(f.uploads().length, 0);
    assert.match(f.get('toast').textContent, /unavailable|Wait|could not read/);
  }
});

test('file drag highlight survives nested targets, clears on exit/cancel, and outside drops are blocked', async () => {
  const f = await fixture(), area = f.get('composer-area'), data = transfer([pdf('file.pdf')]);
  await area.emit('dragenter', { dataTransfer: data }); await area.emit('dragenter', { dataTransfer: data }); assert.equal(f.get('composer').classList.contains('file-drag-over'), true);
  await area.emit('dragleave'); assert.equal(f.get('file-drop-hint').hidden, false); await area.emit('dragleave'); assert.equal(f.get('file-drop-hint').hidden, true);
  await area.emit('dragenter', { dataTransfer: data }); await f.window.emit('blur'); assert.equal(f.get('file-drop-hint').hidden, true);
  await area.emit('dragenter', { dataTransfer: data }); await f.document.emit('keydown', { key: 'Escape' }); assert.equal(f.get('file-drop-hint').hidden, true);
  const outside = await f.document.emit('drop', { dataTransfer: data, target: new Element() }); assert.equal(outside.defaultPrevented, true); assert.equal(f.uploads().length, 0);
  assert.match(f.get('toast').textContent, /message box/);
  f.patch({ busy: true }); await area.emit('dragenter', { dataTransfer: data }); assert.equal(f.get('file-drop-hint').hidden, true); await area.emit('dragover', { dataTransfer: data }); assert.equal(data.dropEffect, 'none');
});

test('cancellation or a later upload failure keeps successful pending files and blocks concurrent changes', async () => {
  for (const mode of ['cancel', 'fail']) {
    const f = await fixture(); f.patch({ current: 'session-a' }); let second;
    f.setHook(async (url, init) => {
      if (init.method === 'POST' && url.includes('second.pdf')) {
        second = init;
        return new Promise((resolve, reject) => { second.fail = () => resolve(Response.json({ error: 'Upload failed' }, { status: 503 })); init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); });
      }
    });
    const uploading = f.get('composer-area').emit('drop', { dataTransfer: transfer([pdf('first.pdf'), pdf('second.pdf')]) });
    await until(() => second && f.state().pendingIds.length === 1); assert.equal(f.get('question').disabled, true);
    await f.get('question').emit('paste', { clipboardData: transfer([pdf('concurrent.pdf')]) }); assert.equal(f.uploads().length, 2);
    f.call('newChat()'); assert.equal(f.state().current, 'session-a');
    if (mode === 'cancel') await f.get('stop').emit('click'); else second.fail();
    await uploading; assert.equal(f.state().busy, false); assert.equal(f.get('question').disabled, false); assert.equal(f.state().pendingIds.length, 1); assert.equal(f.state().files.length, 1);
    assert.equal(f.state().files[0].name, 'first.pdf'); assert.match(f.get('run-note').textContent, /cancelled|Upload failed/);
  }
});

test('a late session navigation response cannot move dropped files to another conversation', async () => {
  const f = await fixture(); f.patch({ current: 'session-a' }); let resolveNavigation;
  f.setHook(url => { if (url === '/api/sessions/session-b') return new Promise(resolve => { resolveNavigation = resolve; }); });
  const opening = f.call("openSession('session-b')"); await until(() => resolveNavigation);
  await f.get('composer-area').emit('drop', { dataTransfer: transfer([pdf('right-session.pdf')]) });
  resolveNavigation(Response.json({ title: 'Wrong session', messages: [], files: [], rounds: 0, runs: [] })); await opening;
  assert.equal(f.state().current, 'session-a'); assert.match(f.uploads()[0].url, /sessions\/session-a\/files/); assert.equal(f.state().pendingIds.length, 1);
});
