import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import sharp from 'sharp';
import {LibraryMaintenance} from '../src/ckd/library-maintenance.js';
import {ImageAssessmentChecker,saveImagePolicy,DEFAULT_POLICY} from '../src/ckd/image-assessment.js';
import {assessmentSeen} from './helpers/image-assessment.js';
import {createCkdUiServer} from '../src/ckd/ui-server.js';
import {acquireLibraryLock,libraryPendingMarker} from '../src/ckd/library-lock.js';
import {fileHash,sha} from '../src/ckd/library-source.js';
import {atomicJson} from '../src/ckd/store.js';
import {runSummaries} from '../src/ckd/library-summaries.js';
import {stageContext} from '../src/ckd/library-sync.js';
import type {MaintenanceContext} from '../src/ckd/library-job-types.js';
import type {LibraryModelRequest,LibraryModel} from '../src/ckd/library-model.js';
import {mockTranslated} from './helpers/mock-translation.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
const write=(p:string,v:string|Buffer)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,v);return p;};
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-sync-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const libraryPath=path.join(root,'ckd-library-v2'),dataDir=path.join(root,'data'),en=path.join(libraryPath,'processes_lib/factory_test/P'),cn=path.join(libraryPath,'processes_lib/factory_test/CN_process/P');
 write(path.join(en,'metadata.txt'),'Camera');write(path.join(en,'operation_steps.txt'),'Check port.');write(path.join(libraryPath,'product_lib/A/project.json'),JSON.stringify({projectId:'A',displayName:'A',aliases:[]}));
 const calls:LibraryModelRequest[]=[],model:LibraryModel={async complete(r){calls.push(r);if(r.purpose==='translate'){const i=JSON.parse(r.prompt);return {text:JSON.stringify({text:(i.targetLanguage==='中文'?'中：':'EN:')+mockTranslated(i.text,i.targetLanguage)}),model:'text'};}return {text:r.purpose==='vision'?'A visible camera.':'Check the camera.',model:r.purpose==='vision'?'vision':'text'};}};
 let vision=0;const imageChecker=new ImageAssessmentChecker(dataDir,{model:{async complete(){vision++;return {text:JSON.stringify(assessmentSeen),model:'vision'};}}});
 const service=new LibraryMaintenance({libraryPath,dataDir,model,imageChecker});return {root,libraryPath,dataDir,en,cn,calls,model,imageChecker,service,vision:()=>vision};
}
test('sync validates first, translates, scores each image Hash once and updates summaries; unchanged rerun invokes no models',async t=>{
 const f=fixture(t);write(path.join(f.en,'photos/p1.png'),png);let job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));
 assert.equal(f.vision(),2);assert.equal(job.sync!.images!.length,2);assert.equal(job.sync!.images![0]!.imageHash,sha(png));assert.equal(job.sync!.stages.summaries!.status,'completed');assert.ok(fs.existsSync(path.join(f.cn,'summary.json')));assert.ok(fs.existsSync(path.join(f.en,'overview.json')));
 const count=f.calls.length;job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(f.vision(),2);assert.equal(f.calls.length,count);
 const progressFile=path.join(f.dataDir,'ckd/library-jobs',job.id,'progress.json');fs.unlinkSync(progressFile);
 assert.equal(f.service.getProgress(job.id).status,'completed');assert.ok(fs.existsSync(progressFile),'old terminal jobs acquire a small progress sidecar once');
});
test('cached progress and historical warnings are batched without losing final counts',t=>{
 const f=fixture(t),job=f.service.create('sync');job.sync={stage:'images',attempt:1,stages:{}};
 let saves=0;const controller=new AbortController();
 const parent:MaintenanceContext={root:f.libraryPath,directory:path.join(f.dataDir,'ckd/library-jobs',job.id),job,signal:controller.signal,model:f.model,translations:{},save(){saves++;},record(){throw new Error('cached items must be batched');},warning(){throw new Error('historical warnings must be batched');},commit(){throw new Error('no file writes expected');},async textTranslation(){throw new Error('no translation expected');}};
 const scoped=stageContext(parent,'images');scoped.job.total=10;
 for(let n=0;n<10;n++){scoped.warning(`Historical description ${n}`);scoped.record({key:`image-${n}`,status:'reused'});}
 assert.equal(saves,0);assert.equal(job.counts.reused,10);assert.equal(job.warnings.length,10);scoped.save();assert.equal(saves,1);assert.equal(job.sync.stages.images?.completed,10);
});
test('unchanged managed translations are rechecked once and only a faulty owned target is regenerated',async t=>{
 const f=fixture(t);let job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));
 const source='processes_lib/factory_test/P/operation_steps.txt',target='processes_lib/factory_test/CN_process/P/operation_steps.txt';
 const bad='中：Check port.';write(path.join(f.libraryPath,target),bad);
 const key=sha(f.libraryPath),cache=path.join(f.dataDir,'ckd/library-cache',key),registryFile=path.join(cache,'managed-translations.json'),baselineFile=path.join(cache,'sync-baseline.json');
 const registry=JSON.parse(fs.readFileSync(registryFile,'utf8')),baseline=JSON.parse(fs.readFileSync(baselineFile,'utf8'));
 registry[target].targetHash=sha(Buffer.from(bad));baseline.pairs[source].cnHash=registry[target].targetHash;
 atomicJson(registryFile,registry);atomicJson(baselineFile,baseline);
 const before=f.calls.filter(call=>call.purpose==='translate').length;
 job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));
 assert.ok(job.items.some(item=>item.key==='translate:'+source&&item.message?.includes('quality recheck')));
 assert.notEqual(fs.readFileSync(path.join(f.libraryPath,target),'utf8'),bad);
 assert.equal(f.calls.filter(call=>call.purpose==='translate').length,before,'a previously validated cached answer can repair the old target');
 job=await f.service.start('sync');assert.equal(job.status,'completed');
 assert.equal(f.calls.filter(call=>call.purpose==='translate').length,before,'repaired text is reused');
});
test('summary input manifest skips unchanged processes but detects same-size edits and missing outputs',async t=>{
 const f=fixture(t);const q=path.join(f.libraryPath,'processes_lib/factory_test/Q');
 write(path.join(q,'metadata.txt'),'Second camera');write(path.join(q,'operation_steps.txt'),'Check cable.');
 let job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.sync!.fastReusedSummaries,0);
 job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.sync!.fastReusedSummaries,4);
 const file=path.join(f.en,'operation_steps.txt'),before=fs.statSync(file);write(file,'Check wire.');fs.utimesSync(file,before.atime,before.mtime);
 job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.sync!.fastReusedSummaries,2);
 assert.match(fs.readFileSync(path.join(f.en,'summary.json'),'utf8'),/Check wire/u);
 fs.unlinkSync(path.join(q,'overview.json'));
 job=await f.service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.sync!.fastReusedSummaries,3);
 assert.ok(fs.existsSync(path.join(q,'overview.json')));
});
test('a raw file changed during summaries invalidates the one-pass snapshot',async t=>{
 const f=fixture(t);const q=path.join(f.libraryPath,'processes_lib/factory_test/Q');
 write(path.join(q,'metadata.txt'),'Second camera');write(path.join(q,'operation_steps.txt'),'Check cable.');
 assert.equal((await f.service.start('sync')).status,'completed');
 write(path.join(f.en,'operation_steps.txt'),'Check wire.');
 let changed=false;const model:LibraryModel={async complete(request,signal){
  if(request.purpose==='overview'&&!changed){changed=true;write(path.join(q,'technical_notes.txt'),'Uploaded during sync.');}
  return f.model.complete(request,signal);
 }};
 const service=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model,imageChecker:f.imageChecker});
 const job=await service.start('sync');assert.equal(changed,true);assert.equal(job.status,'failed');assert.match(job.error??'',/Library sources changed during sync/u);
});
test('an image changed after cached scoring fails final verification before publishing its index',async t=>{
 const f=fixture(t),photo=write(path.join(f.en,'photos/p1.png'),png);
 const original=f.imageChecker.checkWithFallback.bind(f.imageChecker);let changed=false;
 f.imageChecker.checkWithFallback=async (...args)=>{const result=await original(...args);if(!changed){changed=true;fs.appendFileSync(photo,Buffer.from([0]));}return result;};
 const job=await f.service.start('sync');assert.equal(changed,true);assert.equal(job.status,'failed');assert.match(job.error??'',/Library sources changed during sync/u);
 assert.ok(!fs.existsSync(path.join(f.dataDir,'ckd/library-cache',sha(f.libraryPath),'image-index.json')));
});
test('an output edited during fast reuse is not adopted into the summary baseline',async t=>{
 const f=fixture(t);const q=path.join(f.libraryPath,'processes_lib/factory_test/Q');
 write(path.join(q,'metadata.txt'),'Second camera');write(path.join(q,'operation_steps.txt'),'Check cable.');
 assert.equal((await f.service.start('sync')).status,'completed');
 write(path.join(f.en,'operation_steps.txt'),'Check wire.');
 let changed=false;const model:LibraryModel={async complete(request,signal){
  if(request.purpose==='overview'&&!changed){changed=true;fs.appendFileSync(path.join(q,'overview.json'),'\n');}
  return f.model.complete(request,signal);
 }};
 const service=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model,imageChecker:f.imageChecker});
 const job=await service.start('sync');assert.equal(changed,true);assert.equal(job.status,'failed');assert.match(job.error??'',/Summary output changed during sync/u);
});
test('cached summary maintenance yields a server turn before finishing',async t=>{
 const f=fixture(t);assert.equal((await f.service.start('sync')).status,'completed');
 const job=f.service.create('summaries');const controller=new AbortController();
 const context:MaintenanceContext={root:f.libraryPath,directory:path.join(f.dataDir,'ckd/library-jobs',job.id),job,signal:controller.signal,model:f.model,translations:{},save(){},record(item){job.items.push(item);},warning(){},commit(){throw new Error('unchanged summaries must be reused');},async textTranslation(){throw new Error('unchanged summaries must not be translated');}};
 let serverTurnRan=false;setImmediate(()=>{serverTurnRan=true;});
 await runSummaries(context);
 assert.equal(serverTurnRan,true);
 assert.ok(job.items.length>0);assert.ok(job.items.every(item=>item.status==='reused'));
});
test('one changed side becomes source, both changed Chinese wins and reports; empty file stays empty',async t=>{
 const f=fixture(t);let j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));
 write(path.join(f.cn,'operation_steps.txt'),'检查端口。');j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(fs.readFileSync(path.join(f.en,'operation_steps.txt'),'utf8'),'EN:Translated。');
 write(path.join(f.cn,'operation_steps.txt'),'中文修改。');write(path.join(f.en,'operation_steps.txt'),'English edit.');j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(fs.readFileSync(path.join(f.en,'operation_steps.txt'),'utf8'),'EN:Translated。');assert.ok(j.warnings.some(w=>w.includes('Chinese wins')));
 write(path.join(f.en,'operation_steps.txt'),'');j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(fs.statSync(path.join(f.cn,'operation_steps.txt')).size,0);
});
test('initial independent bilingual contents are adopted and CN photos flow to English',async t=>{
 const f=fixture(t);write(path.join(f.cn,'metadata.txt'),'人工中文');write(path.join(f.cn,'operation_steps.txt'),'中文工序');const manualPng=await sharp({create:{width:3,height:3,channels:3,background:'#000000'}}).png().toBuffer();write(path.join(f.cn,'photos/manual.png'),manualPng);write(path.join(f.en,'photos/p1.png'),png);
 let j=await f.service.start('sync',{dryRun:true});assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(f.calls.length,0);assert.ok(!fs.existsSync(path.join(f.dataDir,'ckd/library-cache',sha(f.libraryPath),'sync-baseline.json')));
 j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(fs.readFileSync(path.join(f.cn,'metadata.txt'),'utf8'),'人工中文');assert.ok(!fs.existsSync(path.join(f.cn,'photos/p1.png')));assert.ok(fs.existsSync(path.join(f.cn,'photos/manual.png')));assert.ok(fs.existsSync(path.join(f.en,'photos/manual.png')));
 write(path.join(f.en,'operation_steps.txt'),'Updated port.');j=await f.service.start('sync');assert.equal(fs.readFileSync(path.join(f.cn,'operation_steps.txt'),'utf8'),'中：'+mockTranslated('Updated port.','中文'));
});
test('syntax failure blocks all models and Library writes; resume rescans corrected files',async t=>{
 const f=fixture(t);const bad=write(path.join(f.en,'tools_fixtures_equipment.jsonl'),'{"qty":}\n');let j=await f.service.start('sync');assert.equal(j.status,'failed');assert.equal(j.sync!.validation!.errors[0]!.line,1);assert.equal(f.calls.length,0);assert.ok(!fs.existsSync(f.cn));
 write(bad,'');j=await new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model:f.model,imageChecker:f.imageChecker}).resume(j.id);assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(j.sync!.attempt,2);
});
test('deleting managed source removes auto counterpart, preserves manual opposite, and never resurrects unchanged deletion',async t=>{
 const f=fixture(t);write(path.join(f.en,'technical_notes.txt'),'Keep dry.');await f.service.start('sync');fs.unlinkSync(path.join(f.en,'technical_notes.txt'));let j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.ok(!fs.existsSync(path.join(f.cn,'technical_notes.txt')));assert.ok(j.sync!.deletions!.some(d=>d.path.endsWith('technical_notes.txt')&&d.kind==='file'));
 await f.service.start('sync');assert.ok(!fs.existsSync(path.join(f.en,'technical_notes.txt')));
 // Independent paired content is protected on deletion, even though later simultaneous edits prefer Chinese.
 write(path.join(f.en,'new.txt'),'Independent EN');write(path.join(f.cn,'new.txt'),'独立中文');await f.service.start('sync');
 // Both additions on an established baseline are Chinese-authoritative, so make the opposite manually edited while deleting English.
 write(path.join(f.cn,'new.txt'),'人工保留');fs.unlinkSync(path.join(f.en,'new.txt'));j=await f.service.start('sync');assert.equal(fs.readFileSync(path.join(f.en,'new.txt'),'utf8'),'EN:Translated');assert.ok(j.warnings.some(w=>w.includes('Chinese wins')));
});
test('removed whole Process cleans owned counterpart and orphan derived summaries',async t=>{
 const f=fixture(t);const project=path.join(f.libraryPath,'product_lib/A/factory_test/processes/Q');write(path.join(project,'metadata.txt'),'Project camera');write(path.join(project,'operation_steps.txt'),'Check port.');await f.service.start('sync');
 fs.rmSync(project,{recursive:true});fs.rmSync(f.en,{recursive:true});const j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.ok(!fs.existsSync(f.cn));assert.ok(!fs.existsSync(path.join(f.libraryPath,'product_lib/A/factory_test/CN_process/Q')));assert.ok(!fs.existsSync(path.join(f.libraryPath,'product_lib/A/factory_test/derived/Q/summary.json')));
});
test('Library lock excludes sync, pending checkpoint is recovered, cancel interrupts model and resume is explicit',async t=>{
 const f=fixture(t);const release=acquireLibraryLock(f.libraryPath);const j=f.service.create('sync');await assert.rejects(f.service.resume(j.id),/busy/u);release();
 const running=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model:{async complete(_r,signal){return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}},imageChecker:f.imageChecker});
 const promise=running.resume(j.id);await new Promise(r=>setTimeout(r,25));await running.cancel(j.id);const cancelled=await promise;assert.equal(cancelled.status,'cancelled');assert.ok(!fs.existsSync(libraryPendingMarker(f.libraryPath)));
});
test('HTTP overall entry is async, lists with existing jobs, rejects foreign origins, has separate calibration endpoint',async t=>{
 const f=fixture(t),app=createCkdUiServer({libraryPath:f.libraryPath,dataDir:f.dataDir,maintenanceModel:f.model,imageQualityModel:{async complete(){return {text:JSON.stringify(assessmentSeen),model:'vision'};}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(async()=>{await app.maintenance.shutdown();await new Promise<void>(r=>app.server.close(()=>r()));});const address=app.server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
 const response=await fetch(base+'/api/library/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dryRun:true})});assert.equal(response.status,202);const {job}=await response.json() as any;assert.equal(job.kind,'sync');
 const progress=await (await fetch(base+`/api/library/jobs/${job.id}/progress`)).json() as any;assert.equal(progress.job.id,job.id);assert.equal(progress.job.items,undefined);assert.equal(progress.job.sync?.images,undefined);
 const listing=await (await fetch(base+'/api/library/jobs/progress')).json() as any;assert.ok(listing.jobs.some((item:any)=>item.id===job.id));assert.equal(listing.jobs.find((item:any)=>item.id===job.id).items,undefined);
 const full=await (await fetch(base+`/api/library/jobs/${job.id}`)).json() as any;assert.ok(Array.isArray(full.job.items));
 assert.equal((await fetch(base+'/api/library/sync',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://foreign.invalid'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/library/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"projectId":"A"}'})).status,400);
 const html=await (await fetch(base+'/')).text();assert.ok(html.includes('sync-library'));assert.ok(html.includes('open-reference-calibration'));
});

test('independent deletion is retained as a tombstone; later untouched sync never regenerates the deleted side',async t=>{
 const f=fixture(t);write(path.join(f.en,'manual.txt'),'Human English');write(path.join(f.cn,'manual.txt'),'人工中文');await f.service.start('sync');fs.unlinkSync(path.join(f.en,'manual.txt'));
 let j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.ok(!fs.existsSync(path.join(f.en,'manual.txt')));assert.equal(fs.readFileSync(path.join(f.cn,'manual.txt'),'utf8'),'人工中文');assert.ok(j.warnings.some(w=>w.includes('independent/edited counterpart retained')));
 j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.ok(!fs.existsSync(path.join(f.en,'manual.txt')));
});
test('partial image error still updates summaries, restart only requests missing image review; deleted images leave current index',async t=>{
 const f=fixture(t);write(path.join(f.en,'photos/p1.png'),png);let fail=true,calls=0;const checker=new ImageAssessmentChecker(f.dataDir,{model:{async complete(){calls++;if(fail){fail=false;throw new Error('temporary vision failure');}return {text:JSON.stringify(assessmentSeen),model:'vision'};}}});
 const service=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model:f.model,imageChecker:checker});let j=await service.start('sync');assert.equal(j.status,'partial_failed',JSON.stringify(j));assert.ok(fs.existsSync(path.join(f.en,'summary.json')));assert.equal(j.sync!.stages.summaries!.status,'completed');
 saveImagePolicy(f.dataDir,{...structuredClone(DEFAULT_POLICY),alertThreshold:60});j=await new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model:f.model,imageChecker:checker}).resume(j.id);assert.equal(j.sync!.imageContext!.policy.alertThreshold,80);assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(calls,3);
 fs.unlinkSync(path.join(f.en,'photos/p1.png'));j=await service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(j.sync!.images!.length,0);const index=JSON.parse(fs.readFileSync(path.join(f.dataDir,'ckd/library-cache',sha(f.libraryPath),'image-index.json'),'utf8'));assert.deepEqual(index.images,{});
});
test('protocol failures have separate zero warnings and index metadata while summaries continue and calibration stays strict',async t=>{
 const f=fixture(t);write(path.join(f.en,'photos/p1.png'),png);let calls=0;const checker=new ImageAssessmentChecker(f.dataDir,{model:{async complete(){calls++;return {text:'[]',model:'vision'};}}});const service=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model:f.model,imageChecker:checker});
 const job=await service.start('sync');assert.equal(job.status,'partial_failed');assert.equal(job.sync!.stages.summaries!.status,'completed');assert.ok(fs.existsSync(path.join(f.en,'summary.json')));assert.equal(calls,3);assert.equal(job.sync!.images!.length,2);for(const image of job.sync!.images!){assert.equal(image.result,undefined);assert.equal(image.fallback!.score,0);assert.equal(image.fallback!.reminder,true);assert.ok(image.error);}
 const index=JSON.parse(fs.readFileSync(path.join(f.dataDir,'ckd/library-cache',sha(f.libraryPath),'image-index.json'),'utf8'));for(const image of Object.values(index.images) as any[]){assert.equal(image.score,0);assert.equal(image.analysisSucceeded,false);assert.equal(image.reminder,true);}
 await assert.rejects(checker.check(png),/after 3 format attempts/u);assert.equal(calls,6);
});
test('a new one-click sync retries previously cached image failures and reuses the successful score',async t=>{
 const f=fixture(t);write(path.join(f.en,'photos/p1.png'),png);let valid=false,calls=0;
 const checker=new ImageAssessmentChecker(f.dataDir,{model:{async complete(){calls++;return {text:valid?JSON.stringify(assessmentSeen):'[]',model:'vision'};}}});
 const service=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model:f.model,imageChecker:checker});
 let job=await service.start('sync');assert.equal(job.status,'partial_failed');assert.equal(calls,3);
 valid=true;job=await service.start('sync');assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.sync!.stages.images!.status,'completed');assert.equal(calls,5);
 job=await service.start('sync');assert.equal(job.status,'completed');assert.equal(calls,5);
});
test('translation failure blocks remaining stages; restart reuses committed pairs and applies corrected model',async t=>{
 const f=fixture(t);let broken=true;const model:LibraryModel={async complete(req,signal){if(req.purpose==='translate'&&JSON.parse(req.prompt).text==='Check port.'&&broken)return {text:'{"text":""}',model:'text'};return f.model.complete(req,signal);}};
 const service=new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model,imageChecker:f.imageChecker});let j=await service.start('sync');assert.equal(j.status,'partial_failed',JSON.stringify(j));assert.ok(!j.sync!.stages.images);assert.ok(!fs.existsSync(path.join(f.cn,'summary.json')));broken=false;j=await service.resume(j.id);assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(j.sync!.attempts![0]!.status,'partial_failed');assert.ok(j.sync!.attempts![0]!.counts.error>0);assert.ok(!j.warnings.some(w=>w.includes('Translation has errors')));
});
test('common change refreshes inherited project summaries while explicit empty project override remains empty',async t=>{
 const f=fixture(t),project=path.join(f.libraryPath,'product_lib/A/factory_test/processes/P');fs.mkdirSync(project,{recursive:true});write(path.join(project,'technical_notes.txt'),'');write(path.join(f.en,'technical_notes.txt'),'Common note.');await f.service.start('sync');
 const derived=path.join(f.libraryPath,'product_lib/A/factory_test/derived/P/summary.json'),before=fileHash(derived);write(path.join(f.en,'operation_steps.txt'),'Changed common steps.');const j=await f.service.start('sync');assert.equal(j.status,'completed',JSON.stringify(j));assert.notEqual(fileHash(derived),before);const summary=JSON.parse(fs.readFileSync(derived,'utf8'));assert.ok(JSON.stringify(summary).includes('Changed common steps.'));assert.ok(!JSON.stringify(summary).includes('Common note.'));
});
test('persisted committed checkpoint recovers without reverse translation, snapshots are stable after policy changes',async t=>{
 const f=fixture(t);await f.service.start('sync');write(path.join(f.en,'operation_steps.txt'),'Updated English.');const cn=path.join(f.cn,'operation_steps.txt');write(cn,'中：Updated English.');const job=f.service.create('sync'),key=path.relative(f.libraryPath,path.join(f.en,'operation_steps.txt'));
 job.sync={stage:'translate',attempt:1,stages:{},checkpoint:{key,entry:{en:key,cn:path.relative(f.libraryPath,cn),kind:'file',enHash:fileHash(path.join(f.en,'operation_steps.txt')),cnHash:fileHash(cn),generated:'cn'}}};atomicJson(path.join(f.dataDir,'ckd/library-jobs',job.id,'state.json'),job);
 const j=await f.service.resume(job.id);assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(fs.readFileSync(path.join(f.en,'operation_steps.txt'),'utf8'),'Updated English.');assert.ok(!j.warnings.some(w=>w.includes('Chinese wins')));
});

test('interrupted deletion rollback restores bytes and translation ownership when source changed',async t=>{
 const f=fixture(t);write(path.join(f.en,'technical_notes.txt'),'Keep dry.');await f.service.start('sync');const source=path.relative(f.libraryPath,path.join(f.en,'technical_notes.txt')),target=path.relative(f.libraryPath,path.join(f.cn,'technical_notes.txt')),bytes=fs.readFileSync(path.join(f.cn,'technical_notes.txt')),before=fileHash(path.join(f.cn,'technical_notes.txt'))!;
 const registryFile=path.join(f.dataDir,'ckd/library-cache',sha(f.libraryPath),'managed-translations.json'),registry=JSON.parse(fs.readFileSync(registryFile,'utf8')),previousTranslation=registry[target];delete registry[target];atomicJson(registryFile,registry);
 const job=f.service.create('sync'),directory=path.join(f.dataDir,'ckd/library-jobs',job.id);write(path.join(directory,'backups/removed'),bytes);fs.unlinkSync(path.join(f.cn,'technical_notes.txt'));
 job.pending={key:'translate:'+target,sources:{[source]:null},journal:'transactions/removed.json',writes:[{relative:target,before,after:null,backup:'backups/removed',previousTranslation}]};atomicJson(path.join(directory,'state.json'),job);atomicJson(libraryPendingMarker(f.libraryPath),{jobId:job.id,directory});
 const restored=await f.service.resume(job.id);assert.equal(restored.status,'failed');assert.deepEqual(fs.readFileSync(path.join(f.cn,'technical_notes.txt')),bytes);assert.deepEqual(JSON.parse(fs.readFileSync(registryFile,'utf8'))[target],previousTranslation);assert.ok(!fs.existsSync(libraryPendingMarker(f.libraryPath)));
});
test('external edits during translation are not overwritten; dry run never changes any Library byte',async t=>{
 const f=fixture(t),before=fileHash(f.libraryPath);await f.service.start('sync',{dryRun:true});assert.equal(fileHash(f.libraryPath),before);let once=false;
 const model:LibraryModel={async complete(req,signal){if(req.purpose==='translate'&&!once){once=true;write(path.join(f.cn,'metadata.txt'),'外部修改');}return f.model.complete(req,signal);}};
 const j=await new LibraryMaintenance({libraryPath:f.libraryPath,dataDir:f.dataDir,model,imageChecker:f.imageChecker}).start('sync');assert.equal(j.status,'partial_failed',JSON.stringify(j));assert.equal(fs.readFileSync(path.join(f.cn,'metadata.txt'),'utf8'),'外部修改');assert.ok(!j.sync!.stages.summaries);
});

test('CN JPEG operation photos are copied to the English process', async t => {
  const f = fixture(t);
  const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  write(path.join(f.cn, 'photos/p1.jpg'), jpg);
  fs.mkdirSync(path.join(f.en, 'photos'), { recursive: true });
  const job = await f.service.start('sync');
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.ok(fs.existsSync(path.join(f.en, 'photos/p1.jpg')));
  assert.deepEqual(fs.readFileSync(path.join(f.en, 'photos/p1.jpg')), jpg);
});