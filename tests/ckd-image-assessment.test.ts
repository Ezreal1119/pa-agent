import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { once } from "node:events";
import { assessmentSeen } from "./helpers/image-assessment.js";
import { ImageAssessmentChecker, ASSESSMENT_VERSION, ASSESSMENT_SCORE_VERSION, ASSESSMENT_PROMPT, DEFAULT_POLICY, DIMENSIONS, parseAssessment, validatePolicy, readImagePolicy, saveImagePolicy, assessScore, scoreComponents, fitAssessmentOffset, weightsHash, type AssessmentCalibration } from "../src/ckd/image-assessment.js";
import { AssessmentCalibrationJobs } from "../src/ckd/image-assessment-calibration.js";
import { createCkdUiServer } from "../src/ckd/ui-server.js";
import type { LibraryModel } from "../src/ckd/library-model.js";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=","base64");
function fixture(t:{after(fn:()=>void):void}, model?:LibraryModel){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"pi-assessment-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let calls=0;const checker=new ImageAssessmentChecker(root,{model:model??{async complete(request){calls++;assert.equal(request.purpose,"vision");assert.ok(!request.prompt.includes('humanScore'));return {text:JSON.stringify(assessmentSeen),model:"fake"};}}});const service=new AssessmentCalibrationJobs(root,checker);return {root,checker,service,put:(name:string,bytes=png)=>fs.writeFileSync(path.join(service.samplesDir,name),bytes),run:()=>service.resume(service.create().id),get calls(){return calls;}};}
function calibration(bias=0):AssessmentCalibration{return {id:"test",analysisVersion:ASSESSMENT_VERSION,analysisModel:"fake",scoreVersion:ASSESSMENT_SCORE_VERSION,createdAt:new Date().toISOString(),sampleCount:1,mode:"offset_only",parameters:{bias},weightsHash:weightsHash(DEFAULT_POLICY),samples:[{file:"70-P1.png",imageHash:"abc",humanScore:70,data:assessmentSeen}]};}
test("seven tiers map deterministically; composition uses the three requested weights",()=>{
 assert.equal(assessScore(assessmentSeen,"fake",DEFAULT_POLICY).score,94);
 const excellent=structuredClone(assessmentSeen);excellent.framing.wastedSpaceSeverity=0;assert.equal(assessScore(excellent,'fake',DEFAULT_POLICY).score,94);
 const shifted=structuredClone(excellent);shifted.framing.subjects[0]!.box={left:.45,top:.2,right:.95,bottom:.8};shifted.boundingBox={left:0,top:0,right:1,bottom:1};
 assert.equal(scoreComponents(shifted,DEFAULT_POLICY)[3]!.score,scoreComponents(excellent,DEFAULT_POLICY)[3]!.score);
 assert.equal(scoreComponents({...assessmentSeen,effectiveContentRatio:.9},DEFAULT_POLICY)[3]!.score,30);
 assert.throws(()=>validatePolicy({...DEFAULT_POLICY,weights:{...DEFAULT_POLICY.weights,clarity:31}}),/合计/u);
 assert.throws(()=>validatePolicy({...DEFAULT_POLICY,caps:{...DEFAULT_POLICY.caps,criticalUnreadable:101}}));
});
test("caps apply AFTER offset, lowest cap wins, disabling caps and inclusive alert threshold work",()=>{
 const seen={...assessmentSeen,criticalContentUnreliable:true,detailsClearlyBlurred:true,blurEvidence:{...assessmentSeen.blurEvidence,cause:"focus_or_motion" as const,affectsNecessaryDetails:true},metrics:{...assessmentSeen.metrics,clarity:{...assessmentSeen.metrics.clarity,level:2}},effectiveContentRatio:.09,unrelatedBackgroundRatio:.9};
 const result=assessScore(seen,'fake',DEFAULT_POLICY,calibration(40));assert.equal(result.calibratedScore,result.baseScore);assert.equal(result.calibrationIncreaseBlocked,true);assert.equal(result.score,59);assert.equal(result.appliedCaps.length,5);
 const policy=structuredClone(DEFAULT_POLICY);policy.caps.criticalUnreadable=null;assert.equal(assessScore(seen,'fake',policy,calibration(40)).score,60);
 policy.caps.detailsBlurred=null;policy.caps.excessiveWhitespace=null;assert.equal(assessScore(seen,'fake',policy,calibration(40)).score,60);assert.equal(assessScore({...seen,unrelatedBackgroundRatio:.7},'fake',policy).appliedCaps.some(cap=>cap.key==='spaceOver70'),false);
 for(const [score,grade,reminder] of [[59,'不合格',true],[60,'需修改',true],[69,'需修改',true],[70,'需修改',true],[80,'需修改',true],[81,'合格',false],[89,'合格',false],[90,'优秀',false]]){const good=structuredClone(assessmentSeen);good.framing.wastedSpaceSeverity=0;const r=assessScore(good,'fake',DEFAULT_POLICY,calibration(Number(score)-93.67));assert.equal(r.score,score);assert.equal(r.grade,grade);assert.equal(r.reminder,reminder);}
});
test("strict observation validation and low confidence prevent fabricated totals",()=>{
 assert.throws(()=>parseAssessment({...assessmentSeen,totalScore:100}));const seen=structuredClone(assessmentSeen);seen.metrics.exposure.confidence=.4;assert.equal(assessScore(seen,'fake',DEFAULT_POLICY).score,null);
 seen.metrics.exposure.confidence=.9;seen.boundingBox={left:.8,top:0,right:.2,bottom:1};assert.throws(()=>parseAssessment(seen));
});
test("empty-space bands include their upper boundaries and over 70% always caps the final score at 60",()=>{
 const data=structuredClone(assessmentSeen);
 for(const [ratio,space,cap] of [[.3,12,false],[.3001,9,false],[.5,9,false],[.5001,6,false],[.7,6,false],[.7001,6,true]] as const){
  data.unrelatedBackgroundRatio=ratio;
  const result=assessScore(data,'fake',DEFAULT_POLICY);
  assert.equal(result.framingGeometry.parts.find(p=>p.key==='space')!.score,space);
  assert.equal(result.appliedCaps.some(c=>c.key==='spaceOver70'),cap);
  if(cap)assert.ok(result.score!<=60);
 }
 data.unrelatedBackgroundRatio=.71;
 const custom=structuredClone(DEFAULT_POLICY);custom.weights.composition=20;custom.weights.clarity=35;custom.caps.excessiveWhitespace=null;
 const result=assessScore(data,'fake',custom);assert.equal(result.framingGeometry.parts.find(p=>p.key==='space')!.maximum,8);assert.equal(result.score,60);
});
test("critical exposure or glare loss enforces configurable cap even if model omits its critical flag",()=>{
 for(const key of ['exposure','obstruction'] as const){
  const seen=structuredClone(assessmentSeen);seen.metrics[key].level=0;
  const scored=assessScore(seen,'fake',DEFAULT_POLICY,calibration(40));assert.equal(scored.score,59);assert.equal(scored.appliedCaps[0]!.key,'criticalUnreadable');
  const policy=structuredClone(DEFAULT_POLICY);policy.caps.criticalUnreadable=null;assert.equal(assessScore(seen,'fake',policy,calibration(40)).score,Math.round(assessScore(seen,'fake',policy).baseScore!));
  seen.metrics[key].level=2;assert.equal(assessScore(seen,'fake',DEFAULT_POLICY).appliedCaps.length,0);
 }
});
test("changing policy uses cached observations; scores are recomputed and weights invalidate offset",async t=>{
 const f=fixture(t);const first=await f.checker.check(png);assert.equal(first.score,94);assert.equal(f.calls,2);
 const policy=structuredClone(DEFAULT_POLICY);policy.alertThreshold=95;saveImagePolicy(f.root,policy);assert.equal((await f.checker.check(png)).reminder,true);assert.equal(f.calls,2);
 const cache=path.join(f.checker.root,`${first.imageHash}.json`),saved=JSON.parse(fs.readFileSync(cache,'utf8'));saved.score=100;fs.writeFileSync(cache,JSON.stringify(saved));assert.equal((await f.checker.check(png)).score,94);
 policy.weights.clarity=20;policy.weights.composition=35;const r=assessScore(assessmentSeen,'fake',policy,calibration(-23));assert.equal(r.calibrationStatus,'weights_mismatch');assert.equal(r.calibrationOffset,0);
 policy.caps.detailsBlurred=null;saveImagePolicy(f.root,policy);assert.deepEqual(readImagePolicy(f.root),policy);await f.checker.check(png);assert.equal(f.calls,2);
});
test("calibration computes mean offset and nearest samples without labels in the model prompt; relabeling reuses cache",async t=>{
 const fitted=fitAssessmentOffset([{imageHash:'a',humanScore:70,data:assessmentSeen},{imageHash:'b',humanScore:80,data:assessmentSeen}],DEFAULT_POLICY);assert.ok(Math.abs(fitted.parameters.bias+18.67)<1e-9);
 const f=fixture(t);f.put('70-P1.png');const job=await f.run();assert.equal(job.status,'completed',job.error);assert.equal((await f.checker.check(png)).score,70);assert.equal(f.calls,2);assert.equal((await f.checker.check(png)).nearestReferences[0]!.file,'70-P1.png');
 fs.renameSync(path.join(f.service.samplesDir,'70-P1.png'),path.join(f.service.samplesDir,'85-P1.png'));await f.run();assert.equal((await f.checker.check(png)).score,85);assert.equal(f.calls,2);
 f.put('72-conflict.png');const active=fs.readFileSync(path.join(f.service.root,'active.json'),'utf8');assert.equal((await f.run()).activated,false);assert.equal(fs.readFileSync(path.join(f.service.root,'active.json'),'utf8'),active);
});
test("model failures, invalid output, timeout and cancel do not cache successful analysis",async t=>{
 const f=fixture(t);const invalid=new ImageAssessmentChecker(f.root,{model:{async complete(){return {text:'{"score":100}',model:'fake'};}}});await assert.rejects(invalid.check(png));assert.deepEqual(fs.readdirSync(invalid.root),[]);
 const hang:LibraryModel={async complete(){return new Promise(()=>{});}};await assert.rejects(new ImageAssessmentChecker(f.root,{model:hang,timeoutMs:10}).check(png),/timeout/iu);
 const controller=new AbortController();const pending=new ImageAssessmentChecker(f.root,{model:hang}).check(png,controller.signal);controller.abort(new Error('test cancel'));await assert.rejects(pending,/test cancel/u);
});
test("concurrency, cancellation, restart and reference mutation preserve calibration",async t=>{
 let release!:()=>void;let began!:()=>void;let blocked=false;const started=new Promise<void>(resolve=>{began=resolve;});const f=fixture(t,{async complete(){if(!blocked){blocked=true;began();await new Promise<void>(resolve=>{release=resolve;});}return {text:JSON.stringify(assessmentSeen),model:'fake'};}});f.put('70-P1.png');const job=f.service.create(),pending=f.service.resume(job.id);await started;
 await assert.rejects(f.service.resume(f.service.create().id),/busy/u);fs.renameSync(path.join(f.service.samplesDir,'70-P1.png'),path.join(f.service.samplesDir,'75-P1.png'));release();assert.equal((await pending).status,'failed');
 const restarted=new AssessmentCalibrationJobs(f.root,new ImageAssessmentChecker(f.root,{model:{async complete(){throw new Error('must use cache');}}}));assert.equal((await restarted.resume(job.id)).status,'completed');
 const cancelled=restarted.create();assert.equal((await restarted.cancel(cancelled.id)).status,'cancelled');assert.equal((await restarted.resume(cancelled.id)).status,'cancelled');
});
test("policy, binary assessment and calibration API persist settings with origin enforcement and reference Hash checks",async t=>{
 const f=fixture(t);f.put('70-P1.png');const app=createCkdUiServer({dataDir:f.root,imageQualityModel:{async complete(){return {text:JSON.stringify(assessmentSeen),model:'fake'};}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.server.closeAllConnections();app.server.close();});const address=app.server.address();assert(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const post=(route:string,data:unknown,origin?:string)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});
 assert.equal((await post('/api/images/policy',DEFAULT_POLICY,'https://foreign.example')).status,403);assert.equal((await post('/api/images/policy',{...DEFAULT_POLICY,weights:{...DEFAULT_POLICY.weights,clarity:0}})).status,400);
 const policy=structuredClone(DEFAULT_POLICY);policy.alertThreshold=95;assert.equal((await post('/api/images/policy',policy)).status,200);assert.equal((await(await fetch(url+'/api/images/policy')).json()).policy.alertThreshold,95);
 const started=await post('/api/images/calibrate',{});assert.equal(started.status,202);const id=(await started.json()).job.id;let job:any;for(let i=0;i<100;i++){job=(await(await fetch(url+`/api/images/calibration/jobs/${id}`)).json()).job;if(job.status!=='running')break;await new Promise(r=>setTimeout(r,5));}assert.equal(job.status,'completed',job.error);
 const response=await fetch(url+'/api/images/quality',{method:'POST',headers:{'Content-Type':'image/png'},body:new Uint8Array(png)});assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.score,70);assert.equal(result.components.length,7);assert.equal(result.nearestReferences.length,1);assert.equal(result.policy.alertThreshold,95);
 const ref=url+`/api/images/references/${result.imageHash}`;assert.equal((await fetch(ref)).status,200);fs.writeFileSync(path.join(f.service.samplesDir,'70-P1.png'),Buffer.concat([png,Buffer.from('changed')]));assert.equal((await fetch(ref)).status,409);
 const html=await(await fetch(url)).text();assert.ok(html.includes('image-policy-form'));assert.ok(html.includes('image-test-form'));assert.ok(html.includes('image-settings'));assert.equal(DIMENSIONS.length,7);
});

test("strict current prompt preserves fair tiers, evidence and sample isolation; older calibration cannot leak into new rules",()=>{
 assert.ok(ASSESSMENT_PROMPT.includes('Do not choose ratings to achieve any target score distribution'));
 assert.ok(ASSESSMENT_PROMPT.includes('Recognizable equipment is not proof of sharpness'));
 assert.ok(ASSESSMENT_PROMPT.includes('thin cable or pointing hand'));
 const old={...calibration(-19),analysisVersion:'seven-dimensions-v1'};
 const scored=assessScore(assessmentSeen,'fake',DEFAULT_POLICY,old);assert.equal(scored.calibrationStatus,'version_mismatch');assert.equal(scored.calibrationOffset,0);assert.equal(scored.calibrationId,null);
});
