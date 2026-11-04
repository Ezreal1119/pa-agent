import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
import { CkdWorkflow } from '../src/ckd/service.js';
import { PixelOperationFocusChecker, PIXEL_FOCUS_VERSION } from '../src/ckd/image-pixel-focus.js';
import type { LibraryModel } from '../src/ckd/library-model.js';

const write=(file:string,value:string|Buffer)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const png=()=>sharp({create:{width:129,height:257,channels:3,background:'#999999'}}).png().toBuffer();
const observed=(visibility='yes',evidence='Camera connector fully seated')=>({coverage:'complete',confidence:.95,comment:'检查连接器；不根据设备名称推断隐蔽细节。',requirements:[{requirement:'连接器插接到位',visibility,evidence}]});
function fixture(t:{after(fn:()=>void|Promise<void>):void}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ckd-delivery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
async function until<T>(read:()=>Promise<T|undefined>):Promise<T>{for(let i=0;i<400;i++){const value=await read();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out waiting for fixture');}

test('focused pixel check uses one targeted vision request, separates score caches and invalidates changed operation/model context',async t=>{
 const root=fixture(t),bytes=await png();let calls=0;
 const model:LibraryModel={async complete(request){calls++;assert.equal(request.purpose,'vision');assert.ok(request.image?.equals(bytes));assert.equal(request.maxTokens,1500);assert.doesNotMatch(request.prompt,/metrics|clarity|calibrated_score/u);return {text:JSON.stringify(observed()),model:'targeted-test'};}};
 const checker=new PixelOperationFocusChecker(root,{model});
 const a=await checker.check(bytes,'Check camera connector',new AbortController().signal);assert.equal(a.status,'identified');assert.equal(a.source,'image');assert.equal(calls,1);
 const b=await new PixelOperationFocusChecker(root,{model}).check(bytes,'Check camera connector',new AbortController().signal);assert.equal(b.cached,true);assert.equal(calls,1);
 await checker.check(bytes,'Check a different connector',new AbortController().signal);assert.equal(calls,2);
 const before=process.env.VISION_MODEL_ID;try{process.env.VISION_MODEL_ID='changed-targeted-model';await checker.check(bytes,'Check camera connector',new AbortController().signal);assert.equal(calls,3);}finally{if(before===undefined)delete process.env.VISION_MODEL_ID;else process.env.VISION_MODEL_ID=before;}
 assert.deepEqual(fs.readdirSync(path.join(root,'ckd/image-quality')),[PIXEL_FOCUS_VERSION]);
});

test('description evidence is hash-bound, exact and complete; insufficient or fabricated quotes trigger targeted image inspection',async t=>{
 const root=fixture(t),bytes=await png(),file=path.join(root,'ckd/library-cache/photos',hash(bytes)+'.json');let text=0,vision=0;
 write(file,JSON.stringify({sha256:hash(bytes),description:'Camera connector fully seated. A red cable is visible.'}));
 const model:LibraryModel={async complete(request){if(request.purpose==='overview'){text++;return {text:JSON.stringify(observed()),model:'text-test'};}vision++;return {text:JSON.stringify({...observed('unknown','Necessary pins cannot be resolved'),confidence:.4}),model:'vision-test'};}};
 let result=await new PixelOperationFocusChecker(root,{model}).check(bytes,'Check connector',new AbortController().signal);assert.equal(result.source,'description');assert.equal(result.status,'identified');assert.equal(text,1);assert.equal(vision,0);
 write(file,JSON.stringify({sha256:hash(bytes),description:'A blue machine is visible, but no connector detail is described.'}));
 result=await new PixelOperationFocusChecker(root,{model}).check(bytes,'Check connector',new AbortController().signal);assert.equal(result.source,'image');assert.equal(result.status,'needs_review');assert.equal(text,2);assert.equal(vision,1);
 write(file,JSON.stringify({sha256:'incorrect hash',description:'Camera connector fully seated'}));
 result=await new PixelOperationFocusChecker(root,{model}).check(bytes,'Check connector after source change',new AbortController().signal);assert.equal(result.source,'image');assert.equal(text,2);assert.equal(vision,2);
 const partial:LibraryModel={async complete(){return {text:JSON.stringify({...observed(),coverage:'partial'}),model:'partial-test'};}};
 result=await new PixelOperationFocusChecker(root,{model:partial}).check(bytes,'Check ALL three connections',new AbortController().signal);assert.equal(result.status,'needs_review');
});

test('focused inspection bounds timeout/cancellation, rejects malformed results and serializes identical requests',async t=>{
 const root=fixture(t),bytes=await png();
 const hanging:LibraryModel={async complete(){return new Promise(()=>{});}};
 await assert.rejects(new PixelOperationFocusChecker(root,{model:hanging,timeoutMs:15}).check(bytes,'Check timeout',new AbortController().signal),/超时/u);
 const controller=new AbortController(),pending=new PixelOperationFocusChecker(root,{model:hanging}).check(bytes,'Check cancellation',controller.signal);controller.abort(new Error('cancel fixture'));await assert.rejects(pending,/cancel fixture/u);
 await assert.rejects(new PixelOperationFocusChecker(root,{model:{async complete(){return {text:'{"score":100}',model:'invalid'};}}}).check(bytes,'Check invalid',new AbortController().signal));
 assert.deepEqual(fs.readdirSync(path.join(root,'ckd/image-quality',PIXEL_FOCUS_VERSION)),[]);
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r);
 const model:LibraryModel={async complete(){calls++;await gate;return {text:JSON.stringify(observed()),model:'queued'};}};
 const checker=new PixelOperationFocusChecker(root,{model});const first=checker.check(bytes,'Check queue',new AbortController().signal);const second=checker.check(bytes,'Check queue',new AbortController().signal);release();
 const results=await Promise.all([first,second]);assert.equal(calls,1);assert.deepEqual(results.map(r=>r.cached),[false,true]);
});

async function appFixture(t:{after(fn:()=>void|Promise<void>):void},model:LibraryModel){
 const root=fixture(t),libraryPath=path.join(root,'ckd-library-v2'),dataDir=path.join(root,'data');
 write(path.join(libraryPath,'product_lib/TARGET/project.json'),JSON.stringify({version:1,projectId:'TARGET',displayName:'Target',aliases:['TARGET']}));
 const folder=path.join(libraryPath,'processes_lib/factory_test/camera_test');write(path.join(folder,'metadata'),'Camera Test');write(path.join(folder,'operation_steps.txt'),'Check camera connector.');write(path.join(folder,'photos/p1.png'),await png());
 const app=createCkdUiServer({libraryPath,dataDir,imageScorer:'pixel-v1.23.0',imageQualityModel:model});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const address=app.server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));});
 let token='';const request=(route:string,value?:unknown,options:{partial?:boolean;review?:boolean;auth?:boolean;method?:string}={})=>fetch(base+route,{method:options.method??(value===undefined?'GET':'POST'),headers:{...(options.auth===false?{}:{Authorization:'Bearer '+token}),...(options.partial===false?{}:{'X-CKD-Partial-Results':'1'}),...(options.review?{'X-CKD-Image-Review':'1'}:{}),...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)});
 const login=await request('/api/client/login',{account:'111',password:'222'});assert.equal(login.status,200);token=(await login.json()).token;
 const start=async(review=false)=>{const response=await request('/api/client/runs',{projectName:'TARGET',documentNumber:'EARLY-1',sopName:'Early workbook',author:'Test',sopType:'factory_test',templateLanguage:'English',factoryTestProcesses:['Camera Test']},{review});assert.equal(response.status,202);return (await response.json()).run.id as string;};
 const get=async(id:string)=>(await (await request('/api/client/runs/'+id)).json()).run;
 return {...app,root,dataDir,libraryPath,request,start,get};
}

test('authenticated workbook download is available during AI wait, old clients wait, recovery reuses workbook and report is never marked passed early',async t=>{
 let entered=false,release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls=0;
 const model:LibraryModel={async complete(){calls++;entered=true;await gate;return {text:JSON.stringify({...observed('unknown','Details not resolved'),confidence:.4}),model:'fixture'};}};
 const app=await appFixture(t,model);t.after(()=>release());const id=await app.start();
 await until(async()=>entered?true:undefined);
 const run=await app.get(id);assert.equal(run.busy,true);assert.equal(run.status,'running');assert.equal(run.result.provisional,true);assert.equal(run.result.output.imageQuality,undefined);assert.equal(run.imageCheck.phase,'focus');assert.equal(run.imageCheck.completed,0);assert.equal(run.imageCheck.total,1);assert.equal(run.imageCheck.imageName,'p1.png');
 const snapshot=app.service.get(id),file=run.result.artifacts[0].url;
 assert.equal((await app.request(file,undefined,{auth:false})).status,401);assert.equal((await app.request(file,undefined,{method:'HEAD'})).status,200);
 const early=Buffer.from(await (await app.request(file)).arrayBuffer());assert.equal(early.subarray(0,2).toString(),'PK');
 assert.equal((await (await app.request('/api/client/runs/'+id,undefined,{partial:false})).json()).run.result,undefined);
 const unauthorized=app.service.create({projectName:'TARGET',documentNumber:'PRIVATE',sopName:'Private',author:'Other',sopType:'factory_test',templateLanguage:'English',factoryTestProcesses:['Camera Test']});
 assert.equal((await app.request(`/api/client/runs/${unauthorized.id}/artifacts/0`)).status,404);
 const absolute=path.resolve(snapshot.workspaceRoot,snapshot.generatedResult!.artifacts[0]!);const time=fs.statSync(absolute).mtimeMs;
 release();const final=await until(async()=>{const r=await app.get(id);return !r.busy?r:undefined;});assert.equal(final.status,'completed',final.error);assert.equal(final.result.provisional,false);assert.equal(final.imageCheck.completed,1);assert.equal(final.imageCheck.status,'completed');assert.equal(final.result.output.imageQuality.focusNeedsReviewCount,1);assert.equal(final.result.output.imageQuality.status,'partial');assert.equal(calls,1);
 assert.deepEqual(Buffer.from(await (await app.request(file)).arrayBuffer()),early);
 // Replay a saved interrupted state with an existing generator receipt. Neither
 // the workbook nor pixel score may be replaced, and focus cache must be reused.
 app.service.store.save(snapshot);
 const recovered=await new CkdWorkflow({dataDir:app.dataDir,libraryPath:app.libraryPath,imageScorer:'pixel-v1.23.0',imageQualityModel:model}).resume(id);
 assert.equal(recovered.status,'completed',recovered.error);assert.equal(calls,1);assert.equal(fs.statSync(absolute).mtimeMs,time);assert.deepEqual(fs.readFileSync(absolute),early);
});

test('pre-generation image confirmation remains mandatory, and cancellation preserves an explicitly unfinished downloadable workbook',async t=>{
 let hang=false,entered=false;const model:LibraryModel={async complete(){if(hang){entered=true;return new Promise(()=>{});}return {text:JSON.stringify(observed('unknown','Cannot verify the action')),model:'fixture'};}};
 const app=await appFixture(t,model);const gated=await app.start(true);
 const review=await until(async()=>{const run=await app.get(gated);return !run.busy?run:undefined;});assert.equal(review.status,'awaiting_image_review',review.error);assert.equal(review.result,undefined);assert.equal((await app.request(`/api/client/runs/${gated}/artifacts/0`)).status,404);
 assert.equal((await app.request(`/api/client/runs/${gated}/generate`,{reviewId:review.imageReview.id,revision:review.imageReview.revision+1})).status,409);
 assert.equal((await app.request(`/api/client/runs/${gated}/generate`,{reviewId:review.imageReview.id,revision:review.imageReview.revision})).status,202);
 const approved=await until(async()=>{const run=await app.get(gated);return !run.busy?run:undefined;});assert.equal(approved.status,'completed',approved.error);
 // Changed operation context prevents reuse of the completed task's AI result.
 write(path.join(app.libraryPath,'processes_lib/factory_test/camera_test/operation_steps.txt'),'Check a second, hidden connector.');hang=true;
 const id=await app.start();await until(async()=>entered?true:undefined);const before=await app.get(id);assert.equal(before.result.provisional,true);
 assert.equal((await app.request(`/api/client/runs/${id}/cancel`,{})).status,200);
 const cancelled=await until(async()=>{const run=await app.get(id);return !run.busy?run:undefined;});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.imageCheck.status,'cancelled');assert.equal(cancelled.result.provisional,true);assert.equal(cancelled.result.output.imageQuality,undefined);assert.equal((await app.request(cancelled.result.artifacts[0].url)).status,200);
});
