import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assessmentSeen} from './helpers/image-assessment.js';
import {ImageAssessmentChecker,assessScore,DEFAULT_POLICY,ASSESSMENT_VERSION,ASSESSMENT_SCORE_VERSION,weightsHash,assessmentCalibrationMetrics,validatePolicy,saveImagePolicy,readImagePolicy} from '../src/ckd/image-assessment.js';
import {conservativeObservation,CONSERVATIVE_REVIEW_VERSION} from '../src/ckd/image-conservative.js';
import {sha256} from '../src/ckd/scripts.js';
import {atomicJson} from '../src/ckd/store.js';
import {reviewSampleImages} from '../src/ckd/image-review.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
function fixture(t:{after(fn:()=>void):void}){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-conservative-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function source(dir:string){atomicJson(path.join(dir,'ckd/image-quality/seven-dimensions-v3',sha256(png)+'.json'),{ruleVersion:'seven-dimensions-v3',imageHash:sha256(png),model:'fake',analyzedAt:new Date().toISOString(),observation:assessmentSeen});}
test('independent review does not see first answer or labels; lower tiers and framing win without changing observations',async t=>{
 const dir=fixture(t);let calls=0;const first=structuredClone(assessmentSeen);first.reason='PRIVATE_FIRST_ANSWER';const review=structuredClone(assessmentSeen);review.metrics.clarity.level=2;review.metrics.clarity.comment='细小孔边明显模糊';review.framing.wastedSpaceSeverity=3;review.unrelatedBackgroundRatio=.5;
 const checker=new ImageAssessmentChecker(dir,{model:{async complete(req){calls++;assert.ok(req.image?.equals(png));if(calls===2){assert.equal(req.maxTokens,8192);assert.ok(!req.prompt.includes('PRIVATE_FIRST_ANSWER'));assert.ok(!req.prompt.includes('humanScore'));}return {text:JSON.stringify(calls===1?first:review),model:'fake'};}}});
 const result=await checker.check(png);assert.equal(calls,2);assert.equal(result.metrics.clarity.level,2);assert.equal(result.framing.wastedSpaceSeverity,3);assert.ok(result.conservativeReview.warnings.some(v=>v.includes('清晰度')));assert.equal(result.reminder,true);assert.equal(result.conservativeReview.first.metrics.clarity.level,4);assert.equal(first.metrics.clarity.level,4);
 assert.equal((await checker.check(png)).cached,true);assert.equal(calls,2);
});
test('positive fitted offset cannot inflate conservative scores; negative offset still applies and lower bounds retain component evidence',()=>{
 const calibration={id:'test',analysisVersion:ASSESSMENT_VERSION,scoreVersion:ASSESSMENT_SCORE_VERSION,analysisModel:'fake',createdAt:new Date().toISOString(),sampleCount:1,mode:'offset_only' as const,weightsHash:weightsHash(DEFAULT_POLICY),parameters:{bias:20},samples:[{imageHash:'hash',humanScore:98,data:assessmentSeen}]};
 const raw=assessScore(assessmentSeen,'fake',DEFAULT_POLICY),higher=assessScore(assessmentSeen,'fake',DEFAULT_POLICY,calibration);assert.equal(raw.baseScore,93.67);assert.equal(higher.score,raw.score);assert.equal(higher.calibrationIncreaseBlocked,true);assert.equal(higher.calibrationRequestedOffset,20);assert.equal(higher.calibrationOffset,0);assert.deepEqual(assessmentCalibrationMetrics(calibration.samples,DEFAULT_POLICY,20),assessmentCalibrationMetrics(calibration.samples,DEFAULT_POLICY,0));
 calibration.parameters.bias=-10;assert.equal(assessScore(assessmentSeen,'fake',DEFAULT_POLICY,calibration).baseScore,raw.baseScore);assert.equal(assessScore(assessmentSeen,'fake',DEFAULT_POLICY,calibration).score,84);
});
test('existing V3 extraction is reused; timed-out review leaves no combined success and can restart without repeating initial vision',async t=>{
 const dir=fixture(t);source(dir);const hanging=new ImageAssessmentChecker(dir,{timeoutMs:10,model:{async complete(){return new Promise(()=>{});}}});await assert.rejects(hanging.check(png),/timeout/iu);assert.ok(!fs.existsSync(path.join(hanging.root,sha256(png)+'.json')));
 let calls=0;const checker=new ImageAssessmentChecker(dir,{model:{async complete(req){calls++;assert.ok(req.system.includes('Independently'));return {text:JSON.stringify(assessmentSeen),model:'fake'};}}});await checker.check(png);assert.equal(calls,1);await checker.check(png);assert.equal(calls,1);
});
test('uncertainty always reminds even above score threshold, and low confidence is unscored rather than accepted',async t=>{
 const dir=fixture(t),review=structuredClone(assessmentSeen);review.metrics.exposure.confidence=.8;review.recommendations=['图像质量良好，无需重拍。'];source(dir);const checker=new ImageAssessmentChecker(dir,{model:{async complete(){return {text:JSON.stringify(review),model:'fake'};}}});const result=await checker.check(png);assert.equal(result.score,94);assert.equal(result.reminder,true);assert.equal(result.status,'quality_warning');assert.equal(result.grade,'需复核');assert.ok(result.recommendations.some(v=>v.includes('人工复核')));assert.ok(!result.recommendations.some(v=>v.includes('无需重拍')));assert.equal(result.conservativeReview.review.recommendations[0],review.recommendations[0]);
 review.metrics.exposure.confidence=.6;const merged=conservativeObservation(assessmentSeen,review);const unscored=assessScore(merged.observation,'fake',DEFAULT_POLICY);assert.equal(unscored.score,null);assert.equal(unscored.reminder,true);
});
test('invalid review and mismatched actual model never become a combined success',async t=>{
 const dir=fixture(t);source(dir);const bad=new ImageAssessmentChecker(dir,{model:{async complete(){return {text:JSON.stringify({...assessmentSeen,score:100}),model:'fake'};}}});await assert.rejects(bad.check(png));assert.ok(!fs.existsSync(path.join(dir,'ckd/image-quality',CONSERVATIVE_REVIEW_VERSION,sha256(png)+'.json')));
 const other=new ImageAssessmentChecker(dir,{model:{async complete(){return {text:JSON.stringify(assessmentSeen),model:'other'};}}});await assert.rejects(other.check(png),/different models/u);assert.ok(!fs.existsSync(path.join(other.root,sha256(png)+'.json')));
});
test('review comparison counts uncertainty reminders as warnings rather than hiding them behind a high number',async t=>{
 const dir=fixture(t);source(dir);const samples=path.join(dir,'ckd/image-calibration/samples');fs.mkdirSync(samples,{recursive:true});fs.writeFileSync(path.join(samples,'80-P1.png'),png);const csv=path.join(dir,'human.csv');fs.writeFileSync(csv,'图片,需求方复评分\n80-P1.png,80\n');const review=structuredClone(assessmentSeen);review.metrics.exposure.confidence=.8;
 const report=await reviewSampleImages({dataDir:dir,outputDir:path.join(dir,'report'),feedbackCsv:csv,model:{async complete(){return {text:JSON.stringify(review),model:'fake'};}}});assert.equal(report.items[0]!.result!.score,94);assert.equal(report.summary.警告图片数,1);assert.deepEqual(report.comparison.missedWarnings,[]);assert.deepEqual(report.comparison.scoreMissedWarnings,['80-P1.png']);
});

test('fine-detail gate is configurable and supported by old policies without inventing a blur diagnosis',t=>{
 const seen=structuredClone(assessmentSeen);seen.metrics.clarity.level=3;seen.detailsClearlyBlurred=false;const scored=assessScore(seen,'fake',DEFAULT_POLICY);assert.equal(scored.score,80);assert.ok(scored.appliedCaps.some(v=>v.key==='fineDetailUnverified'));assert.ok(!scored.appliedCaps.some(v=>v.key==='detailsBlurred'));assert.equal(assessmentCalibrationMetrics([{imageHash:'hash',humanScore:90,data:seen}],DEFAULT_POLICY,20).mae,10);
 const policy=structuredClone(DEFAULT_POLICY);policy.caps.fineDetailUnverified=null;assert.ok(assessScore(seen,'fake',policy).score!>80);policy.caps.fineDetailUnverified=75;assert.equal(assessScore(seen,'fake',policy).score,75);delete policy.caps.fineDetailUnverified;assert.equal(assessScore(seen,'fake',policy).score,80);
 assert.equal(validatePolicy(policy).caps.fineDetailUnverified,80);const dir=fixture(t);policy.caps.fineDetailUnverified=null;saveImagePolicy(dir,policy);assert.equal(readImagePolicy(dir).caps.fineDetailUnverified,null);
});
