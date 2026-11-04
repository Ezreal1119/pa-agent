import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { reviewSampleImages, reviewCsv } from '../src/ckd/image-review.js';
import { assessmentSeen } from './helpers/image-assessment.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
function fixture(t:{after(fn:()=>void):void}){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-review-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const samples=path.join(root,'ckd/image-calibration/samples');fs.mkdirSync(samples,{recursive:true});return {root,samples,output:path.join(root,'report')};}
test('review exports raw uncalibrated scores, self-contained images, blank human fields, and safely executable HTML',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.samples,'12-P1.png'),png);let calls=0;
 const report=await reviewSampleImages({dataDir:f.root,outputDir:f.output,model:{async complete(req){calls++;assert.ok(!req.prompt.includes('12-P1'));assert.ok(!req.prompt.includes('previousHumanScore'));return {text:JSON.stringify({...assessmentSeen,subject:'</script><script>alert(1)</script>'}),model:'fake'};}}});
 assert.equal(report.status,'completed');assert.equal(report.items[0]!.previousHumanScore,12);assert.equal(report.items[0]!.result!.score,94);assert.equal(report.items[0]!.result!.calibrationOffset,0);assert.equal(report.summary.已评分,1);assert.equal(calls,2);
 const html=fs.readFileSync(path.join(f.output,'review.html'),'utf8');assert.ok(html.includes('data:image/png;base64,'));assert.ok(!html.includes('</script><script>alert'));assert.ok(html.includes('需求方复评分'));
 const script=html.match(/<script>([\s\S]*)<\/script>/u)![1]!;const scriptFile=path.join(f.output,'script.js');fs.writeFileSync(scriptFile,script);execFileSync(process.execPath,['--check',scriptFile]);
 await reviewSampleImages({dataDir:f.root,outputDir:f.output,model:{async complete(){throw new Error('must use cache');}}});assert.equal(calls,2);
 assert.ok(fs.readFileSync(path.join(f.output,'review.csv'),'utf8').startsWith('\ufeff'));
 const csv=reviewCsv([{file:'=SUM(1,2).png',imageHash:'hash',previousHumanScore:12,error:'=1+1'}]);assert.ok(csv.includes("'=SUM"));assert.ok(csv.includes("'=1+1"));
});
test('single-item model failure is reported and remaining images still export; symlinks are rejected',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.samples,'60-P1.png'),png);fs.writeFileSync(path.join(f.samples,'80-P2.png'),Buffer.concat([png,Buffer.from('new')]));let calls=0;
 const report=await reviewSampleImages({dataDir:f.root,outputDir:f.output,model:{async complete(){if(++calls===1)throw new Error('provider failure');return {text:JSON.stringify(assessmentSeen),model:'fake'};}}});assert.equal(report.status,'partial_failed');assert.equal(report.summary.已评分,1);assert.equal(report.items.filter(i=>i.error).length,1);assert.ok(fs.existsSync(path.join(f.output,'review.html')));
 fs.symlinkSync(path.join(f.samples,'60-P1.png'),path.join(f.samples,'90-link.png'));await assert.rejects(reviewSampleImages({dataDir:f.root,outputDir:f.output}),/Invalid reference/u);
});
