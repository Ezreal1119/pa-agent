import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ImageAssessmentChecker } from '../src/ckd/image-assessment.js';
import { HttpLibraryModel } from '../src/ckd/library-model.js';
import { assessmentSeen } from './helpers/image-assessment.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=','base64');
function directory(t:{after(fn:()=>void):void}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-image-protocol-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('format retries re-inspect the original, retain strict validation and keep review independent',async t=>{
 const dir=directory(t);let calls=0;
 const first=structuredClone(assessmentSeen);first.reason='FIRST_PRIVATE_EVIDENCE';
 const invalid=structuredClone(first);invalid.framing.subjects.push({...invalid.framing.subjects[0]!,name:'another primary'});
 const checker=new ImageAssessmentChecker(dir,{model:{async complete(req){calls++;assert.ok(req.image?.equals(png));assert.ok(req.system.includes('Exactly ONE'));
  if(calls===2)assert.match(req.prompt,/previous response failed output validation: Exactly one/iu);
  if(calls>=3)assert.ok(!req.prompt.includes('FIRST_PRIVATE_EVIDENCE'));
  if(calls===4)assert.match(req.prompt,/data must be object/u);
  return {model:'fake',text:JSON.stringify(calls===1?invalid:calls===2?first:calls===3?[]:assessmentSeen)};
 }}});
 const result=await checker.check(png);assert.equal(calls,4);assert.equal(result.conservativeReview.first.reason,first.reason);
 assert.equal((await checker.check(png)).cached,true);assert.equal(calls,4);
 const invalidLog=path.join(dir,'ckd/image-quality-errors/seven-dimensions-v3',result.imageHash+'.json');assert.equal(JSON.parse(fs.readFileSync(invalidLog,'utf8')).failures.length,1);
});
test('format retries are finite and invalid results never become a success cache; provider errors are not format retries',async t=>{
 const dir=directory(t);let calls=0;const checker=new ImageAssessmentChecker(dir,{model:{async complete(){calls++;return {model:'fake',text:'{}'};}}});
 await assert.rejects(checker.check(png),/after 3 format attempts/u);assert.equal(calls,3);assert.deepEqual(fs.readdirSync(checker.root),[]);
 calls=0;const unavailable=new ImageAssessmentChecker(dir,{model:{async complete(){calls++;throw new Error('Model provider HTTP 400');}}});
 await assert.rejects(unavailable.check(png),/HTTP 400/u);assert.equal(calls,1);
});
test('imageType and framing.layout have explicit separate enum contracts; collage is not silently converted',async t=>{
 const dir=directory(t);let calls=0;const invalid={...structuredClone(assessmentSeen),imageType:'collage'};
 const checker=new ImageAssessmentChecker(dir,{model:{async complete(req){calls++;assert.ok(req.system.includes('imageType MUST be exactly object, screenshot, diagram, scene or unknown'));assert.ok(req.system.includes('collage and connected_setup are NOT imageType values'));if(calls===2)assert.match(req.prompt,/data\/imageType/u);return {model:'fake',text:JSON.stringify(calls===1?invalid:assessmentSeen)};}}});
 const result=await checker.check(png);assert.equal(calls,3);assert.equal(result.imageType,'object');
 const log=JSON.parse(fs.readFileSync(path.join(dir,'ckd/image-quality-errors/seven-dimensions-v3',result.imageHash+'.json'),'utf8'));assert.equal(JSON.parse(log.failures[0].output).imageType,'collage');
});
test('aborting during a format retry prevents further requests and successful cache writes',async t=>{
 const dir=directory(t);let calls=0;const controller=new AbortController();const checker=new ImageAssessmentChecker(dir,{model:{async complete(){calls++;if(calls===2){controller.abort(new Error('stop format retry'));return new Promise(()=>{});}return {model:'fake',text:'[]'};}}});
 await assert.rejects(checker.check(png,controller.signal),/stop format retry/u);assert.equal(calls,2);assert.deepEqual(fs.readdirSync(checker.root),[]);
});
test('HTTP error diagnostics retain provider reason but redact credentials and image data without retrying permanent errors',async t=>{
 const previous={VISION_BASE_URL:process.env.VISION_BASE_URL,VISION_API_KEY:process.env.VISION_API_KEY,VISION_MODEL_ID:process.env.VISION_MODEL_ID};
 Object.assign(process.env,{VISION_BASE_URL:'http://vision.invalid/v1',VISION_API_KEY:'secret-test-only',VISION_MODEL_ID:'test-vision'});
 t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 let calls=0;const model=new HttpLibraryModel({fetch:async()=>{calls++;return Response.json({error:{code:'InvalidImage',message:'unsupported image secret-test-only Bearer token-other data:image/png;base64,abc'}},{status:400});}});
 await assert.rejects(model.complete({purpose:'vision',system:'s',prompt:'p'},new AbortController().signal),(error:Error)=>{assert.match(error.message,/HTTP 400: InvalidImage/u);assert.ok(!error.message.includes('secret-test-only'));assert.ok(!error.message.includes('token-other'));assert.ok(!error.message.includes('base64'));return true;});assert.equal(calls,1);
});
