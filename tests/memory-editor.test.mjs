import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {MemoryInjectionService} from '../dist/memory-injection/service.js';
import {ExtraMemoryStore, parseMemoryEntries} from '../dist/agent/extra-memory.js';
import {mainMemoryFile} from '../dist/agent/memory-paths.js';
import {knowledgeLock} from '../dist/knowledge-sync/core.js';
import {createWebServer} from '../dist/web/server.js';
const entry = (body) => `# Skill Memories\n\n## Memory mem_fixture\n\n- Kind: fact\n- Created-By-Email: test@example.com\n- Created: 2026-01-01T00:00:00Z\n- Updated: 2026-01-01T00:00:00Z\n\n### Content\n\n${body}\n`;
async function fixture(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-editor-'));
  const main=mainMemoryFile(dataDir);
  await fs.mkdir(path.dirname(main),{recursive:true});
  await fs.writeFile(main,entry('Main original'));
  const service=new MemoryInjectionService({dataDir,modelId:()=> 'mock',redact:e=>e.message,planner:()=>async()=>({summary:'Mock preview',questions:[],operations:[{action:'add',content:'New proposed fact',reason:'Mock'}]})});
  const extra=new ExtraMemoryStore(dataDir);
  await service.init();
  t.after(async()=>{await service.close();await fs.rm(dataDir,{recursive:true,force:true});});
  return {dataDir,main,service,extra};
}
test('direct main editing preserves exact bytes and backup, rejects stale/invalid content, and invalidates an older AI preview',async t=>{
  const f=await fixture(t), before=await f.service.editorSnapshot();
  const job=await f.service.preview('Mock request');
  let ready;
  for(let n=0;n<100;n++){ready=await f.service.get(job.id);if(ready.status!=='planning')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(ready.status,'ready');
  const text='\ufeff'+entry('中文 <script>alert(1)</script>\n\n### Nested heading').replace(/\n/g,'\r\n');
  const saved=await f.service.edit(text,before.revision);
  assert.equal(saved.text,text);assert.equal(await fs.readFile(f.main,'utf8'),text);
  const backups=await fs.readdir(path.join(f.dataDir,'maintenance-backups/main-memory'));
  assert.equal(await fs.readFile(path.join(f.dataDir,'maintenance-backups/main-memory',backups[0]),'utf8'),before.text);
  assert.equal((await fs.stat(f.main)).mode&0o777,0o600);
  await assert.rejects(f.service.edit(entry('Stale'),before.revision),e=>e.status===409);
  for(const invalid of ['', 'freeform bad format', entry('bad\0body'), entry('x').repeat(2), 'x'.repeat(2*1024*1024+1), '\ud800']) await assert.rejects(f.service.edit(invalid,saved.revision));
  assert.equal((await f.service.edit(text,saved.revision)).changed,false);
  assert.equal((await fs.readdir(path.join(f.dataDir,'maintenance-backups/main-memory'))).length,1);
  assert.equal((await f.extra.snapshot()).text,'');
  await f.service.confirm(job.id);
  for(let n=0;n<100;n++){ready=await f.service.get(job.id);if(ready.status!=='committing')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(ready.status,'conflict');assert.equal(await fs.readFile(f.main,'utf8'),text);
});
test('direct main save waits for active knowledge readers and two editors cannot silently overwrite',async t=>{
  const f=await fixture(t), before=await f.service.editorSnapshot();
  const release=await knowledgeLock(path.join(f.dataDir,'urovo-product-expert')).read();
  let done=false;const saving=f.service.edit(entry('Changed'),before.revision).then(value=>{done=true;return value;});
  try{await new Promise(r=>setTimeout(r,20));assert.equal(done,false);await assert.rejects(f.service.edit(entry('Other'),before.revision),e=>e.status===409);}finally{release();}
  await saving;assert.match(await fs.readFile(f.main,'utf8'),/Changed/);
});
test('extra raw editor shares the model memory queue, preserves raw bytes/backups, supports empty and missing files',async t=>{
  const f=await fixture(t);const initial=await f.extra.editorSnapshot();
  assert.equal(initial.text,'');assert.equal((await f.extra.download()).length,0);
  const raw=entry('Extra initial').replace(/\n/g,'\r\n');
  const saved=await f.extra.replace(raw,initial.revision);
  assert.deepEqual(await f.extra.download(),Buffer.from(raw));
  const other=new ExtraMemoryStore(f.dataDir);
  const results=await Promise.allSettled([f.extra.replace(entry('Raw edit'),saved.revision),other.change({action:'edit',id:'mem_fixture',content:'Model edit',expected_revision:saved.revision})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/MEMORY_CONFLICT/);
  let current=await f.extra.editorSnapshot();parseMemoryEntries(current.text);
  await f.extra.change({action:'edit',id:'mem_fixture',content:'Model after editor',expected_revision:current.revision});
  current=await f.extra.editorSnapshot();assert.match(current.text,/Model after editor/);
  const empty=await f.extra.replace('',current.revision);assert.equal(empty.text,'');
  assert.equal((await f.extra.replace('',empty.revision)).changed,false);
  assert.match(await fs.readFile(f.main,'utf8'),/Main original/);
  const backups=await fs.readdir(path.join(f.dataDir,'maintenance-backups/extra-memory'));
  assert.equal(backups.length,4);
  assert.equal(await fs.readFile(path.join(f.dataDir,'maintenance-backups/extra-memory',backups[0]),'utf8'),'');
});
test('extra raw editor rejects malformed/linked/oversized files; malformed UTF-8 remains downloadable without rewriting',async t=>{
  const f=await fixture(t), initial=await f.extra.editorSnapshot();
  for(const value of ['bad format',entry('x').replace('Created: 2026','Created: invalid-2026'),entry('x\0y'),entry('x')+entry('y'),'x'.repeat(2*1024*1024+1),'\ud800']) await assert.rejects(f.extra.replace(value,initial.revision));
  await fs.symlink(f.main,f.extra.file);await assert.rejects(f.extra.editorSnapshot());await assert.rejects(f.extra.download());await fs.rm(f.extra.file);
  const invalid=Buffer.from([0xff,0xfe,0x61]);await fs.writeFile(f.extra.file,invalid);
  assert.deepEqual(await f.extra.download(),invalid);await assert.rejects(f.extra.editorSnapshot());
  await fs.writeFile(f.extra.file,'x'.repeat(2*1024*1024+1));await assert.rejects(f.extra.download(),/2 MiB/);
});
test('memory editor HTTP is administrator-only with CSRF/Origin, fixed targets, exact downloads and conflict responses',async t=>{
  const f=await fixture(t);
  const app=await createWebServer({cwd:f.dataDir,dataDir:f.dataDir,resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'secret'},bridgeToken:'bridge-test-key-01234567890123456789',mcp:{apiKey:'mcp-test-key'},model:{apiKey:'',modelId:'mock',baseUrl:'https://unused.invalid'}});
  t.after(()=>app.close());app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const token=(await(await fetch(base+'/api/auth/status')).json()).token;
  for(const route of ['/api/memory-injection/files/main','/api/memory-injection/files/extra','/api/memory-injection/download-extra']) for(const key of ['', 'bridge-test-key-01234567890123456789','mcp-test-key']) assert.equal((await fetch(base+route,{headers:key?{Authorization:`Bearer ${key}`}:{}})).status,401);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify({account:'admin',password:'secret'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(route,method='GET',body,extra={})=>fetch(base+route,{method,headers:{Cookie:cookie,'x-local-token':token,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const main=await(await request('/api/memory-injection/files/main')).json();
  assert.equal((await request('/api/memory-injection/files/main?path=other')).status,400);
  assert.equal((await request('/api/memory-injection/files/main','PUT',{text:entry('New'),revision:main.revision},{'x-local-token':''})).status,403);
  assert.equal((await request('/api/memory-injection/files/main','PUT',{text:entry('New'),revision:main.revision},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await request('/api/memory-injection/files/main','PUT',{text:entry('New'),revision:main.revision,path:f.extra.file})).status,400);
  assert.equal((await request('/api/memory-injection/files/main','PUT',{text:entry('New'),revision:main.revision})).status,200);
  assert.equal((await request('/api/memory-injection/files/main','PUT',{text:entry('Stale'),revision:main.revision})).status,409);
  const extra=await(await request('/api/memory-injection/files/extra')).json();assert.equal(extra.text,'');
  const text=entry('Extra changed');
  assert.equal((await request('/api/memory-injection/files/extra','PUT',{text,revision:extra.revision})).status,200);
  assert.equal((await request('/api/memory-injection/files/extra','PUT',{text,revision:extra.revision})).status,409);
  const current=await(await request('/api/memory-injection/files/extra')).json();
  assert.equal((await request('/api/memory-injection/files/extra','PUT',{text:'invalid',revision:current.revision})).status,400);
  const download=await request('/api/memory-injection/download-extra');
  assert.equal(download.headers.get('content-disposition'),'attachment; filename="MEMORY_EXTRA.md"');assert.equal(download.headers.get('cache-control'),'no-store');assert.equal(await download.text(),text);
  assert.equal((await request('/api/memory-injection/download-extra?path=other')).status,400);
  const home=await(await request('/')).text();for(const label of ['Edit Memory','Edit Extra Memory','Download Extra Memory'])assert(home.includes(label));
  assert.equal((await request('/memory-editor.js')).status,200);
});
