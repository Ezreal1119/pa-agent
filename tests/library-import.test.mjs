// Simulated fixtures only. Added for later execution; not run in the implementation round.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { LibraryImportService } from '../dist/library-import/service.js';
import { createClassifier, CATEGORIES } from '../dist/library-import/classifier.js';
import { ImportError, publicUrl } from '../dist/library-import/http.js';
import { emptyUsage } from '../dist/knowledge-sync/core.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const file=(key,name=`${key}.pdf`,documentType='specs')=>({key,name,documentType,displayPath:`DT50 / ${documentType} / ${name}`,url:`https://downloads.example/${key}`,size:3});
async function fixture(t,files=[file('a')]) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'library-import-'));let report='new',bytes=Buffer.from('abc'),calls=0,classCalls=0;
  const reports=()=>[{runId:'old',completedAt:'2026-10-19T00:00:00Z'},{runId:report,completedAt:'2026-10-21T00:00:00Z'},{runId:'incomplete'}];
  const config={baseUrl:'https://library.example',password:'test-secret-library-password'};
  let added=files.map(f=>({key:f.key,name:f.name})),updated=[],categories={};
  const service=new LibraryImportService({dataDir:path.join(root,'.data'),config,modelConfigured:()=>true,disk:async()=>{},verify:async()=>{},classifier:()=>async(metadata,signal,record)=>{
    signal.throwIfAborted();classCalls++;const usage={input:10,output:5,requests:1,recorded:1};await record(usage);return {category:categories[metadata.name] || 'specs',reason:'fixture classification',model:'mock',usage};
  },transport:{
    json:async(url,password)=>{
      const u=new URL(url);
      if(u.pathname==='/api/files'){assert.equal(password,undefined);return {files};}
      assert.equal(password,config.password);
      if(!u.search)return {reports:reports()};
      assert.equal(u.searchParams.get('runId'),report);
      return {audit:{runId:report,completedAt:'2026-10-21T00:00:00Z',changes:{added,updated,deleted:[{key:'ignored'}]}}};
    },
    request:async()=>{calls++;return Object.assign(Readable.from([bytes]),{headers:{'content-length':String(bytes.length)}});},
  }});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});await service.init();
  return {root,service,files,config,categories,setReport:r=>report=r,setBytes:b=>bytes=Buffer.from(b),setChanges:(a,u=[])=>{added=a;updated=u;},get calls(){return calls;},get classifications(){return classCalls;},run:async()=>{const r=await service.start();await service.wait();return service.get(r.id);}};
}
test('library uses latest complete report, merges current key metadata, deduplicates added/updated and skips removed/legacy formats',async t=>{
  const f=await fixture(t,[file('a'),file('legacy','old.xls'),file('huge','huge.pdf')]);f.files[2].size=100*1048576+1;
  f.setChanges([{key:'a',name:'outdated.txt'},{key:'legacy'},{key:'missing'},{key:'huge'}],[{key:'a'}]);
  const r=await f.run();assert.equal(r.sourceReport,'new');assert.equal(r.items.length,4);assert.equal(r.items[0].name,'a.pdf');assert.deepEqual(r.items.map(i=>i.status),['downloaded','skipped','skipped','skipped']);assert.equal(f.calls,1);
});
test('library retries only incomplete current-report entries; hash ledger survives Sync consumption and new latest reports replace old work',async t=>{
  const f=await fixture(t);let r=await f.run();assert.equal(r.items[0].status,'downloaded');assert.equal(r.usage.input,10);
  await fs.unlink(path.join(f.service.inbox,r.items[0].target));r=await f.run();assert.equal(r.items[0].status,'already_completed');assert.equal(f.calls,1);
  f.setReport('newer');r=await f.run();assert.equal(r.sourceReport,'newer');assert.equal(r.items[0].status,'unchanged');assert.equal(f.classifications,1);assert.equal(r.usage.requests,0);assert.deepEqual(await fs.readdir(f.service.inbox),[]);
});
test('library reuses identical inbox file, preserves different same-name versions and keeps source hashes',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.service.inbox,'a.pdf'),'abc');let r=await f.run();assert.equal(r.items[0].target,'a.pdf');
  f.setReport('next');f.setBytes('xyz');r=await f.run();assert.match(r.items[0].target,/__library_/);assert.equal(await fs.readFile(path.join(f.service.inbox,'a.pdf'),'utf8'),'abc');assert.equal((await fs.readdir(f.service.inbox)).length,2);
});
test('library five categories are accepted, outside/uncertain are reported and cached',async t=>{
  const files=CATEGORIES.map((c,i)=>file(String(i),`${i}.pdf`,c));const f=await fixture(t,files);files.forEach((v,i)=>f.categories[v.name]=CATEGORIES[i]);
  const r=await f.run();assert.deepEqual(r.items.map(i=>i.status),['downloaded','downloaded','downloaded','downloaded','downloaded','skipped','needs_review']);assert.equal(f.calls,5);
  const again=await f.run();assert(again.items.every(i=>i.status==='already_completed'));assert.equal(f.classifications,7);
});
test('library integrity failure stays retryable; authentication and disk exhaustion stop the remaining batch without committing hashes',async t=>{
  const f=await fixture(t,[file('a'),file('b')]);let first=true;
  f.service.options.verify=async()=>{if(first){first=false;throw Error('corrupt package');}};
  let r=await f.run();assert.deepEqual(r.items.map(i=>i.status),['failed','downloaded']);r=await f.run();assert.deepEqual(r.items.map(i=>i.status),['downloaded','already_completed']);
  const auth=await fixture(t,[file('a'),file('b')]);auth.service.options.transport.request=async()=>{throw new ImportError('Remote HTTP 401.',true);};
  r=await auth.run();assert.deepEqual(r.items.map(i=>i.status),['failed','not_attempted']);assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(auth.service.root,'state.json'))).sources).length,0);
  const disk=await fixture(t,[file('a'),file('b')]);disk.service.options.disk=async()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});};r=await disk.run();assert.deepEqual(r.items.map(i=>i.status),['failed','not_attempted']);
});
test('library shared lock/stop cancels an incomplete stream, removes staging, and next run retries',async t=>{
  const f=await fixture(t);let notify;const started=new Promise(resolve=>notify=resolve);
  const download=f.service.options.transport.request;
  f.service.options.transport.request=async()=>{notify();return Object.assign(new Readable({read(){}}),{headers:{}});};
  const r=await f.service.start();await started;
  const other=new LibraryImportService({...f.service.options});await other.init();await assert.rejects(()=>other.start(),/already running/);
  await other.stop(r.id);await f.service.wait();const stopped=await f.service.get(r.id);assert.equal(stopped.status,'stopped');assert.deepEqual(await fs.readdir(f.service.inbox),[]);assert.deepEqual(await fs.readdir(path.join(f.service.root,'work')),[]);
  f.service.options.transport.request=download;assert.equal((await f.run()).items[0].status,'downloaded');await other.close();
});
test('library recovers proven pending publication and marks unfinished report interrupted',async t=>{
  const f=await fixture(t);const stage=`${randomUUID()}.part`,id=randomUUID(),completion=sha('completion');
  await fs.writeFile(path.join(f.service.root,'work',stage),'abc');await fs.link(path.join(f.service.root,'work',stage),path.join(f.service.inbox,'recover.pdf'));
  await fs.writeFile(path.join(f.service.root,'state.json'),JSON.stringify({version:1,sources:{[sha('source')]:{delivered:{},pending:{hash:sha('abc'),target:'recover.pdf',stage,completion,run:id}}},completed:{},classifications:{}}));
  await fs.writeFile(path.join(f.service.root,`${id}.json`),JSON.stringify({id,status:'running',created:new Date().toISOString(),sourceBase:f.config.baseUrl,items:[],counts:{},usage:emptyUsage()}));
  await f.service.init();assert.equal((await f.service.get(id)).status,'interrupted');const state=JSON.parse(await fs.readFile(path.join(f.service.root,'state.json')));assert.equal(state.completed[completion].target,'recover.pdf');assert.deepEqual(await fs.readdir(path.join(f.service.root,'work')),[]);
});
test('library corrupt state and changed pending publication fail closed; paths/URLs cannot escape to private networks',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.service.root,'state.json'),'bad-json');await f.service.init();assert((await f.service.status()).recoveryError);await assert.rejects(()=>f.service.start());
  for(const value of ['http://example.com/a.pdf','https://user:pw@example.com/a.pdf','https://127.0.0.1/a.pdf','https://[::1]/a.pdf','https://169.254.169.254/a.pdf','https://[::ffff:127.0.0.1]/a.pdf'])await assert.rejects(()=>publicUrl(value));
  const bad=await fixture(t,[file('a','../../bad.pdf')]);assert.equal((await bad.run()).items[0].status,'skipped');assert.equal(bad.calls,0);
});
test('library classifier uses metadata only, no tools, shared DeepSeek configuration, exact enum and recorded usage',async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let captured;
  globalThis.fetch=async(url,options)=>{captured={url,...JSON.parse(options.body)};return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({category:'user_guide',reason:'明确用户指南'})}}],usage:{prompt_tokens:11,completion_tokens:7}}));};
  const classify=createClassifier({apiKey:'fixture',baseUrl:'https://model.example/v1',modelId:'deepseek-flash',maxTokens:2048},'low');const usages=[];
  const result=await classify({name:'manual.pdf',documentType:'user_guide',displayPath:'product/manual'},new AbortController().signal,async u=>usages.push(u));
  assert.equal(result.category,'user_guide');assert.equal(captured.tools,undefined);assert.equal(captured.messages.length,2);assert.equal(captured.thinking.type,'enabled');assert.equal(usages.reduce((n,u)=>n+u.input,0),11);assert.equal(usages.reduce((n,u)=>n+u.requests,0),1);
});
test('library transient transfer errors retry finitely without advancing hashes on failed attempts',async t=>{
  const f=await fixture(t);const download=f.service.options.transport.request;let calls=0;
  f.service.options.transport.request=async(...args)=>{if(++calls<3)throw Object.assign(Error('reset'),{code:'ECONNRESET'});return download(...args);};
  const r=await f.run();assert.equal(r.items[0].attempts,3);assert.equal(r.items[0].status,'downloaded');assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(f.service.root,'state.json'))).sources).length,1);
});
test('library changed pending target is preserved for manual recovery and is never silently overwritten',async t=>{
  const f=await fixture(t),id=randomUUID(),stage=`${randomUUID()}.part`;
  await fs.writeFile(path.join(f.service.root,'work',stage),'abc');await fs.writeFile(path.join(f.service.inbox,'a.pdf'),'changed');
  await fs.writeFile(path.join(f.service.root,'state.json'),JSON.stringify({version:1,sources:{[sha('source')]:{delivered:{},pending:{hash:sha('abc'),target:'a.pdf',stage,completion:sha('completion'),run:id}}},completed:{},classifications:{}}));
  await f.service.init();assert.match((await f.service.status()).recoveryError,/cannot be proven/);await assert.rejects(()=>f.service.start(),/cannot be proven/);
  assert.equal(await fs.readFile(path.join(f.service.inbox,'a.pdf'),'utf8'),'changed');assert.equal(await fs.readFile(path.join(f.service.root,'work',stage),'utf8'),'abc');
});
