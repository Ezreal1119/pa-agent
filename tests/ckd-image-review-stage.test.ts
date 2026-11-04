import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
import { assessmentSeen } from './helpers/image-assessment.js';
import { sha256 } from '../src/ckd/scripts.js';
const input={projectName:'TARGET',documentNumber:'R-1',sopName:'Review',author:'Patrick',sopType:'factory_test',factoryTestProcesses:['Camera Test','Sensor Test']};
const put=(file:string,value:string|Buffer)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
async function fixture(t:{after(fn:()=>Promise<void>|void):void}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-review-stage-'))),libraryPath=path.join(root,'ckd-library-v2'),dataDir=path.join(root,'data');
 put(path.join(libraryPath,'product_lib/TARGET/project.json'),JSON.stringify({version:1,projectId:'TARGET',displayName:'Target',aliases:[]}));
 const png=await sharp({create:{width:120,height:80,channels:3,background:'#58a47b'}}).png().toBuffer();
 for(const [id,name]of [['camera_test','Camera Test'],['sensor_test','Sensor Test']]) {
  const folder=path.join(libraryPath,'processes_lib/factory_test',id!);put(path.join(folder,'metadata'),name!);put(path.join(folder,'operation_steps.txt'),'Check visible parts.');put(path.join(folder,'photos/p1.png'),png);
  put(path.join(folder,'photos/p2.png'),await sharp(png).resize(60,40).png().toBuffer());
 }
 let calls=0;const model={async complete(request:any){calls++;return {model:'controlled',text:JSON.stringify(request.mode==='vision'?assessmentSeen:{subjectIndex:0,detailsVisible:'yes',confidence:.95,comment:'Visible'})};}};
 let app=createCkdUiServer({libraryPath,dataDir,imageQualityModel:model});let url='',token='';
 async function listen(){app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const a=app.server.address();assert(a&&typeof a==='object');url=`http://127.0.0.1:${a.port}`;}
 await listen();
 const request=(route:string,value?:unknown,origin?:string)=>fetch(url+route,{method:value===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(route==='/api/client/runs'&&value?{'X-CKD-Image-Review':'1'}:{}),...(value===undefined?{}:{'Content-Type':'application/json'}),...(origin?{Origin:origin}: {})},body:value===undefined?undefined:JSON.stringify(value)});
 const login=async()=>{const response=await request('/api/client/login',{account:'111',password:'222'});assert.equal(response.status,200);token=(await response.json()).token;};
 await login();
 const wait=async(id:string)=>{for(let i=0;i<250;i++){const response=await request('/api/client/runs/'+id);assert.equal(response.status,200);const {run}=await response.json();if(!run.busy)return run;await new Promise(r=>setTimeout(r,20));}throw new Error('Task did not settle');};
 const start=async()=>{const r=await request('/api/client/runs',input);assert.equal(r.status,202);return wait((await r.json()).run.id);};
 const crop=async(run:any,index:number,rect:any)=>{const r=await request(`/api/client/runs/${run.id}/images/${run.imageReview.images[index].id}`,{reviewId:run.imageReview.id,revision:run.imageReview.revision,rect});return r;};
 const generate=async(run:any)=>request(`/api/client/runs/${run.id}/generate`,{reviewId:run.imageReview.id,revision:run.imageReview.revision});
 const restart=async()=>{await new Promise<void>(r=>app.server.close(()=>r()));app=createCkdUiServer({libraryPath,dataDir,imageQualityModel:model});await listen();};
 t.after(async()=>{await new Promise<void>(r=>app.server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});});
 return {root,png,libraryPath,dataDir,request,wait,start,crop,generate,restart,login,calls:()=>calls,service:()=>app.service};
}

test('client waits for image confirmation without an Excel, embeds cropped pixels once, skips rescoring and cleans all temporary images',async t=>{
 const app=await fixture(t);let run=await app.start();assert.equal(run.status,'awaiting_image_review',run.error);assert.equal(run.result,undefined);
 assert.equal(run.imageReview.images.length,2,'Factory Test previews only the first selected photo per process');assert.equal(run.imageReview.output.imageQuality.totalImages,2);
 const state=app.service().get(run.id),dir=path.join(state.workspaceRoot,state.workspaceRelative);assert.ok(!fs.readdirSync(path.join(dir,'outputs')).some(n=>n.endsWith('.xlsx')));
 const original=app.service().image(run.id,run.imageReview.images[0].id,true);assert.equal((await sharp(original).metadata()).width,120);
 const beforeCalls=app.calls(),source=path.join(app.libraryPath,'processes_lib/factory_test/camera_test/photos/p1.png');assert.equal(sha256(fs.readFileSync(source)),sha256(app.png));
 let response=await app.crop(run,0,{left:20,top:10,width:70,height:50});assert.equal(response.status,200);run=(await response.json()).run;
 assert.equal(run.imageReview.images[0].cropped,true);assert.equal(run.imageReview.revision,1);assert.equal(app.calls(),beforeCalls);
 const cropped=app.service().image(run.id,run.imageReview.images[0].id);assert.equal((await sharp(cropped).metadata()).width,70);
 response=await app.generate(run);assert.equal(response.status,202);run=await app.wait(run.id);assert.equal(run.status,'completed',run.error);
 assert.equal(run.result.output.imagesConfirmed,true);assert.equal(run.result.output.croppedImageCount,1);assert.equal(run.result.output.imageQuality,undefined);assert.equal(run.result.artifacts.length,1);
 assert.equal(app.calls(),beforeCalls,'Neither cropped nor unchanged images are rescored');assert.ok(!fs.existsSync(path.join(dir,'image-review-temp')));
 assert.equal(sha256(fs.readFileSync(source)),sha256(app.png));
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(path.resolve(state.workspaceRoot,app.service().get(run.id).finalResult!.artifacts[0]!));
 const media=(book.model as any).media;assert.ok(media.some((m:any)=>Buffer.isBuffer(m.buffer)&&sha256(m.buffer)===sha256(cropped)),'Excel contains cropped PNG bytes');
 assert.equal((await app.request(`/api/client/runs/${run.id}/images/${state.imageReview!.images[0]!.id}`)).status,400);
 const second=await app.start();assert.equal(second.status,'awaiting_image_review');assert.equal(second.imageReview.images[0].cropped,false);assert.equal(app.calls(),beforeCalls,'Original observations reuse the existing Hash cache');await app.service().cancel(second.id);
});

test('crop validates bounds, protects stale revisions, restores the original and rejects browser/foreign task access',async t=>{
 const app=await fixture(t);let run=await app.start();
 for(const rect of [{left:-1,top:0,width:10,height:10},{left:0,top:0,width:121,height:10},{left:0.1,top:0,width:1,height:1},{left:0,top:0,width:0,height:1},{left:0,top:0,width:10,height:10,path:'/tmp/x'}])assert.equal((await app.crop(run,0,rect)).status,400);
 assert.equal((await app.crop(run,0,{left:0,top:0,width:20,height:20})).status,200);
 assert.equal((await app.crop(run,0,null)).status,409);assert.equal((await app.generate(run)).status,409);
 run=await app.wait(run.id);const restored=await app.crop(run,0,null);assert.equal(restored.status,200);run=(await restored.json()).run;assert.equal(run.imageReview.images[0].cropped,false);
 const imageUrl=`/api/client/runs/${run.id}/images/${run.imageReview.images[0].id}`;
 assert.equal((await app.request(imageUrl,undefined,'https://foreign.example')).status,403);
 const other=app.service().create({...input} as any);assert.equal((await app.request(`/api/client/runs/${other.id}/images/${run.imageReview.images[0].id}`)).status,404);
 assert.equal((await app.request(imageUrl,{reviewId:run.imageReview.id,revision:run.imageReview.revision,rect:null},'https://foreign.example')).status,403);
 await app.service().cancel(run.id);
});

test('waiting review and crops survive restart, resume does not skip confirmation, and duplicate generate cannot overwrite the workbook',async t=>{
 const app=await fixture(t);let run=await app.start();run=(await (await app.crop(run,0,{left:10,top:10,width:80,height:60})).json()).run;const calls=app.calls();
 await app.restart();assert.equal((await app.request('/api/client/runs/'+run.id)).status,401);await app.login();
 run=await app.wait(run.id);assert.equal(run.status,'awaiting_image_review');assert.equal(run.imageReview.images[0].cropped,true);
 assert.equal((await app.request(`/api/client/runs/${run.id}/resume`,{})).status,202);assert.equal((await app.wait(run.id)).status,'awaiting_image_review');assert.equal(app.calls(),calls);
 const old=run;assert.equal((await app.generate(run)).status,202);run=await app.wait(run.id);assert.equal(run.status,'completed',run.error);assert.equal((await app.generate(old)).status,409);
 const state=app.service().get(run.id),file=path.resolve(state.workspaceRoot,state.finalResult!.artifacts[0]!),hash=sha256(fs.readFileSync(file));
 await app.restart();await app.login();assert.equal((await app.request(`/api/client/runs/${run.id}/resume`,{})).status,202);await app.wait(run.id);assert.equal(sha256(fs.readFileSync(file)),hash);assert.equal(app.calls(),calls);
});

test('cancel removes task crop files without changing Library or successful observation cache',async t=>{
 const app=await fixture(t);let run=await app.start();run=(await (await app.crop(run,0,{left:10,top:10,width:80,height:60})).json()).run;
 const state=app.service().get(run.id),dir=path.join(state.workspaceRoot,state.workspaceRelative,'image-review-temp');assert.ok(fs.existsSync(dir));
 assert.equal((await app.request(`/api/client/runs/${run.id}/cancel`,{})).status,200);assert.ok(!fs.existsSync(dir));assert.equal((await app.generate(run)).status,409);
 assert.equal(sha256(fs.readFileSync(path.join(app.libraryPath,'processes_lib/factory_test/camera_test/photos/p1.png'))),sha256(app.png));
 const calls=app.calls(),next=await app.start();assert.equal(app.calls(),calls);await app.service().cancel(next.id);
});

test('source and crop Hash changes are rejected; generation failure retains crop drafts for explicit recovery',async t=>{
 const app=await fixture(t);let run=await app.start();run=(await (await app.crop(run,0,{left:10,top:10,width:80,height:60})).json()).run;
 const state=app.service().get(run.id),dir=path.join(state.workspaceRoot,state.workspaceRelative),crop=path.join(dir,state.imageReview!.images[0]!.crop!.file),saved=fs.readFileSync(crop);
 fs.writeFileSync(crop,'changed');assert.equal((await app.generate(run)).status,400);assert.equal((await app.wait(run.id)).status,'awaiting_image_review');fs.writeFileSync(crop,saved);
 const source=path.join(app.libraryPath,'processes_lib/factory_test/camera_test/operation_steps.txt'),original=fs.readFileSync(source);fs.writeFileSync(source,'Library changed while waiting');
 assert.equal((await app.generate(run)).status,202);run=await app.wait(run.id);assert.equal(run.status,'failed');assert.match(run.error,/frozen Catalog snapshot/u);assert.ok(fs.existsSync(crop));
 fs.writeFileSync(source,original);const calls=app.calls();assert.equal((await app.request(`/api/client/runs/${run.id}/resume`,{})).status,202);run=await app.wait(run.id);assert.equal(run.status,'completed',run.error);assert.equal(app.calls(),calls);assert.ok(!fs.existsSync(crop));
});
