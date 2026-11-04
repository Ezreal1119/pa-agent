import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { PixelImageChecker,PIXEL_VERSION,PIXEL_POLICY,executePixelWorker,enqueuePixel,withPixelLock } from '../src/ckd/image-pixel.js';
import { scoringContext,scorerForContext,checkOperationFocus } from '../src/ckd/image-scorer.js';
import { ImageAssessmentChecker } from '../src/ckd/image-assessment.js';
import { ImagePrewarmJobs } from '../src/ckd/image-prewarm.js';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
import { reviewSopImages } from '../src/ckd/image-quality.js';
import { defaultResources } from '../src/ckd/scripts.js';
import { assessmentSeen } from './helpers/image-assessment.js';
import type { LibraryModel } from '../src/ckd/library-model.js';
import type { CkdRun,WorkflowStepSubmission } from '../src/ckd/types.js';
import { CkdWorkflow } from '../src/ckd/service.js';
import ExcelJS from 'exceljs';
import { LibraryMaintenance } from '../src/ckd/library-maintenance.js';
import { mockTranslated } from './helpers/mock-translation.js';

const assets=fileURLToPath(new URL('../resources/image-quality/v1.23.0/',import.meta.url));
const python=process.env.CKD_SCORER_PYTHON??'python3';
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-pixel-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
const png=(r=128)=>sharp({create:{width:129,height:257,channels:3,background:{r,g:r,b:r}}}).png().toBuffer();
const noModel:LibraryModel={async complete(){throw new Error('Pixel scoring must not call a model');}};
function stub(root:string,code:string){const file=path.join(root,'stub.py');fs.writeFileSync(file,`import sys\nsys.path.insert(0,${JSON.stringify(assets)})\n${code}\n`);return file;}
async function until(fn:()=>boolean){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out waiting for test process');}

test('pixel scoring is deterministic, isolated from old caches, and partial failures never become success caches',async t=>{
  const root=fixture(t),bytes=await png(),checker=new PixelImageChecker(root,{model:noModel});
  const first=await checker.check(bytes);assert.equal(first.algorithmVersion,'1.23.0');assert.equal(first.components.length,7);assert.equal(first.components.find(c=>c.key==='color')!.rawScore,100);assert.equal(first.cached,false);
  const again=await new PixelImageChecker(root,{model:noModel}).check(bytes);assert.equal(again.cached,true);assert.deepEqual(again.referenceResult,first.referenceResult);
  const cached=path.join(checker.root,first.imageHash+'.json'),saved=JSON.parse(fs.readFileSync(cached,'utf8'));saved.implementationHash='obsolete';fs.writeFileSync(cached,JSON.stringify(saved));assert.equal((await checker.check(bytes)).cached,false);
  const tampered=JSON.parse(fs.readFileSync(cached,'utf8'));tampered.reference.final_score=100;fs.writeFileSync(cached,JSON.stringify(tampered));const repaired=await checker.check(bytes);assert.equal(repaired.cached,false);assert.equal(repaired.score,first.score);
  const bad={...checker.policy(),weights:{...checker.policy().weights,clarity:30}};await assert.rejects(checker.check(bytes,undefined,checker.calibration(),bad),/配置快照不匹配/u);
  const partialRoot=path.join(root,'partial'),workerPath=stub(root,"import worker\ndef fail(*args): raise MemoryError('forced allocation failure')\nworker.ref.MEASURERS['color']=fail\nworker.main()");
  const partial=new PixelImageChecker(partialRoot,{pythonPath:python,workerPath});const failed=await partial.check(bytes);
  assert.equal(failed.referenceResult.dimension_scores.color,70);assert.equal(failed.referenceResult.analysis.color.method,'error');assert.equal(failed.reminder,true);assert.equal(failed.evaluationStatus,'partial_failed');assert.equal(failed.status,'needs_review');assert.equal(failed.dimensionErrors[0]!.dimension,'color');
  assert.equal(fs.existsSync(path.join(partial.root,failed.imageHash+'.json')),false);
  assert.equal(fs.readdirSync(partial.root).some(n=>n.startsWith('.input-')),false);
});

test('global queue can cancel waiting clients, serializes checker instances and releases cross-process locks',async t=>{
  const root=fixture(t),signal=new AbortController().signal;let release!:()=>void;
  const started=new Promise<void>(resolve=>{release=resolve;});let running=0,max=0;
  const first=enqueuePixel(root,signal,async()=>{running++;max=Math.max(max,running);await started;running--;return 1;});
  const controller=new AbortController();const queued=enqueuePixel(root,controller.signal,async()=>{throw new Error('Cancelled queue entry ran');});controller.abort(new Error('queued cancellation'));await assert.rejects(queued,/queued cancellation/u);
  const second=enqueuePixel(root,signal,async()=>{running++;max=Math.max(max,running);running--;return 2;});release();assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.equal(max,1);
  const log=path.join(root,'lock.log'),modulePath=fileURLToPath(new URL('../src/ckd/image-pixel.ts',import.meta.url));
  const code=`import fs from 'node:fs';import {withPixelLock} from ${JSON.stringify(modulePath)};await withPixelLock(${JSON.stringify(root)},new AbortController().signal,async()=>{fs.appendFileSync(${JSON.stringify(log)},'start\\n');await new Promise(r=>setTimeout(r,150));fs.appendFileSync(${JSON.stringify(log)},'end\\n');});`;
  const run=()=>new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',b=>{err+=b;});child.on('error',reject);child.on('close',n=>n===0?resolve():reject(new Error(err)));});
  await Promise.all([run(),run()]);assert.equal(fs.readFileSync(log,'utf8'),'start\nend\nstart\nend\n');
  const held=await withPixelLock(root,signal,async()=>true);assert.equal(held,true);
});

test('worker timeout, active cancellation and malformed output do not leave a live child or successful cache',async t=>{
  const root=fixture(t),file=path.join(root,'image.png');fs.writeFileSync(file,await png());
  const workerPath=stub(root,'import time\ntime.sleep(10)');
  await assert.rejects(executePixelWorker(file,new AbortController().signal,{pythonPath:python,workerPath,timeoutMs:30}),/超时/u);
  const marker=path.join(root,'started');stub(root,`from pathlib import Path\nimport time\nPath(${JSON.stringify(marker)}).write_text('started')\ntime.sleep(10)`);
  const controller=new AbortController(),pending=executePixelWorker(file,controller.signal,{pythonPath:python,workerPath});await until(()=>fs.existsSync(marker));controller.abort(new Error('cancel active'));await assert.rejects(pending,/cancel active/u);
  stub(root,"print('not json')");await assert.rejects(executePixelWorker(file,new AbortController().signal,{pythonPath:python,workerPath}),/invalid JSON/u);
  if(process.platform==='linux'){
    stub(root,"import worker, resource\nassert resource.getrlimit(resource.RLIMIT_AS)==(2*1024**3,2*1024**3)\nbytearray(3*1024**3)");
    const limited=new PixelImageChecker(path.join(root,'memory-limit'),{pythonPath:python,workerPath});
    await assert.rejects(limited.check(fs.readFileSync(file)),/需要人工复核.*MemoryError/su);
    assert.equal(fs.readdirSync(limited.root).some(name=>name.endsWith('.json')||name.startsWith('.input-')),false);
  }
});

test('new and historical scoring snapshots select the right engine; AI focus is independent of pixel totals',async t=>{
  const root=fixture(t);let calls=0;
  const model:LibraryModel={async complete(request){calls++;return {model:'fake',text:JSON.stringify(request.purpose==='vision'?assessmentSeen:{subjectIndex:0,detailsVisible:'yes',confidence:.95,comment:'Independent focus check'})};}};
  const pixel=new PixelImageChecker(root,{model}),legacy=new ImageAssessmentChecker(root,{model});
  assert.ok(scorerForContext(pixel,scoringContext(legacy)) instanceof ImageAssessmentChecker);
  assert.ok(scorerForContext(legacy,scoringContext(pixel)) instanceof PixelImageChecker);
  assert.throws(()=>scorerForContext(pixel,{...scoringContext(pixel),configHash:'wrong'}),/changed/u);
  const bytes=await png(),result=await pixel.check(bytes);assert.equal(calls,0);
  const focus=await checkOperationFocus(pixel,result,bytes,'Check this part',new AbortController().signal);assert.equal(focus.comment,'Independent focus check');assert.equal(calls,3);
  assert.deepEqual((await pixel.check(bytes)).referenceResult,result.referenceResult);
});

test('pixel HTTP policy is fixed, single-image checks do not call AI and status polling stays responsive',async t=>{
  const root=fixture(t),app=createCkdUiServer({dataDir:root,libraryPath:root,adminAuth:false,imageScorer:'pixel-v1.23.0',imageQualityModel:noModel});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise<void>(resolve=>app.server.close(()=>resolve())));
  const address=app.server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const policy=await (await fetch(base+'/api/images/policy')).json();assert.equal(policy.readOnly,true);assert.deepEqual(policy.policy,PIXEL_POLICY);
  const calibration=await (await fetch(base+'/api/images/calibration')).json();assert.equal(calibration.mode,'fixed');assert.deepEqual(Object.keys(calibration.calibration.curves),['clarity']);
  for(const route of ['policy','calibrate'])assert.equal((await fetch(base+'/api/images/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,409);
  const bytes=await sharp({create:{width:1537,height:1025,channels:3,background:'gray'}}).png().toBuffer();
  const pending=fetch(base+'/api/images/quality',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes});
  assert.equal((await fetch(base+'/api/status')).status,200);
  const response=await pending;assert.equal(response.status,200);const value=await response.json();assert.equal(value.result.ruleVersion,PIXEL_VERSION);assert.equal(value.result.referenceResult.analysis.color.score,100);
});

test('SOP review and prewarm share pixel caches; a saved legacy SOP context still uses the legacy engine',async t=>{
  const root=fixture(t),data=path.join(root,'data'),workspace=path.join(root,'runs'),run={id:'run',workspaceRoot:workspace,workspaceRelative:'run'} as CkdRun;
  const folder=path.join(workspace,'run/effective-processes/run/one/photos');fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(path.join(workspace,'run/outputs'),{recursive:true});const bytes=await png();fs.writeFileSync(path.join(folder,'p1.png'),bytes);
  const checker=new PixelImageChecker(data,{model:noModel});
  const result:WorkflowStepSubmission={summary:'Test',output:{sopType:'factory_test',processReviews:[{processId:'one',processName:'One'}]},artifacts:[]};
  const reviewed=await reviewSopImages(run,result,checker,defaultResources,new AbortController().signal);
  const report=(reviewed.output as any).imageQuality;assert.equal(report.ruleVersion,PIXEL_VERSION);assert.equal(report.totalImages,1);assert.equal(report.images[0].result.score,(await checker.check(bytes)).score);assert.equal(report.overallScore,report.images[0].result.score);assert.match(report.images[0].focusError,/must not call/u);
  const contextFile=path.join(workspace,'run/outputs/image-quality-context.json');const context=JSON.parse(fs.readFileSync(contextFile,'utf8'));assert.equal(context.configHash,scoringContext(checker).configHash);
  const library=path.join(root,'library'),photo=path.join(library,'processes_lib/pcba_test/one/photos');fs.mkdirSync(photo,{recursive:true});fs.writeFileSync(path.join(photo,'p1.png'),bytes);
  const prewarm=new ImagePrewarmJobs(data,{imageScorer:'pixel-v1.23.0',model:noModel});const job=await prewarm.resume(prewarm.create(library,3).id);assert.equal(job.status,'completed',job.error);assert.equal(job.reused,1);
  const model:LibraryModel={async complete(){return {model:'fake',text:JSON.stringify(assessmentSeen)};}};
  const legacy=new ImageAssessmentChecker(data,{model}),legacySnapshot=scoringContext(legacy);fs.writeFileSync(contextFile,JSON.stringify({...legacySnapshot,ruleVersion:legacySnapshot.analysisVersion}));
  const restored=await reviewSopImages(run,result,new PixelImageChecker(data,{model}),defaultResources,new AbortController().signal);assert.equal((restored.output as any).imageQuality.ruleVersion,legacySnapshot.analysisVersion);
});

test('pixel SOP flow preserves manual cropping and embeds the cropped picture in the generated Excel',async t=>{
  const root=fixture(t),library=path.join(root,'library/ckd-library-v2'),processFolder=path.join(library,'processes_lib/factory_test/P');
  fs.mkdirSync(path.join(library,'product_lib/PIXEL'),{recursive:true});fs.writeFileSync(path.join(library,'product_lib/PIXEL/project.json'),JSON.stringify({projectId:'PIXEL',displayName:'Pixel Project',aliases:[]}));
  fs.mkdirSync(path.join(processFolder,'photos'),{recursive:true});fs.writeFileSync(path.join(processFolder,'metadata.txt'),'Camera Test\n');fs.writeFileSync(path.join(processFolder,'operation_steps.txt'),'Check camera image.\n');
  const bytes=await png();fs.writeFileSync(path.join(processFolder,'photos/p1.png'),bytes);
  const workflow=new CkdWorkflow({dataDir:path.join(root,'data'),libraryPath:library,imageScorer:'pixel-v1.23.0',imageQualityModel:noModel});
  const created=workflow.create({projectName:'PIXEL',documentNumber:'PIXEL-001',sopName:'Pixel Crop',author:'Acceptance',sopType:'factory_test',templateLanguage:'English',factoryTestProcesses:['Camera Test']},true);
  const initialContext=JSON.parse(fs.readFileSync(path.join(created.workspaceRoot,created.workspaceRelative,'outputs/image-quality-context.json'),'utf8'));
  assert.equal(initialContext.analysisVersion,PIXEL_VERSION);assert.equal(initialContext.configHash,scoringContext(workflow.imageQuality).configHash);
  let run=await workflow.resume(created.id);assert.equal(run.status,'awaiting_image_review',run.error);const stage=run.imageReview!;assert.equal(stage.images.length,1);assert.equal((stage.prepared.output as any).imageQuality.ruleVersion,PIXEL_VERSION);
  run=await workflow.crop(run.id,{reviewId:stage.id,revision:stage.revision,imageId:stage.images[0]!.id,rect:{left:0,top:0,width:64,height:128}});
  run=await workflow.generate(run.id,{reviewId:run.imageReview!.id,revision:run.imageReview!.revision});assert.equal(run.status,'completed',run.error);
  const xlsx=run.finalResult!.artifacts.find(file=>file.endsWith('.xlsx'))!;assert.ok(xlsx);
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(path.resolve(run.workspaceRoot,xlsx));
  assert.ok(book.worksheets.some(sheet=>sheet.getImages().length>0));
  const media=(book.model as any).media as {buffer?:Buffer;filename?:string}[];
  let found=false;for(const image of media){if(!image.buffer)continue;const metadata=await sharp(Buffer.from(image.buffer)).metadata();if(metadata.width===64&&metadata.height===128)found=true;}
  assert.equal(found,true,'Excel contains the explicitly cropped 64×128 image');assert.deepEqual(fs.readFileSync(path.join(processFolder,'photos/p1.png')),bytes);
});

test('Library synchronization uses the fixed pixel snapshot and reuses it on an unchanged bilingual rerun',async t=>{
  const root=fixture(t),data=path.join(root,'data'),library=path.join(root,'ckd-library-v2'),folder=path.join(library,'processes_lib/factory_test/P');
  fs.mkdirSync(path.join(folder,'photos'),{recursive:true});fs.mkdirSync(path.join(library,'product_lib/A'),{recursive:true});
  fs.writeFileSync(path.join(library,'product_lib/A/project.json'),JSON.stringify({projectId:'A',displayName:'A',aliases:[]}));
  fs.writeFileSync(path.join(folder,'metadata.txt'),'Camera');fs.writeFileSync(path.join(folder,'operation_steps.txt'),'Check camera.');const bytes=await png();fs.writeFileSync(path.join(folder,'photos/p1.png'),bytes);
  let calls=0;const model:LibraryModel={async complete(r){calls++;if(r.purpose==='translate'){const i=JSON.parse(r.prompt);return {model:'text',text:JSON.stringify({text:mockTranslated(i.text,i.targetLanguage)})};}return {model:'fake',text:r.purpose==='vision'?'Visible camera.':'Check camera.'};}};
  const checker=new PixelImageChecker(data,{model:noModel}),maintenance=new LibraryMaintenance({dataDir:data,libraryPath:library,model,imageChecker:checker});
  const queued=maintenance.create('sync');assert.equal(queued.imageContext!.analysisVersion,PIXEL_VERSION);assert.equal(queued.imageContext!.configHash,scoringContext(checker).configHash);
  let job=await maintenance.resume(queued.id);assert.equal(job.status,'completed',job.error??JSON.stringify(job.items));assert.equal(job.sync!.imageContext!.analysisVersion,PIXEL_VERSION);assert.equal(job.sync!.images!.length,2);
  assert.equal(job.sync!.images![0]!.result!.score,(await checker.check(bytes)).score);const previous=calls;
  job=await maintenance.start('sync');assert.equal(job.status,'completed',job.error);assert.equal(calls,previous);assert.ok(job.sync!.images!.every(i=>i.result?.cached));
});
