import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessmentSeen } from './helpers/image-assessment.js';
import { ImageAssessmentChecker,DEFAULT_POLICY,assessScore,parseAssessment,usefulEnclosingBox } from '../src/ckd/image-assessment.js';
import { compositionScore } from '../src/ckd/image-framing.js';
import { importReviewedLabels,feedbackLabels,reviewedLabels } from '../src/ckd/image-reference-labels.js';
import { AssessmentCalibrationJobs } from '../src/ckd/image-assessment-calibration.js';
import { reviewSampleImages } from '../src/ckd/image-review.js';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
import { once } from 'node:events';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
function fixture(t:{after(fn:()=>void):void}){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-v3-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('composition keeps only space, background and prominence; centering and camera angle are not scored',()=>{
 const a=structuredClone(assessmentSeen);const centered=compositionScore(a.framing,a.boundingBox,30,.3);assert.equal(centered.score,30);assert.deepEqual(centered.parts.map(p=>p.key),['space','background','prominence']);
 a.boundingBox={left:0,top:0,right:1,bottom:1};a.framing.subjects[0]!.box={left:.45,top:.1,right:.95,bottom:.9};a.framing.subjects.push({name:'独立辅助物',role:'supporting',box:{left:0,top:0,right:.1,bottom:.1},details:'分离'});const shifted=compositionScore(a.framing,a.boundingBox,30,.3);assert.equal(shifted.score,30);
 a.framing.layout='connected_setup';assert.deepEqual(compositionScore(a.framing,a.boundingBox,30,.3).parts,shifted.parts);
 a.framing.tiltDegrees=30;a.framing.tiltRelevant=true;a.framing.perspectiveSeverity=2;assert.equal(compositionScore(a.framing,a.boundingBox,30,.3).score,30);
 const narrow=structuredClone(a);narrow.boundingBox={left:.2,top:.2,right:.8,bottom:.8};assert.equal(usefulEnclosingBox(parseAssessment(narrow))!.right,.95);
 const invalid=structuredClone(assessmentSeen);invalid.framing.subjects.push({...invalid.framing.subjects[0]!});assert.throws(()=>parseAssessment(invalid),/primary/u);
});
test('ordinary reflection never triggers defocus cap, confirmed blur does; low framing confidence remains unscored',()=>{
 const a=structuredClone(assessmentSeen);a.detailsClearlyBlurred=true;a.metrics.clarity.level=2;a.blurEvidence={cause:'glare_or_shadow',affectsNecessaryDetails:true,comment:'反光局部降低对比度'};
 assert.ok(!assessScore(a,'fake',DEFAULT_POLICY).appliedCaps.some(c=>c.key==='detailsBlurred'));a.blurEvidence.cause='focus_or_motion';assert.equal(assessScore(a,'fake',DEFAULT_POLICY).score,69);a.blurEvidence.affectsNecessaryDetails=false;assert.ok(!assessScore(a,'fake',DEFAULT_POLICY).appliedCaps.some(c=>c.key==='detailsBlurred'));a.framing.confidence=.4;assert.equal(assessScore(a,'fake',DEFAULT_POLICY).score,null);
});
test('operation matching uses cached visible catalog with text only; contexts have separate caches without repeat vision',async t=>{
 const root=fixture(t);let vision=0,text=0;
 const checker=new ImageAssessmentChecker(root,{model:{async complete(req){if(req.purpose==='vision'){vision++;return {text:JSON.stringify(assessmentSeen),model:'vision'};}text++;assert.equal(req.image,undefined);assert.ok(req.prompt.includes('operationDescription'));return {text:JSON.stringify({subjectIndex:0,detailsVisible:'unknown',confidence:.9,comment:'没有指定孔位的可见证据'}),model:'text'};}}});
 const image=await checker.check(png);assert.equal((await checker.operationFocus(image,'检查螺丝孔',new AbortController().signal)).status,'needs_review');assert.equal((await checker.operationFocus(image,'检查螺丝孔',new AbortController().signal)).cached,true);await checker.operationFocus(image,'Check connector',new AbortController().signal);await checker.check(png);assert.equal(vision,2);assert.equal(text,2);const uncertain=structuredClone(image);uncertain.confidence=.3;assert.equal((await checker.operationFocus(uncertain,'检查螺丝孔',new AbortController().signal)).status,'needs_review');assert.equal(text,2);
 const bad=new ImageAssessmentChecker(root,{model:{async complete(){return {text:JSON.stringify({subjectIndex:7,detailsVisible:'yes',confidence:.9,comment:'不存在'}),model:'bad'};}}});await assert.rejects(bad.operationFocus(image,'不同说明',new AbortController().signal),/index/u);
 const hang=new ImageAssessmentChecker(root,{timeoutMs:10,model:{async complete(){return new Promise(()=>{});}}});await assert.rejects(hang.operationFocus(image,'timeout',new AbortController().signal),/timeout/iu);
 const c=new AbortController();c.abort(new Error('cancel focus'));await assert.rejects(checker.operationFocus(image,'cancel',c.signal),/cancel focus/u);
});
test('review CSV labels override old prefixes by Hash for calibration; renaming score explicitly wins and changed bytes are rejected',async t=>{
 const root=fixture(t);const checker=new ImageAssessmentChecker(root,{model:{async complete(){return {text:JSON.stringify(assessmentSeen),model:'fake'};}}});const jobs=new AssessmentCalibrationJobs(root,checker);fs.writeFileSync(path.join(jobs.samplesDir,'60-P1.png'),png);
 const csv=path.join(root,'feedback.csv');fs.writeFileSync(csv,'\ufeff"图片","需求方复评分","扣分原因","AI建议分"\r\n"60-P1.png","76","留白,\n位置不平衡","98"\r\n');assert.equal(feedbackLabels(csv).get('60-P1.png')!.score,76);importReviewedLabels(root,csv);assert.equal(reviewedLabels(root)[0]!.score,76);
 const reviewed=await reviewSampleImages({dataDir:root,outputDir:path.join(root,'report'),feedbackCsv:csv,model:{async complete(){return {text:JSON.stringify(assessmentSeen),model:'fake'};}}});assert.equal(reviewed.items[0]!.reviewedHumanScore,76);assert.equal(reviewed.items[0]!.result!.calibrationOffset,0);assert.equal(reviewed.comparison.count,1);assert.equal(reviewed.items[0]!.previousAiScore,98);assert.equal(reviewed.comparison.previousMae,22);
 const result=await jobs.resume(jobs.create().id);assert.equal(result.status,'completed');assert.equal(jobs.current().calibration!.samples[0]!.humanScore,76);
 fs.renameSync(path.join(jobs.samplesDir,'60-P1.png'),path.join(jobs.samplesDir,'85-P1.png'));await jobs.resume(jobs.create().id);assert.equal(jobs.current().calibration!.samples[0]!.humanScore,85);
 fs.renameSync(path.join(jobs.samplesDir,'85-P1.png'),path.join(jobs.samplesDir,'60-P1.png'));fs.appendFileSync(path.join(jobs.samplesDir,'60-P1.png'),'new');assert.equal((await jobs.resume(jobs.create().id)).status,'failed');
 fs.writeFileSync(csv,'图片,需求方复评分\n60-P1.png,\n');assert.throws(()=>feedbackLabels(csv),/Invalid/u);
});
test('binary API optional context uses text mapping and validates before invoking any model',async t=>{
 const root=fixture(t);let calls=0;const app=createCkdUiServer({dataDir:root,imageQualityModel:{async complete(req){calls++;if(req.purpose!=='vision'&&req.prompt.includes('missing text'))throw new Error('text model unavailable');return {text:JSON.stringify(req.purpose==='vision'?assessmentSeen:{subjectIndex:0,detailsVisible:'yes',confidence:.9,comment:'与可见主体匹配'}),model:'fake'};}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.server.closeAllConnections();app.server.close();});const address=app.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}/api/images/quality`;
 const post=(suffix:string)=>fetch(url+suffix,{method:'POST',headers:{'Content-Type':'image/png'},body:new Uint8Array(png)});assert.equal((await post('?context=')).status,400);assert.equal(calls,0);
 const res=await post('?context=check');assert.equal(res.status,200);assert.equal((await res.json()).result.operationFocus.status,'identified');assert.equal(calls,3);await post('?context=check');assert.equal(calls,3);const unavailable=await post('?context=missing%20text');assert.equal(unavailable.status,200);const partial=(await unavailable.json()).result;assert.equal(partial.score,94);assert.match(partial.focusError,/unavailable/u);
});
