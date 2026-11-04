import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ImagePrewarmJobs } from '../src/ckd/image-prewarm.js';
import { ImageAssessmentChecker } from '../src/ckd/image-assessment.js';
import { acquireLibraryLock } from '../src/ckd/library-lock.js';
import { assessmentSeen } from './helpers/image-assessment.js';
import type { LibraryModel } from '../src/ckd/library-model.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
const response=()=>({text:JSON.stringify(assessmentSeen),model:'fake'});
function fixture(t:{after(fn:()=>void):void}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-prewarm-'))),library=path.join(root,'library'),data=path.join(root,'data');
  fs.mkdirSync(library);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(relative:string,bytes=png)=>{const file=path.join(library,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;};
  return {root,library,data,put};
}
test('prewarm deduplicates bilingual paths, bounds concurrency and warms the SOP cache without modifying source',async t=>{
  const f=fixture(t);let active=0,max=0,calls=0;
  const model:LibraryModel={async complete(){active++;max=Math.max(max,active);calls++;await new Promise(r=>setTimeout(r,5));active--;return response();}};
  const originals=new Map<string,Buffer>();for(let i=0;i<5;i++){const bytes=Buffer.concat([png,Buffer.from(String(i))]);for(const lang of ['processes','CN_processes'])originals.set(f.put(`product_lib/P/pcba_test/${lang}/A/p${i}.png`,bytes),bytes);}
  f.put('product_lib/P/derived/A/ignored.png');f.put('processes_lib/CN_derived/A/ignored.jpg');
  const jobs=new ImagePrewarmJobs(f.data,{model}),job=jobs.create(f.library,3);assert.equal(job.total,5);assert.equal(job.fileCount,10);
  const done=await jobs.resume(job.id);assert.equal(done.status,'completed',done.error);assert.equal(done.analyzed,5);assert.equal(calls,10);assert.equal(max,3);
  for(const [file,bytes] of originals)assert.deepEqual(fs.readFileSync(file),bytes);
  const checker=new ImageAssessmentChecker(f.data,{model});assert.equal((await checker.check([...originals.values()][0]!)).cached,true);assert.equal(calls,10);
  const reused=await jobs.resume(jobs.create(f.library).id);assert.equal(reused.reused,5);assert.equal(calls,10);
});
test('prewarm isolates invalid model/image errors and resumes only failures after restart',async t=>{
  const f=fixture(t);f.put('processes_lib/pcba_test/A/photos/p1.png');const bad=f.put('processes_lib/pcba_test/A/photos/p2.png',Buffer.from('broken'));
  let calls=0,invalid=true;const model:LibraryModel={async complete(){calls++;return invalid?{text:'{}',model:'fake'}:response();}};
  const jobs=new ImagePrewarmJobs(f.data,{model}),job=jobs.create(f.library);let done=await jobs.resume(job.id);assert.equal(done.status,'partial_failed');assert.equal(done.errors,2);assert.equal(done.items.filter(i=>i.fallback?.score===0).length,1);
  invalid=false;done=await new ImagePrewarmJobs(f.data,{model}).resume(job.id);assert.equal(done.analyzed,1);assert.equal(done.errors,1);const previous=calls;
  await new ImagePrewarmJobs(f.data,{model}).resume(job.id);assert.equal(calls,previous);assert.equal(fs.readFileSync(bad,'utf8'),'broken');
});
test('pause releases locks, persists progress, and explicit restart completes pending items',async t=>{
  const f=fixture(t);f.put('product_lib/P/pcba_test/processes/A/photos/p1.png');
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  const jobs=new ImagePrewarmJobs(f.data,{model:{async complete(){began();return new Promise(()=>{});}}}),job=jobs.create(f.library),controller=new AbortController();
  const pending=jobs.resume(job.id,controller.signal);await started;
  assert.throws(()=>acquireLibraryLock(f.library),/busy/iu);await assert.rejects(jobs.resume(job.id),/busy/iu);
  controller.abort(new Error('pause'));assert.equal((await pending).status,'interrupted');
  const release=acquireLibraryLock(f.library);release();
  const done=await new ImagePrewarmJobs(f.data,{model:{async complete(){return response();}}}).resume(job.id);assert.equal(done.status,'completed',done.error);
});
test('cancel aborts an active request; mutation and timeout are item failures without success caches',async t=>{
  const f=fixture(t);const file=f.put('processes_lib/pcba_test/A/photos/p1.png');let began!:()=>void;const started=new Promise<void>(r=>{began=r;});
  const jobs=new ImagePrewarmJobs(f.data,{model:{async complete(){began();return new Promise(()=>{});}}}),job=jobs.create(f.library),pending=jobs.resume(job.id);await started;jobs.cancel(job.id);assert.equal((await pending).status,'cancelled');
  assert.equal((await jobs.resume(job.id)).status,'cancelled');const unlock=acquireLibraryLock(f.library);unlock();
  const timeout=new ImagePrewarmJobs(f.data,{model:{async complete(){return new Promise(()=>{});}},timeoutMs:10});const timed=await timeout.resume(timeout.create(f.library).id);assert.equal(timed.errors,1);assert.match(timed.items[0]!.error!,/timeout/iu);
  const changed=new ImagePrewarmJobs(f.data,{model:{async complete(){fs.appendFileSync(file,'change');return response();}}});const result=await changed.resume(changed.create(f.library).id);assert.equal(result.errors,1);assert.match(result.items[0]!.error!,/changed/iu);
  assert.equal(fs.existsSync(path.join(changed.root,result.id,'items',result.items[0]!.imageHash+'.json')),false);
});
