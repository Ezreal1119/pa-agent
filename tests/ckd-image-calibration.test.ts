import { assessmentSeen } from './helpers/image-assessment.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { ImageCalibration } from '../src/ckd/image-calibration.js';
import { ImageQualityChecker } from '../src/ckd/image-quality.js';
import { calibrationMetrics, DEFAULT_SCORE_PARAMETERS, fitImageScores, predictImageScore, scoreWithCalibration, type CalibrationSample } from '../src/ckd/image-scoring.js';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
import type { LibraryModel } from '../src/ckd/library-model.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
const observation={imageType:'object' as const,subject:'Camera assembly',confidence:0.95,boundingBox:{left:0.06,top:0.25,right:1,bottom:0.82},reason:'Connected equipment needs its ribbon cable and annotation context.'};
function fixture(t: {after(fn:()=>void):void}, model?:LibraryModel) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-ckd-calibration-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;const requests: unknown[]=[];
 const checker=new ImageQualityChecker(root,{model:model??{async complete(request){calls++;requests.push(request);return {text:JSON.stringify(observation),model:'fake-vision'};}}});
 const service=new ImageCalibration(root,checker);
 const put=(name:string,bytes:Buffer=png)=>fs.writeFileSync(path.join(service.samplesDir,name),bytes);
 const run=async()=>service.resume(service.create().id);
 return {root,checker,service,put,run,requests,get calls(){return calls;}};
}
test('numeric score is dominated by outer edges, ignores interior text, and alerts strictly below 80',()=>{
 const base=predictImageScore(observation,DEFAULT_SCORE_PARAMETERS)!; assert.equal(Math.round(base),66);
 assert.equal(scoreWithCalibration(observation,'fake').reminder,true);
 const full={...observation,boundingBox:{left:0,top:0,right:1,bottom:1}};
 assert.equal(predictImageScore(full,DEFAULT_SCORE_PARAMETERS),100);
 assert.equal(scoreWithCalibration({...observation,confidence:0.5},'fake').score,null);
 const parameters={...DEFAULT_SCORE_PARAMETERS,bias:80-base};
 assert.equal(Math.round(predictImageScore(observation,parameters)!),80);
 const shifted={...observation,boundingBox:{left:0,top:0.31,right:0.94,bottom:0.88}};
 assert.ok(predictImageScore(shifted,DEFAULT_SCORE_PARAMETERS)!<base); // same area, larger one-sided margin
});
test('few anchors fit only offset; larger synthetic data fit bounded parameters and reduce error',()=>{
 const one=[{imageHash:'a',humanScore:70,data:observation}];const small=fitImageScores(one);
 assert.equal(small.mode,'offset_only');assert.equal(Math.round(predictImageScore(observation,small.parameters)!),70);
 assert.equal(small.parameters.edgeWeight,80);assert.equal(small.parameters.areaWeight,15);
 const truth={...DEFAULT_SCORE_PARAMETERS,edgeWeight:110,areaWeight:8,bias:-5};
 const samples:CalibrationSample[]=Array.from({length:30},(_,i)=>{const margin=i/100;const data={...observation,boundingBox:{left:margin,top:margin,right:1-margin/2,bottom:1-margin}};return {imageHash:String(i),data,humanScore:predictImageScore(data,truth)!};});
 const large=fitImageScores(samples);assert.equal(large.mode,'weights_and_offset');
 assert.ok(calibrationMetrics(samples,large.parameters).mae<calibrationMetrics(samples,DEFAULT_SCORE_PARAMETERS).mae);
 assert.ok(large.parameters.edgeWeight>=40);assert.ok(large.parameters.areaWeight<=20);assert.ok(large.parameters.edgeWeight>=2*large.parameters.areaWeight);
 assert.deepEqual(fitImageScores(samples),large);
});
test('human labels never enter model input; relabeling and repeated calibration reuse observations and rescore cached API results',async t=>{
 const f=fixture(t);f.put('70-P1.png');const first=await f.run();assert.equal(first.status,'completed',first.error);
 assert.equal(f.calls,1);assert.equal(first.report?.calibration && (first.report.calibration as any).sampleCount,1);
 assert.equal((await f.checker.check(png)).score,70);assert.equal((await f.checker.check(png)).reminder,true);
 const prompt=JSON.stringify(f.requests);assert.ok(!prompt.includes('70-P1'));assert.ok(!prompt.includes('humanScore'));assert.ok(!prompt.includes('calibrationBias'));
 fs.renameSync(path.join(f.service.samplesDir,'70-P1.png'),path.join(f.service.samplesDir,'85-P1.png'));
 const second=await f.run();assert.equal(second.counts.reused,1);assert.equal(f.calls,1);
 assert.equal((await new ImageQualityChecker(f.root).check(png)).score,85);assert.equal((await f.checker.check(png)).reminder,false);
 assert.notEqual(first.id,second.id);assert.equal(second.activated,true);
 assert.equal(fs.readdirSync(path.join(f.service.root,'versions')).length,2);
});
test('same Hash duplicate does not add weight; conflicting labels/invalid files preserve the active version',async t=>{
 const f=fixture(t);f.put('70-P1.png');await f.run();const before=fs.readFileSync(path.join(f.service.root,'active.json'),'utf8');
 f.put('70-P2.jpg');const duplicate=await f.run();assert.equal(duplicate.counts.duplicate,1);assert.equal((duplicate.report!.calibration as any).sampleCount,1);
 const active=fs.readFileSync(path.join(f.service.root,'active.json'),'utf8');f.put('80-P3.png');
 const conflict=await f.run();assert.equal(conflict.status,'failed');assert.match(conflict.error!,/No valid/u);assert.equal(f.calls,1);
 assert.equal(fs.readFileSync(path.join(f.service.root,'active.json'),'utf8'),active);
 fs.unlinkSync(path.join(f.service.samplesDir,'80-P3.png'));f.put('101-P4.png');
 const invalid=await f.run();assert.equal(invalid.status,'partial_failed');assert.equal(invalid.activated,false);
 assert.equal(fs.readFileSync(path.join(f.service.root,'active.json'),'utf8'),active);assert.notEqual(before,active);
});
test('only new Hash calls vision; removed references no longer participate; uncertain samples cannot activate',async t=>{
 const f=fixture(t);f.put('70-P1.png');await f.run();
 f.put('75-P2.png',Buffer.concat([png,Buffer.from('new')]));const added=await f.run();assert.equal(f.calls,2);assert.equal(added.counts.analyzed,1);assert.equal(added.counts.reused,1);
 fs.unlinkSync(path.join(f.service.samplesDir,'70-P1.png'));const removed=await f.run();assert.equal((removed.report!.calibration as any).sampleCount,1);assert.equal(f.calls,2);
 const uncertain=fixture(t,{async complete(){return {text:JSON.stringify({...observation,confidence:0.4}),model:'fake-vision'};}});uncertain.put('70-P1.png');
 const failed=await uncertain.run();assert.equal(failed.status,'failed');assert.ok(!fs.existsSync(path.join(uncertain.service.root,'active.json')));
});
test('reference changes during model work prevent activation; simultaneous jobs conflict; cancellation and restart are resumable',async t=>{
 let release!:()=>void;let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
 const f=fixture(t,{async complete(){started();await new Promise<void>(resolve=>{release=resolve;});return {text:JSON.stringify(observation),model:'fake-vision'};}});
 f.put('70-P1.png');const job=f.service.create(),pending=f.service.resume(job.id);await began;
 await assert.rejects(f.service.resume(f.service.create().id),/busy/u);
 fs.renameSync(path.join(f.service.samplesDir,'70-P1.png'),path.join(f.service.samplesDir,'75-P1.png'));release();
 const failed=await pending;assert.equal(failed.status,'failed');assert.match(failed.error!,/Reference set changed/u);
 const resumed=await new ImageCalibration(f.root,f.checker).resume(job.id);assert.equal(resumed.status,'completed');
 const interrupted=f.service.create();const stateFile=path.join(f.service.root,'jobs',interrupted.id,'state.json');
 fs.writeFileSync(stateFile,JSON.stringify({...interrupted,status:'running',ownerPid:2147483647}));assert.equal(f.service.get(interrupted.id).status,'interrupted');
 const cancelled=await f.service.cancel(interrupted.id);assert.equal(cancelled.status,'cancelled');assert.equal((await f.service.resume(interrupted.id)).status,'cancelled');
});
test('calibration cannot be applied to observations from another vision model/version',async t=>{
 const f=fixture(t);f.put('70-P1.png');await f.run();const active=f.service.current().calibration!;
 assert.equal(scoreWithCalibration(observation,'another-model',active).calibrationStatus,'model_mismatch');
 assert.equal(scoreWithCalibration(observation,'another-model',active).calibrationId,null);
 fs.writeFileSync(path.join(f.service.root,'active.json'),JSON.stringify({...active,analysisVersion:'future-version'}));
 assert.equal(f.service.current().calibration,null);assert.equal((await f.checker.check(png)).calibrationId,null);
});
test('calibration API creates durable jobs, returns current parameters, protects origins and rejects paths',async t=>{
 const f=fixture(t);f.put('70-P1.png');const app=createCkdUiServer({dataDir:f.root,imageQualityModel:{async complete(){return {text:JSON.stringify(assessmentSeen),model:'fake-vision'};}}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.server.closeAllConnections();app.server.close();});
 const address=app.server.address();assert(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const post=(route:string,value:unknown={},origin?:string)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(value)});
 assert.equal((await post('/api/images/calibrate',{samplesDir:'/elsewhere'})).status,400);assert.equal((await post('/api/images/calibrate',{},'https://foreign.example')).status,403);
 const start=await post('/api/images/calibrate');assert.equal(start.status,202);const id=(await start.json()).job.id;
 let job:any;for(let i=0;i<100;i++){job=(await(await fetch(url+`/api/images/calibration/jobs/${id}`)).json()).job;if(job.status!=='running')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(job.status,'completed');assert.equal((await(await fetch(url+'/api/images/calibration')).json()).calibration.id,id);
 assert.equal((await post(`/api/images/calibration/jobs/${id}/resume`)).status,202);assert.equal((await post(`/api/images/calibration/jobs/${id}/cancel`)).status,200);
 const image=await fetch(url+'/api/images/quality',{method:'POST',headers:{'Content-Type':'image/png'},body:new Uint8Array(png)});
 const result=(await image.json()).result;assert.equal(result.score,70);assert.equal(result.calibrationId,id);assert.equal(result.cached,true);
 const library=app.service.libraryPath;
 const put=(file:string,value:string|Buffer)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
 put(path.join(library,'product_lib/TEST/project.json'),JSON.stringify({version:1,projectId:'TEST',displayName:'Test',aliases:[]}));
 const folder=path.join(library,'processes_lib/factory_test/camera_connection');
 put(path.join(folder,'metadata.txt'),'Camera Connection\n');put(path.join(folder,'operation_steps.txt'),'Check camera connection.\n');put(path.join(folder,'photos/p1.png'),png);
 const run=await app.service.start({projectName:'TEST',documentNumber:'CALIBRATION',sopName:'Calibrated',author:'Test',sopType:'factory_test',factoryTestProcesses:['Camera Connection']});
 assert.equal(run.status,'completed',run.error);
 const quality=(run.finalResult!.output as any).imageQuality;assert.equal(quality.overallScore,70);assert.equal(quality.calibrationId,id);assert.equal(quality.reminderCount,1);assert.equal(quality.calibrationExperimental,true);
});

test('worse held-out performance preserves the last active calibration and reports the candidate',async t=>{
 const f=fixture(t,{async complete(){return {text:JSON.stringify({...observation,boundingBox:{left:0.33,top:0.33,right:0.67,bottom:0.67}}),model:'fake-vision'};}});
 f.put('70-initial.png');await f.run();const before=fs.readFileSync(path.join(f.service.root,'active.json'),'utf8');
 fs.unlinkSync(path.join(f.service.samplesDir,'70-initial.png'));
 for(let i=0;i<12;i++)f.put(`${i<7?20:90}-P${i}.png`,Buffer.concat([png,Buffer.from(`unique-${i}`)]));
 const job=await f.run();assert.equal(job.status,'partial_failed',job.error);assert.equal(job.activated,false);
 const validation=job.report!.validation as any;assert.ok(validation.after.mae>validation.before.mae+0.25);
 assert.equal(fs.readFileSync(path.join(f.service.root,'active.json'),'utf8'),before);
});
test('active calibration requests can cancel or time out without changing parameters or caching failures',async t=>{
 const f=fixture(t,{async complete(){return new Promise(()=>{});}});f.put('70-P1.png');const job=f.service.create(),pending=f.service.resume(job.id);
 await f.service.cancel(job.id);assert.equal((await pending).status,'cancelled');assert.ok(!fs.existsSync(path.join(f.service.root,'active.json')));
 const checker=new ImageQualityChecker(f.root,{model:{async complete(){return new Promise(()=>{});}},timeoutMs:10});
 const service=new ImageCalibration(f.root,checker);const timed=await service.resume(service.create().id);assert.equal(timed.status,'failed');
 assert.ok(!fs.existsSync(path.join(f.service.root,'active.json')));assert.deepEqual(fs.readdirSync(checker.root),[]);
});
