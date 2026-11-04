import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {once} from 'node:events';
import {ImageAssessmentChecker,DEFAULT_POLICY} from '../src/ckd/image-assessment.js';
import {ModelOutputError} from '../src/ckd/library-model.js';
import {reviewSopImages} from '../src/ckd/image-quality.js';
import {CkdWorkflow} from '../src/ckd/service.js';
import {createCkdUiServer} from '../src/ckd/ui-server.js';
import {defaultResources} from '../src/ckd/scripts.js';
import type {CkdRun,WorkflowStepSubmission} from '../src/ckd/types.js';
import {assessmentSeen} from './helpers/image-assessment.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
const valid=()=>({text:JSON.stringify(assessmentSeen),model:'fake'});
function fixture(t:{after(fn:()=>void):void}){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-image-fallback-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function put(file:string,data:string|Buffer){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
test('protocol fallback is zero with warning, separate from success caches, reusable and recoverable by strict retry',async t=>{
 const root=fixture(t);let invalid=true,calls=0;const checker=new ImageAssessmentChecker(root,{model:{async complete(){calls++;return invalid?{text:'[]',model:'fake'}:valid();}}});
 const first=await checker.checkWithFallback(png);assert.equal(calls,3);assert.equal(first.result,undefined);assert.equal(first.fallback!.score,0);assert.equal(first.fallback!.reminder,true);assert.equal(first.fallback!.analysisSucceeded,false);assert.equal(first.fallback!.retryable,true);assert.match(first.fallback!.reason,/不代表图片实际质量/u);assert.deepEqual(fs.readdirSync(checker.root),[]);
 assert.equal((await checker.checkWithFallback(png)).fallback!.cached,true);assert.equal(calls,3);
 invalid=false;const recovered=await checker.check(png);assert.equal(recovered.score,94);assert.equal(calls,5);
 const file=path.join(checker.root,recovered.imageHash+'.json'),before=fs.readFileSync(file),mtime=fs.statSync(file).mtimeMs;
 const normal=await checker.checkWithFallback(png);assert.equal(normal.fallback,undefined);assert.equal(normal.result!.score,94);assert.equal(normal.result!.cached,true);assert.equal(calls,5);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).mtimeMs,mtime);
});
test('invalid inputs, cancellation, timeout, configuration and provider errors retain their errors; truncation alone gets fallback',async t=>{
 const root=fixture(t);const checker=new ImageAssessmentChecker(root,{model:{async complete(){throw new Error('provider failed');}}});await assert.rejects(checker.checkWithFallback(Buffer.from('bad')),/valid PNG/iu);await assert.rejects(checker.checkWithFallback(png),/provider failed/u);
 const controller=new AbortController();controller.abort(new Error('cancel'));await assert.rejects(checker.checkWithFallback(png,controller.signal),/cancel/u);
 const timeout=new ImageAssessmentChecker(root,{timeoutMs:5,model:{async complete(){return new Promise(()=>{});}}});await assert.rejects(timeout.checkWithFallback(png),/timeout/iu);
 const truncated=new ImageAssessmentChecker(root,{model:{async complete(){throw new ModelOutputError('Model returned empty or incomplete output (length).');}}});assert.equal((await truncated.checkWithFallback(png)).fallback!.score,0);
});
test('SOP report includes one zero per failed Hash in average, warns on duplicates, and never fabricates seven metrics',async t=>{
 const root=fixture(t),run={id:'run',workspaceRoot:root,workspaceRelative:'run'} as CkdRun,effective=path.join(root,'run/effective-processes/run');
 put(path.join(effective,'one/photos/p1.png'),png);put(path.join(effective,'one/photos/p2.png'),png);put(path.join(effective,'one/photos/p3.png'),Buffer.concat([png,Buffer.from('good')]));
 let calls=0;const checker=new ImageAssessmentChecker(root,{model:{async complete(req){if(req.purpose!=='vision')return {text:JSON.stringify({subjectIndex:0,detailsVisible:'yes',confidence:.9,comment:'匹配'}),model:'fake'};calls++;return req.image!.equals(png)?{text:'[]',model:'fake'}:valid();}}});
 const submission:WorkflowStepSubmission={summary:'Generated',artifacts:[],output:{sopType:'assembly_test',processReviews:[{processId:'one',processName:'One'}]}};
 const result=await reviewSopImages(run,submission,checker,defaultResources,new AbortController().signal),report=(result.output as any).imageQuality;
 assert.equal(report.overallScore,47);assert.equal(report.fallbackUniqueImages,1);assert.equal(report.scoredUniqueImages,1);assert.equal(report.errorCount,2);assert.equal(report.reminderCount,2);assert.equal(report.thresholdReminderCount,2);assert.equal(calls,5);
 assert.equal(report.images[0].result,undefined);assert.equal(report.images[0].fallback.score,0);assert.equal(report.images[1].fallback.cached,true);assert.equal(report.images[2].result.score,94);assert.equal(report.images[0].operationFocus,undefined);
 assert.match(report.failureNote,/0分兜底/u);assert.match(report.scoringNote,/计入不同图片的平均分/u);
});
test('workflow still completes with Excel, failure report zero, and older completed task files remain byte-identical',async t=>{
 const root=fixture(t),libraryPath=path.join(root,'ckd-library-v2'),dataDir=path.join(root,'data');put(path.join(libraryPath,'product_lib/TARGET/project.json'),JSON.stringify({version:1,projectId:'TARGET',displayName:'Target',aliases:[]}));
 const folder=path.join(libraryPath,'processes_lib/factory_test/camera_test');put(path.join(folder,'metadata.txt'),'Camera Test\n');put(path.join(folder,'operation_steps.txt'),'Check camera.\n');put(path.join(folder,'photos/p1.png'),png);
 const input={projectName:'TARGET',sopName:'Camera',documentNumber:'TEST',author:'Test',sopType:'factory_test',factoryTestProcesses:['Camera Test']};
 const oldService=new CkdWorkflow({dataDir,libraryPath,imageQualityModel:{async complete(req){return req.purpose==='vision'?valid():{text:JSON.stringify({subjectIndex:0,detailsVisible:'yes',confidence:.9,comment:'匹配'}),model:'fake'};}}});const old=await oldService.start(input);assert.equal(old.status,'completed');
 const protectedFiles=[path.join(dataDir,'ckd/runs',old.id,'state.json'),...old.finalResult!.artifacts.map(f=>path.resolve(old.workspaceRoot,f))],before=protectedFiles.map(f=>fs.readFileSync(f));
 const service=new CkdWorkflow({dataDir:path.join(root,'failed-data'),libraryPath,imageQualityModel:{async complete(){return {text:'[]',model:'fake'};}}});const run=await service.start(input);assert.equal(run.status,'completed',run.error);const output=run.finalResult!.output as any;assert.equal(output.imageQuality.overallScore,0);assert.equal(output.imageQuality.reminderCount,1);assert.equal(output.imageQuality.errorCount,1);assert.deepEqual(output.processReviews,(old.finalResult!.output as any).processReviews);assert.ok(fs.existsSync(path.resolve(run.workspaceRoot,run.finalResult!.artifacts[0]!)));
 protectedFiles.forEach((f,i)=>assert.deepEqual(fs.readFileSync(f),before[i]));
});
test('API exposes separate zero fallback, caches failure, and explicit retry can replace it with a valid result',async t=>{
 const root=fixture(t);let invalid=true,calls=0;const app=createCkdUiServer({dataDir:root,imageQualityModel:{async complete(){calls++;return invalid?{text:'[]',model:'fake'}:valid();}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.server.closeAllConnections();app.server.close();});const address=app.server.address() as {port:number},url=`http://127.0.0.1:${address.port}/api/images/quality`;
 const post=(suffix='')=>fetch(url+suffix,{method:'POST',headers:{'Content-Type':'image/png'},body:new Uint8Array(png)});
 let r=await post('?context=检查孔边');assert.equal(r.status,200);let v=await r.json();assert.equal(v.result,null);assert.equal(v.fallback.score,0);assert.equal(v.fallback.analysisSucceeded,false);assert.equal(calls,3);
 v=await(await post()).json();assert.equal(v.fallback.cached,true);assert.equal(calls,3);assert.equal((await post('?retry=invalid')).status,400);
 invalid=false;v=await(await post('?retry=true')).json();assert.equal(v.result.score,94);assert.equal(v.fallback,undefined);assert.equal(calls,5);v=await(await post()).json();assert.equal(v.result.cached,true);assert.equal(calls,5);
});
test('low confidence remains unscored under existing rules, not an analysis failure zero',async t=>{
 const root=fixture(t),data=structuredClone(assessmentSeen);data.metrics.exposure.confidence=.5;const checker=new ImageAssessmentChecker(root,{model:{async complete(){return {text:JSON.stringify(data),model:'fake'};}}});const outcome=await checker.checkWithFallback(png,undefined,null,DEFAULT_POLICY);assert.equal(outcome.result!.score,null);assert.equal(outcome.fallback,undefined);
});
