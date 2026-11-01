import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WecomContacts, groupId } from '../dist/web/wecom-contacts.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-groups-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'wecom/contacts.json'), book: new WecomContacts(root) };
}
const at = Date.now();
const who = (userId = 'alice', botId = 'bot', chatId = 'group') => ({ botId, userId, chatType: 'group', chatId, at });
const run = (sequence = 1, input = 100, status = 'completed') => ({ id: `run-${sequence}`, sequence, startedAt: new Date(at).toISOString(), status, usage: { input, output: 10, requests: 1, reportedRequests: 1 } });

test('old memberships and group conversation mappings become separate cards without altering names or personal totals', async t => {
  const f = await fixture(t); const contact = await f.book.record(who()); await f.book.rename(contact.id, { name: 'Alice' });
  await f.book.recordRun(who(), 'session-one', run());
  const old = JSON.parse(await fs.readFile(f.file, 'utf8')); delete old.groups; delete old.groupCursors;
  await fs.writeFile(f.file, JSON.stringify(old));
  const mapping = { conversations: { [JSON.stringify(['bot', 'group', 'legacy-group'])]: { sessionId: 'legacy-session', updated: at } }, jobs: [] };
  const mappingFile = path.join(f.root, 'wecom/bridge-state.json'); await fs.writeFile(mappingFile, JSON.stringify(mapping));
  const book = new WecomContacts(f.root), entries = await book.entries();
  assert.equal(entries.contacts.length, 1); assert.equal(entries.contacts[0].name, 'Alice'); assert.deepEqual(entries.contacts[0].stats, old.contacts[0].stats);
  assert.deepEqual(new Set(entries.groups.map(g => g.chatId)), new Set(['group', 'legacy-group']));
  assert.ok(entries.groups.every(g => !g.stats));
  assert.equal(await fs.readFile(mappingFile, 'utf8'), JSON.stringify(mapping));
  const existingGroup = entries.groups.find(g => g.chatId === 'group'); await book.renameGroup(existingGroup.id, { name: 'Support group' });
  const next = await new WecomContacts(f.root).entries(); assert.equal(next.groups.find(g => g.id === existingGroup.id).name, 'Support group'); assert.equal(next.contacts[0].name, 'Alice');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('group usage combines members, isolates bots and groups, and survives duplicate, stale and restarted snapshots', async t => {
  const f = await fixture(t); await f.book.recordRun(who(), 'session-one', run(1, 20, 'running'));
  await f.book.recordRun(who(), 'session-one', run()); await f.book.recordRun(who(), 'session-one', run());
  await f.book.recordRun(who('bob'), 'session-one', run(2, 200));
  const book = new WecomContacts(f.root); await book.recordRun(who(), 'session-one', run(1, 20, 'running'));
  await book.recordRun(who('alice', 'other-bot'), 'session-other-bot', run());
  await book.recordRun(who('alice', 'bot', 'other-group'), 'session-other-group', run());
  const entries = await book.entries(), group = entries.groups.find(g => g.botId === 'bot' && g.chatId === 'group');
  assert.equal(group.stats.questions, 2); assert.equal(group.stats.inputTokens, 300); assert.equal(group.stats.outputTokens, 20); assert.equal(group.stats.finishedRuns, 2);
  assert.equal(entries.groups.length, 3);
  assert.equal(entries.contacts.reduce((n, c) => n + c.stats.questions, 0), 4);
  assert.equal(entries.contacts.reduce((n, c) => n + c.stats.inputTokens, 0), 500);
  await assert.rejects(book.recordRun(who('alice', 'bot', 'other-group'), 'session-one', run(2)), /conflicts/);
  assert.equal((await book.listGroups()).find(g => g.id === group.id).stats.questions, 2);
});

test('original run history backfills group usage independently without recounting existing personal totals', async t => {
  const f = await fixture(t), runs = [{ ...run(), wecom: who() }, { ...run(2, 200), wecom: who('bob') }];
  await f.book.recoverSession('session-one', runs);
  const old = JSON.parse(await fs.readFile(f.file, 'utf8')); delete old.groups; delete old.groupCursors; await fs.writeFile(f.file, JSON.stringify(old));
  const book = new WecomContacts(f.root); await book.recoverSession('session-one', runs); await book.recoverSession('session-one', runs);
  const entries = await book.entries(); assert.deepEqual(entries.contacts.map(c => c.stats), old.contacts.map(c => c.stats));
  assert.equal(entries.groups[0].stats.questions, 2); assert.equal(entries.groups[0].stats.inputTokens, 300);
});

test('group names are scoped separately from people and override only default conversation titles', async t => {
  const f = await fixture(t); await f.book.record(who('same-id', 'bot', 'same-id'));
  const contact = (await f.book.list())[0], group = (await f.book.listGroups())[0]; assert.notEqual(contact.id, group.id);
  await f.book.rename(contact.id, { name: 'Person' }); await f.book.renameGroup(group.id, { name: 'Group name' });
  await f.book.recordRun(who('same-id', 'bot', 'same-id'), 'group-session', run());
  await f.book.recordRun({ botId: 'bot', userId: 'same-id', chatType: 'single', at }, 'private-session', run());
  const titles = await f.book.sessionTitles(['group-session', 'private-session']);
  assert.deepEqual(titles.get('group-session'), { title: '企微 · 群 same-id', displayTitle: '企微 · 群 Group name' });
  assert.deepEqual(titles.get('private-session'), { title: '企微 · same-id', displayTitle: '企微 · Person' });
  assert.throws(() => f.book.renameGroup(group.id, { name: 'bad\nname' }), /Display names/);
  assert.equal(await f.book.renameGroup('f'.repeat(64), { name: 'missing' }), undefined);
});

test('invalid group storage is retained rather than silently resetting personal data', async t => {
  const f = await fixture(t); await f.book.record(who()); const data = JSON.parse(await fs.readFile(f.file, 'utf8'));
  data.groups[0].id = 'forged'; const raw = JSON.stringify(data); await fs.writeFile(f.file, raw);
  await assert.rejects(f.book.entries(), /Invalid WeCom group data/); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
});

class Element {
  constructor() { this.children = []; this.dataset = {}; this.value = ''; this.textContent = ''; this.events = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute() {}
  set innerHTML(_) { throw Error('Untrusted names must be rendered as text.'); }
}
test('contact page renders independent searchable cards, edits each kind, and counts the overview once', async () => {
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const stats = { questions: 1, inputTokens: 100, outputTokens: 10, requests: 1, reportedRequests: 1, finishedRuns: 1, since: at };
  const contacts = [{ id: 'c', name: 'Alice', userId: 'alice', botId: 'bot', types: ['group'], lastSeen: at, stats }];
  const groups = [{ id: groupId('bot', 'chat-id'), name: '<script>Group</script>', chatId: 'chat-id', botId: 'bot', lastSeen: at, stats }];
  const calls = [];
  const context = vm.createContext({ document: { getElementById: get, createElement: () => new Element() }, setTimeout: () => 0, clearTimeout() {}, location: { assign() { throw Error('Unexpected login redirect'); } }, fetch: async (route, init = {}) => {
    calls.push({ route, init });
    if (route === '/api/auth/status') return Response.json({ authenticated: true, token: 'csrf' });
    if (init.method === 'PATCH') { const name = JSON.parse(init.body).name; return Response.json(route.includes('groups') ? { group: { ...groups[0], name } } : { contact: { ...contacts[0], name } }); }
    return Response.json({ contacts, groups });
  } });
  vm.runInContext(await fs.readFile('resources/web/contacts.js', 'utf8'), context);
  for (let i = 0; i < 100 && get('contacts-list').children.length !== 2; i++) await new Promise(r => setTimeout(r, 2));
  const cards = get('contacts-list').children; assert.equal(cards.length, 2); assert.deepEqual(new Set(cards.map(c => c.dataset.kind)), new Set(['contact', 'group']));
  assert.equal(get('contacts-summary').children[2].children[1].textContent, '1'); assert.equal(get('contacts-summary').children[3].children[1].textContent, '110');
  const group = cards.find(c => c.dataset.kind === 'group'); assert.equal(group.children[0].children[1].textContent, '<script>Group</script>');
  group.children[2].children[1].value = 'Renamed group'; await group.events.submit({ preventDefault() {} });
  assert.ok(calls.some(c => c.route === `/api/wecom-groups/${groups[0].id}` && c.init.method === 'PATCH'));
  get('contacts-search').value = 'chat-id'; get('contacts-search').events.input(); assert.equal(get('contacts-list').children.length, 1); assert.equal(get('contacts-list').children[0].dataset.kind, 'group');
  get('contacts-search').value = 'Renamed'; get('contacts-search').events.input(); assert.equal(get('contacts-list').children.length, 1);
  get('contacts-search').value = 'alice'; get('contacts-search').events.input(); const person = get('contacts-list').children[0]; assert.equal(person.dataset.kind, 'contact');
  person.children[2].children[1].value = 'Person name'; await person.events.submit({ preventDefault() {} }); assert.ok(calls.some(c => c.route === '/api/wecom-contacts/c' && c.init.method === 'PATCH'));
});
