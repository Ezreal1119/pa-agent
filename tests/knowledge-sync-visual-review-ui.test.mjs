import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.dataset = {}; this.textContent = ''; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  setAttribute(key, value) { this[key] = value; }
  focus() { this.document.activeElement = this; }
  set innerHTML(_) { throw Error('Render evidence as text'); }
}
const all = node => [node, ...node.children.flatMap(all)];
async function fixture() {
  const document = { activeElement: null }, nodes = new Map(), requests = [];
  document.createElement = tag => new Element(tag, document);
  document.createTextNode = text => Object.assign(new Element('text', document), { textContent: text });
  document.getElementById = id => { if (!nodes.has(id)) nodes.set(id, new Element('div', document)); return nodes.get(id); };
  const sandbox = vm.createContext({ document, location: { hash: '', search: '' }, URLSearchParams, File: class {},
    fetch: async (url, options) => { requests.push({ url, body: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => options.method === 'GET' ? { text: 'Readable <script>evidence</script>' } : { id: 'next' } }; } });
  const source = await fs.readFile('resources/web/synchronize.js', 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('async function refresh()')) + '\nasync function refresh() {}\nchoose = async () => {}; globalThis.render = renderJob;', sandbox);
  const usage = { input: 0, output: 0, requests: 0, recorded: 0 };
  const item = { id: 'item', name: 'source.png', status: 'needs_review', stage: 'Needs your decision', feedback: '', textUsage: usage, visualUsage: usage,
    visualReview: { sourceHash: 'source', revision: 'revision', issues: [{ id: 'issue', file: 'image-0.png', imageHash: 'pixels', label: 'Page 11, region x=121 y=0', issues: ['Small text <script>unsafe()</script> is illegible.'] }] } };
  const job = { id: 'job', kind: 'sync', status: 'completed', created: '2026-10-26T01:00:00Z', items: [item] };
  const elements = () => all(nodes.get('report'));
  const find = text => elements().find(n => n.textContent === text);
  await sandbox.render(job);
  return { sandbox, document, requests, item, job, elements, find };
}

test('visual acceptance is unselected, explicit and produces a bound review request; image/text are lazy', async () => {
  const f = await fixture(); const next = f.find('Continue to publication preview →');
  assert.equal(next.disabled, true); assert.equal(f.requests.length, 0);
  assert.equal(f.find('Re-Sync →'), undefined);
  assert(f.find('Small text <script>unsafe()</script> is illegible.'));
  const detail = f.elements().find(n => n.tagName === 'DETAILS' && n.children[0]?.textContent === 'Inspect image and readable text');
  detail.open = true; detail.ontoggle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1); assert.match(f.requests[0].url, /visual-issues\/issue$/);
  assert(f.find('Readable <script>evidence</script>'));
  assert.match(f.elements().find(n => n.tagName === 'IMG').src, /visual-issues\/issue\/image$/);
  const radio = f.elements().find(n => n.tagName === 'INPUT' && n.value === 'accept');
  radio.checked = true; radio.onchange(); assert.equal(next.disabled, false); assert.equal(f.requests.length, 1);
  await next.onclick();
  assert.deepEqual(f.requests[1], { url: '/api/sync/jobs/job/resync?view=summary', body: { itemId: 'item', feedback: '', forceConvert: false,
    visualReview: { revision: 'revision', decisions: [{ issueId: 'issue', action: 'accept' }] } } });
});

test('supplement requires nonempty text, survives polling and stays attributed; retry never implies accepting', async () => {
  const f = await fixture(); let radio = f.elements().find(n => n.value === 'supplement');
  radio.checked = true; radio.onchange(); let next = f.find('Continue to publication preview →');
  assert.equal(next.disabled, true);
  let input = f.elements().find(n => n.tagName === 'TEXTAREA'); input.value = 'Correct batch 17'; input.oninput();
  assert.equal(next.disabled, false); assert.equal(f.requests.length, 0);
  f.item.reason = 'Polling refresh'; await f.sandbox.render(f.job);
  input = f.elements().find(n => n.tagName === 'TEXTAREA'); assert.equal(input.value, 'Correct batch 17');
  assert(f.elements().find(n => n.value === 'supplement').checked);
  await f.find('Continue to publication preview →').onclick();
  assert.deepEqual(f.requests[0].body.visualReview.decisions, [{ issueId: 'issue', action: 'supplement', text: 'Correct batch 17' }]);
  const retry = await fixture(); await retry.find('Retry this region').onclick();
  assert.deepEqual(retry.requests[0].body.visualReview.decisions, [{ issueId: 'issue', action: 'retry' }]);
});


test('a decision draft never preselects another report attempt with the same source issue', async () => {
  const f = await fixture(); const radio = f.elements().find(n => n.value === 'accept');
  radio.checked = true; radio.onchange();
  f.item.id = 'another-attempt'; await f.sandbox.render(f.job);
  assert.equal(f.elements().find(n => n.value === 'accept').checked, false);
  assert.equal(f.find('Continue to publication preview →').disabled, true);
});
