import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { once } from 'node:events';
import { SyncService } from '../dist/knowledge-sync/service.js';
import { AutoSync } from '../dist/knowledge-sync/auto-sync.js';
import { AutoSyncSocket, dispatchAutoSync } from '../dist/knowledge-sync/auto-sync-socket.js';
import { emptyUsage, hash } from '../dist/knowledge-sync/core.js';

async function fixture(t, { count=2, configured=true, converter }={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'auto-sync-'));
  let converted=0;
  const options={dataDir:root,maxBytes:1048576,timeoutMs:10000,modelId:()=> 'fixture',redact:e=>String(e.message),
    converter:()=>async source=>{converted++;if(converter)await converter(source);return {markdown:await fs.readFile(source,'utf8'),sourceHash:hash(await fs.readFile(source)),coverage:['Complete fixture'],version:4,visual:emptyUsage()};},
    planner:()=>async()=>({decision:{action:'review',reason:'Administrator decision required',summary:'Held',products:[],slot:'',oldPaths:[],versionEvidence:'',authorizedException:false,reviewedPaths:[]},staged:new Map()})};
  const sync=new SyncService(options);
  await sync.init();
  await fs.mkdir(sync.inbox,{recursive:true});
  for(let n=0;n<count;n++)await fs.writeFile(path.join(sync.inbox,`${String(n).padStart(3,'0')}.md`),`# Source ${n}`);
  const auto=new AutoSync(sync,()=>configured,e=>String(e.message));await auto.init();
  t.after(async()=>{await auto.close();await sync.close();await auto.wait();await fs.rm(root,{recursive:true,force:true});});
  return {root,sync,auto,options,converted:()=>converted};
}

test('daily selection uses ordinary Sync, preserves review files and never retries handled versions, even after restart',async t=>{
  const f=await fixture(t);
  const first=await f.auto.trigger();assert.equal(first.selected,2);
  await f.auto.wait();
  assert.deepEqual(f.auto.status().lastRun.counts,{needs_review:2});
  assert.equal(f.sync.list().length,1);
  assert.equal((await f.sync.incoming()).length,2);
  const second=await f.auto.trigger();assert.equal(second.status,'skipped_handled');assert.equal(second.held,2);assert.equal(f.converted(),2);
  await fs.writeFile(path.join(f.sync.inbox,'000.md'),'# Changed version');
  const changed=await f.auto.trigger();assert.equal(changed.selected,1);assert.equal(changed.held,1);await f.auto.wait();assert.equal(f.converted(),3);
  await f.auto.close();await f.sync.close();
  const g=new SyncService(f.options);
  await g.init();const again=new AutoSync(g,()=>true,e=>String(e.message));await again.init();
  assert.equal((await again.trigger()).status,'skipped_handled');assert.equal(g.list().length,2);
  await again.close();await g.close();await again.wait();
});

test('all incoming files are snapshotted and processed in serial batches no larger than 50',async t=>{
  const f=await fixture(t,{count:51});
  const run=await f.auto.trigger();assert.equal(run.selected,51);await f.auto.wait();
  assert.deepEqual(f.sync.list().map(j=>j.count).sort((a,b)=>a-b),[1,50]);
  assert.deepEqual(f.auto.status().lastRun.counts,{needs_review:51});
  assert.equal(f.converted(),51);assert.equal(f.auto.status().lastRun.status,'completed');
  assert.equal((await f.auto.trigger()).status,'skipped_handled');
});

test('a failed file is reported once while other files continue; next day neither failure nor review is retried',async t=>{
  const f=await fixture(t,{converter:source=>{if(source.endsWith('000.md'))throw Error('Fixture conversion failed');}});
  await f.auto.trigger();await f.auto.wait();
  assert.deepEqual(f.auto.status().lastRun.counts,{failed:1,needs_review:1});
  assert.equal((await f.auto.trigger()).status,'skipped_handled');assert.equal(f.converted(),2);
});

test('busy, duplicate triggers, empty inbox and invalid files do not launch new work',async t=>{
  const empty=await fixture(t,{count:0});assert.equal((await empty.auto.trigger()).status,'skipped_empty');
  await fs.writeFile(path.join(empty.sync.inbox,'bad.exe'),'invalid');assert.equal((await empty.auto.trigger()).invalid,1);assert.equal(empty.sync.list().length,0);
  let release;const latch=new Promise(r=>release=r);
  const f=await fixture(t,{converter:()=>latch});
  const first=await f.auto.trigger();const duplicate=await f.auto.trigger();assert.equal(duplicate.status,'skipped_busy');assert.equal(f.sync.list().length,1);
  assert.equal(f.auto.status().lastRun.started,first.started);
  release();await f.auto.wait();
  let finish;const gate=new Promise(r=>finish=r);
  const manual=await fixture(t,{converter:()=>gate});
  await manual.sync.start((await manual.sync.incoming()).map(i=>i.id));assert.equal((await manual.auto.trigger()).status,'skipped_busy');finish();await manual.sync.waitFor(manual.sync.list()[0].id);
});

test('new arrivals wait for next day and stopping a scheduled batch stops the remaining snapshot',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const f=await fixture(t,{count:51,converter:()=>gate});
  const run=await f.auto.trigger();await fs.writeFile(path.join(f.sync.inbox,'arrived-later.md'),'# Not in original snapshot');
  await f.sync.stop(run.jobIds[0]);release();await f.auto.wait();
  assert.equal(f.sync.list().length,1);assert.equal(f.auto.status().lastRun.status,'stopped');assert(f.converted()<=1);
  const later=await f.auto.trigger();assert.equal(later.selected,2,'one unqueued batch file and one later arrival');await f.auto.wait();
});

test('changed snapshot is rejected under ordinary reservation; manual re-Sync remains available',async t=>{
  const f=await fixture(t,{count:1});
  const [file]=await f.sync.incoming();await fs.writeFile(path.join(f.sync.inbox,file.name),'# Different bytes');
  await assert.rejects(f.sync.start([file.id],new Map([[file.id,file.sourceHash]])),/Scheduled input changed/);assert.equal(f.sync.busy,false);assert.equal(f.sync.list().length,0);
  await f.auto.trigger();await f.auto.wait();
  const job=f.sync.list()[0];const report=await f.sync.get(job.id);
  await f.sync.resync(job.id,report.items[0].id,'Manual decision');await f.sync.waitFor(job.id);
  assert.equal((await f.sync.get(job.id)).items[0].attempts.length,1);
});

test('missing configuration fails without model work and a running last-run record recovers as interrupted',async t=>{
  const f=await fixture(t,{configured:false});await assert.rejects(f.auto.trigger(),/Configure/);assert.equal(f.sync.list().length,0);assert.equal(f.auto.status().lastRun.status,'failed');
  await fs.writeFile(path.join(f.sync.directory,'auto-sync-last.json'),JSON.stringify({started:new Date().toISOString(),status:'running',selected:1,held:0,invalid:0,jobIds:[],counts:{}}));
  const recovered=new AutoSync(f.sync,()=>true,e=>String(e.message));await recovered.init();assert.equal(recovered.status().lastRun.status,'interrupted');assert.equal(f.sync.list().length,0);await recovered.close();
});

test('private Unix trigger permissions, stale recovery, active ownership and fixed operation are enforced',async t=>{
  const root=await fs.mkdtemp('/tmp/auto-sock-');await fs.chmod(root,0o700);const file=path.join(root,'run.sock');
  let calls=0;const server=new AutoSyncSocket(file,async()=>({status:'running',number:++calls}));await server.listen();
  t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
  assert.equal(server.status().available,true);assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal((await dispatchAutoSync(file)).number,1);
  const other=new AutoSyncSocket(file,async()=>assert.fail('must not replace active socket'));await other.listen();assert.equal(other.status().available,false);await other.close();
  const socket=net.createConnection(file);await once(socket,'connect');socket.end(JSON.stringify({operation:'run',ids:['injected']}));let text='';for await(const c of socket)text+=c;assert.equal(JSON.parse(text).ok,false);assert.equal(calls,1);
  await server.close();await fs.writeFile(file,'do not replace');const unsafe=new AutoSyncSocket(file,async()=>{});await unsafe.listen();assert.equal(unsafe.status().available,false);assert.equal(await fs.readFile(file,'utf8'),'do not replace');await unsafe.close();
});
