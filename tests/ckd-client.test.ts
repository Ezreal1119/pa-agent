import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const { BackendClient } = createRequire(import.meta.url)('../desktop/backend.cjs');
import { ClientAccess } from '../src/ckd/client-access.js';
import { UserStore } from '../src/ckd/users.js';
import { createCkdUiServer } from '../src/ckd/ui-server.js';
const input={projectName:'TARGET',documentNumber:'CLIENT-001',sopName:'相机检查',author:'Patrick'};
const write=(file:string,text:string)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
async function fixture(t:{after(fn:()=>Promise<void>|void):void}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ckd-client-')),libraryPath=path.join(root,'ckd-library-v2'),dataDir=path.join(root,'data');
 write(path.join(libraryPath,'product_lib/TARGET/project.json'),JSON.stringify({version:1,projectId:'TARGET',displayName:'Target',aliases:['TARGET']}));
 for(const type of ['factory_test','assembly_test']){write(path.join(libraryPath,'processes_lib',type,'camera_test','metadata'),'Camera Test');write(path.join(libraryPath,'processes_lib',type,'camera_test','operation_steps.txt'),'Check camera image.');}
 const users=new UserStore(dataDir), created=await users.create('client-test');
 await users.changePassword(created.user.id,1,created.initialPassword,'client-test-long-password');
 let app=createCkdUiServer({libraryPath,dataDir});
 const listen=async()=>{app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const a=app.server.address();assert(a&&typeof a==='object');return `http://127.0.0.1:${a.port}`;};
 let url=await listen();let token:string|undefined;
 const request=(route:string,value?:unknown,origin?:string,method?:string)=>fetch(url+route,{method:method??(value===undefined?'GET':'POST'),headers:{'X-CKD-Password-Change':'1',...(token?{Authorization:`Bearer ${token}`} :{}),...(value===undefined?{}:{'Content-Type':'application/json'}),...(origin?{Origin:origin,'X-CKD-UI':'1'}:{})},body:value===undefined?undefined:JSON.stringify(value)});
 const login=async()=>{const response=await request('/api/client/login',{account:'client-test',password:'client-test-long-password'});assert.equal(response.status,200);token=(await response.json()).token;return token;};
 const wait=async(id:string)=>{for(let i=0;i<150;i++){const response=await request('/api/client/runs/'+id);assert.equal(response.status,200);const {run}=await response.json();if(!run.busy)return run;await new Promise(r=>setTimeout(r,20));}throw new Error('Task did not settle');};
 const restart=async()=>{await new Promise<void>(r=>app.server.close(()=>r()));app=createCkdUiServer({libraryPath,dataDir});url=await listen();};
 t.after(async()=>{await new Promise<void>(r=>app.server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});});
 return {root,request,login,wait,restart,url:()=>url,service:()=>app.service};
}
test('client session expires after 12 hours, logout invalidates, restart keeps ownership but drops tokens',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ckd-access-'));try{let now=0;const access=new ClientAccess(root,()=>now);
 const created=await access.users.create('client-test');await access.users.changePassword(created.user.id,1,created.initialPassword,'client-test-long-password');
 await assert.rejects(access.login({account:'111',password:'222'}),/账号或密码/u);
 const {token}=await access.login({account:'client-test',password:'client-test-long-password'});const header='Bearer '+token;
 assert.equal(access.authenticate(header),created.user.id);now=12*60*60*1000;assert.throws(()=>access.authenticate(header),/失效/u);
 const second=await access.login({account:'client-test',password:'client-test-long-password'});access.logout('Bearer '+second.token);assert.throws(()=>access.authenticate('Bearer '+second.token),/失效/u);
 const id='11111111-1111-4111-8111-111111111111';access.claim(id,created.user.id);assert.equal(new ClientAccess(root).owns(id,created.user.id),true);assert.throws(()=>new ClientAccess(root).authenticate(header),/失效/u);assert.throws(()=>access.claim('../outside',created.user.id),/任务不存在/u);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('client API requires server login, denies browser origins, hides admin tasks and administrative endpoints',async t=>{
 const app=await fixture(t);assert.equal((await app.request('/api/client/status')).status,401);assert.equal((await app.request('/api/client/runs/11111111-1111-4111-8111-111111111111/artifacts/0',undefined,undefined,'HEAD')).status,401);
 assert.equal((await app.request('/api/client/login',{account:'111',password:'bad'})).status,401);
 assert.equal((await app.request('/api/client/login',{account:'client-test',password:'client-test-long-password'},'https://foreign.example')).status,403);
 await app.login();assert.equal((await app.request('/api/client/status')).status,200);
 const admin=app.service().create(input);assert.equal((await app.request('/api/client/runs/'+admin.id)).status,404);assert.equal((await app.request('/api/client/runs/'+admin.id+'/cancel',{})).status,404);
 assert.equal((await app.request('/api/client/runs/'+admin.id+'/artifacts/0')).status,404);assert.equal((await app.request('/api/client/runs/'+admin.id+'/artifacts/0',undefined,undefined,'HEAD')).status,404);assert.equal((await app.request('/api/client/library/sync',{})).status,404);assert.equal((await app.request('/api/client/images/policy',{})).status,404);
 assert.equal((await (await app.request('/api/client/runs')).json()).runs.length,0);assert.equal((await (await app.request('/api/runs')).json()).runs.length,1);
 assert.equal((await app.request('/api/runs',input)).status,403);assert.equal((await app.request('/api/client/logout',{})).status,200);assert.equal((await app.request('/api/client/status')).status,401);
});
test('client clarification survives backend restart, rejects stale/invalid answers, and ownership persists',async t=>{
 const app=await fixture(t);await app.login();const response=await app.request('/api/client/runs',input);assert.equal(response.status,202);const id=(await response.json()).run.id;
 let run=await app.wait(id);assert.equal(run.status,'awaiting_clarification');const q=run.pendingQuestion;
 assert.equal((await app.request(`/api/client/runs/${id}/answer`,{questionId:q.id,text:'GPOS730'})).status,400);
 await app.restart();assert.equal((await app.request('/api/client/runs/'+id)).status,401);await app.login();run=await app.wait(id);assert.equal(run.pendingQuestion.id,q.id);
 assert.equal((await app.request(`/api/client/runs/${id}/answer`,{questionId:q.id,text:'手动输入 SOP Processes'})).status,202);run=await app.wait(id);assert.equal(run.pendingQuestion.allowFreeText,true);
 assert.equal((await app.request(`/api/client/runs/${id}/answer`,{questionId:q.id,text:'手动输入 SOP Processes'})).status,400);
 assert.equal((await app.request(`/api/client/runs/${id}/resume`,{})).status,202);assert.equal((await app.request(`/api/client/runs/${id}/cancel`,{})).status,200);assert.equal((await app.wait(id)).status,'cancelled');
});

test('client API keeps optional Assembly revision fields across backend restart', async t => {
 const app=await fixture(t),library=app.service().libraryPath;
 fs.mkdirSync(path.join(library,'processes_lib/assemble'),{recursive:true});
 write(path.join(library,'product_lib/TARGET/assemble/processes/step/metadata.txt'),'Assembly step');
 write(path.join(library,'product_lib/TARGET/assemble/processes/step/Operation_Instruction.txt'),'Install the part.');
 await app.login();
 const response=await app.request('/api/client/runs',{...input,sopType:'assemble',revisionReason:' 调整流程 ',revisionContent:'新增图片\n补充操作要求'});
 assert.equal(response.status,202);const run=await app.wait((await response.json()).run.id);
 assert.notEqual(run.status,'failed',run.error);assert.equal(run.inputs.revisionReason,'调整流程');
 await app.restart();await app.login();
 const saved=(await (await app.request('/api/client/runs/'+run.id)).json()).run;
 assert.equal(saved.inputs.revisionContent,'新增图片\n补充操作要求');
 assert.equal((await app.request('/api/client/runs',{...input,sopType:'assembly_test',revisionContent:'invalid scope'})).status,400);
 await app.request('/api/client/runs/'+run.id+'/cancel',{});
});
test('client creates scored Excel artifacts, streams authenticated downloads and rejects tampered external paths',async t=>{
 const app=await fixture(t);await app.login();const response=await app.request('/api/client/runs',{...input,sopType:'factory_test',factoryTestProcesses:['Camera Test']});
 const run=await app.wait((await response.json()).run.id);assert.equal(run.status,'completed',run.error);assert.ok(run.result.output.processReviews);assert.equal(run.result.output.imageQuality.status,'no_images');
 const file=run.result.artifacts[0];assert.match(file.url,/^\/api\/client\/runs\//u);const head=await app.request(file.url,undefined,undefined,'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>0);assert.match(head.headers.get('content-disposition')!,/filename\*=UTF-8''/u);assert.equal((await app.request(run.result.artifacts[1].url,undefined,undefined,'HEAD')).status,200);
 const download=await app.request(file.url);assert.equal(download.headers.get('content-length'),head.headers.get('content-length'));assert.equal(download.status,200);assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0,2).toString(),'PK');assert.equal((await app.request(run.result.artifacts[1].url)).status,200);
 const desktop=new BackendClient(app.url());await desktop.login({account:'client-test',password:'client-test-long-password'});const metadata=await desktop.artifact(run.id,0);assert.equal(metadata.name,file.name);const savedPath=path.join(app.root,'desktop-saved.xlsx');await desktop.saveArtifact(run.id,0,savedPath,{file:metadata});assert.equal(fs.statSync(savedPath).size,Number(head.headers.get('content-length')));await desktop.logout();
 const original=app.service().get(run.id),artifact=original.finalResult!.artifacts[0]!,absolute=path.resolve(original.workspaceRoot,artifact),external=path.join(app.root,'outside.xlsx');write(external,'external');fs.unlinkSync(absolute);fs.symlinkSync(external,absolute);assert.equal((await app.request(file.url)).status,403);assert.equal((await app.request(file.url,undefined,undefined,'HEAD')).status,403);
});
