import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createWebServer} from '../dist/web/server.js';
import {AgentApi, ApiError} from '../integrations/wecom-bridge/api.mjs';

const TOKEN='test-wecom-private-token-'.repeat(3);
function modelReply(res,text='独立回答'){
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const [delta,finish_reason] of [[{role:'assistant'},null],[{content:text},null],[{},'stop']])res.write(`data: ${JSON.stringify({id:'mock',model:'mock',object:'chat.completion.chunk',created:1,choices:[{index:0,delta,finish_reason}]})}\n\n`);
 res.end('data: [DONE]\n\n');
}
async function setup(t,limits={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-api-'));const dataDir=path.join(root,'.data');await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});
 await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'PRODUCT RULE');await fs.writeFile(path.join(dataDir,'urovo-product-expert/MEMORY.md'),'PRODUCT MEMORY');
 let handler;let requestCount=0;const model=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requestCount++;if(handler)return handler(body,res);modelReply(res);});model.listen(0,'127.0.0.1');await once(model,'listening');
 const options={cwd:root,dataDir,bridgeToken:TOKEN,admin:{account:'admin',password:'password'},model:{apiKey:'FAKE_TEST_KEY',modelId:'fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`},...limits};
 let app,base,api;
 async function start(){app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;api=new AgentApi(base,TOKEN);}
 await start();t.after(async()=>{await app.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
 async function browser(){const token=(await(await fetch(base+'/api/auth/status')).json()).token;const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(options.admin)});const cookie=login.headers.get('set-cookie').split(';')[0];return(route,method='GET',body)=>fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Local-Token':token,Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 return {root,dataDir,get api(){return api;},get base(){return base;},get requestCount(){return requestCount;},browser,setHandler(fn){handler=fn;},async restart(){await app.close();await start();}};
}
async function waitFor(fn){const end=Date.now()+5000;while(!await fn()){if(Date.now()>end)throw new Error('wait timeout');await new Promise(r=>setTimeout(r,10));}}

test('WeCom token is scoped, cookie independent, redacted, and ownership persists through restart', {timeout:30000},async t=>{
 const f=await setup(t);const status=await f.api.json('/status');assert.equal(status.configured,true);assert.ok(!JSON.stringify(status).includes(TOKEN));assert.equal(status.token,undefined);
 assert.equal((await fetch(f.base+'/api/wecom/status')).status,401);
 assert.equal((await fetch(f.base+'/api/wecom/status',{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(f.base+'/api/wecom/status',{headers:{Authorization:`Bearer ${TOKEN}`,Origin:'https://evil.example'}})).status,403);
 await assert.rejects(f.api.json('/agent-settings'),e=>e.status===403);
 const browser=await f.browser();const browserId=(await(await browser('/api/sessions','POST',{})).json()).id;
 await assert.rejects(f.api.json(`/sessions/${browserId}`),e=>e.status===404);
 const {id}=await f.api.json('/sessions','POST',{});await f.api.json(`/sessions/${id}`,'PATCH',{title:'企微会话'});
 const done=await f.api.run(id,'测试问题',[],()=>{});assert.equal(done.failed,false);assert.match(done.messages.at(-1).text,/独立回答/);
 await f.restart();assert.equal((await f.api.json(`/sessions/${id}`)).title,'企微会话');
 assert.equal((await fetch(f.base+'/api/status',{headers:{Authorization:`Bearer ${TOKEN}`}})).status,401);
 await f.api.json(`/sessions/${id}`,'DELETE');await assert.rejects(f.api.json(`/sessions/${id}`),e=>e.status===404);
 assert.ok(!(JSON.parse(await fs.readFile(path.join(f.dataDir,'wecom/api-sessions.json'),'utf8'))).includes(id));
});

test('Web and WeCom share bounded Agent capacity; stop cancels queued work before reaching the model', {timeout:30000},async t=>{
 const f=await setup(t,{maxConcurrentRuns:1,runQueueLimit:1});const browser=await f.browser();const a=(await(await browser('/api/sessions','POST',{})).json()).id;const {id:b}=await f.api.json('/sessions','POST',{});const {id:c}=await f.api.json('/sessions','POST',{});
 let release;
 f.setHandler((_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(': waiting\n\n');release=()=>modelReplyAfterHeaders(res);});
 const first=browser(`/api/sessions/${a}/run`,'POST',{text:'web slow'}).then(r=>r.text());await waitFor(()=>f.requestCount===1);
 const queued=f.api.run(b,'queued WeCom',[],()=>{});const queuedResult=queued.catch(error=>error);await waitFor(async()=>(await f.api.json('/status')).queue.waiting===1);
 await assert.rejects(f.api.run(c,'overflow',[],()=>{}),e=>e.status===429);
 await f.api.json(`/sessions/${b}/stop`,'POST',{});const cancelled=await queuedResult;assert.ok(cancelled instanceof ApiError);assert.equal(cancelled.status,499);assert.equal(f.requestCount,1);
 assert.equal((await f.api.json('/status')).queue.waiting,0);release();await first;assert.equal((await f.api.json('/status')).queue.active,0);
});
function modelReplyAfterHeaders(res){res.write(`data: ${JSON.stringify({id:'mock',model:'mock',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:{content:'完成'},finish_reason:'stop'}]})}\n\n`);res.end('data: [DONE]\n\n');}

test('disabled WeCom credential does not grant machine API access or create bridge data',async t=>{
 const f=await setup(t,{bridgeToken:''});assert.equal((await fetch(f.base+'/api/wecom/status',{headers:{Authorization:`Bearer ${TOKEN}`}})).status,401);assert.equal(await fs.stat(path.join(f.dataDir,'wecom')).catch(()=>null),null);
});
