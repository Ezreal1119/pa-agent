import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExtraMemoryStore, extraMemoryContext } from '../dist/agent/extra-memory.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'extra-memory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['ums-expert', 'urovo-product-expert']) { await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'MEMORY.md'), `UNTOUCHABLE_${name}`); }
  return { root, store: new ExtraMemoryStore(root) };
}

test('fixed-file add/edit/delete preserve format, creation metadata, backups and both skill memories', async t => {
  const {root, store} = await fixture(t);
  const empty = await store.snapshot(); assert.equal(empty.text, ''); await assert.rejects(stat(store.file), {code:'ENOENT'});
  const added = await store.change({action:'add', expected_revision:empty.revision, content:'需要记住的内容\n\n- 支持 Markdown', kind:'preference'});
  assert.match(added.id, /^mem_[a-f0-9]{16}$/); assert.equal(added.entry.email, 'unknown@email.com'); assert.match(added.entry.created, /\+08:00$/);
  const original = await readFile(store.file,'utf8'); assert.ok(original.startsWith('# Skill Memories\n\n## Memory mem_')); assert.ok(original.includes('- Created-By-Email: unknown@email.com'));
  assert.equal(await readFile(added.backup,'utf8'),''); assert.equal((await stat(store.file)).mode & 0o777,0o600);
  const edited = await store.change({action:'edit', id:added.id, expected_revision:added.revision, content:'更正后的内容', kind:'correction'});
  assert.equal(edited.entry.id,added.id); assert.equal(edited.entry.created,added.entry.created); assert.ok(Date.parse(edited.entry.updated)>Date.parse(added.entry.updated));
  assert.equal(await readFile(edited.backup,'utf8'),original);
  const deleted = await store.change({action:'delete', id:added.id, expected_revision:edited.revision});
  assert.equal((await store.snapshot()).text.trim(),'# Skill Memories'); assert.ok(!(await readFile(store.file,'utf8')).includes('## Memory'));
  assert.equal((await readdir(path.join(root,'maintenance-backups/extra-memory'))).length,3);
  assert.ok(deleted.revision);
  for (const name of ['ums-expert','urovo-product-expert']) assert.equal(await readFile(path.join(root,name,'MEMORY.md'),'utf8'),`UNTOUCHABLE_${name}`);
});

test('parallel writers cannot clobber one another and unrelated entries retain their raw bytes', async t => {
  const {root,store} = await fixture(t); const other = new ExtraMemoryStore(root);
  const empty = await store.snapshot();
  const a = await store.change({action:'add',expected_revision:empty.revision,content:'alpha'});
  const b = await store.change({action:'add',expected_revision:a.revision,content:'beta'});
  const before = (await store.snapshot()).text; const beta = before.slice(before.indexOf(`## Memory ${b.id}`));
  const outcomes = await Promise.allSettled([store.change({action:'edit',id:a.id,content:'alpha-1',expected_revision:b.revision}),other.change({action:'edit',id:a.id,content:'alpha-2',expected_revision:b.revision})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1); assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/MEMORY_CONFLICT/);
  const after = await store.snapshot(); assert.equal(after.text.slice(after.text.indexOf(`## Memory ${b.id}`)),beta);
  assert.ok(after.text.includes('alpha-1')); assert.ok(!after.text.includes('alpha-2'));
  await store.change({action:'delete',id:a.id,expected_revision:after.revision}); assert.equal((await store.snapshot()).text.slice((await store.snapshot()).text.indexOf(`## Memory ${b.id}`)),beta);
});

test('invalid content, unknown IDs, stale revisions, malformed files and cancellation do not write', async t => {
  const {root,store} = await fixture(t);
  const empty = await store.snapshot();
  for(const content of ['', '  ', '## Memory mem_fake\npretend entry', 'bad\0body']) await assert.rejects(store.change({action:'add',expected_revision:empty.revision,content}));
  await assert.rejects(store.change({action:'edit',id:'mem_skill_id',expected_revision:empty.revision,content:'cannot change a skill memory'}),/skill memories/);
  const added=await store.change({action:'add',expected_revision:empty.revision,content:'unchanged'});
  await assert.rejects(store.change({action:'delete',id:added.id,expected_revision:empty.revision}),/MEMORY_CONFLICT.*unchanged/);
  const controller = new AbortController();controller.abort();
  await assert.rejects(store.change({action:'edit',id:added.id,expected_revision:added.revision,content:'cancelled'},controller.signal));
  assert.ok((await store.snapshot()).text.includes('unchanged'));
  await writeFile(store.file,'User-maintained malformed content');const malformed=await store.snapshot();
  assert.ok((await extraMemoryContext(root)).includes('User-maintained malformed content'));
  await assert.rejects(store.change({action:'add',expected_revision:malformed.revision,content:'do not overwrite'}),/format/);
  assert.equal((await store.snapshot()).text,malformed.text);
});

test('memory file, memory directory and backup directory symlinks cannot reach skill files', async t => {
  const {root,store} = await fixture(t); const protectedFile=path.join(root,'urovo-product-expert/MEMORY.md');
  await mkdir(path.join(root,'memory'));await symlink(protectedFile,store.file);
  await assert.rejects(store.snapshot());await rm(store.file);await rm(path.join(root,'memory'),{recursive:true});await symlink(path.join(root,'urovo-product-expert'),path.join(root,'memory'));
  await assert.rejects(store.snapshot(),/symlinks/);await rm(path.join(root,'memory'));
  const snapshot=await store.snapshot();await symlink(path.join(root,'urovo-product-expert'),path.join(root,'maintenance-backups'));
  await assert.rejects(store.change({action:'add',expected_revision:snapshot.revision,content:'blocked backup write'}),/symlinks/);
  assert.equal(await readFile(protectedFile,'utf8'),'UNTOUCHABLE_urovo-product-expert');
  await assert.rejects(stat(store.file),{code:'ENOENT'});
});
