import { memoryFixturePath, writeMemoryFixture } from './memory-fixtures.mjs';
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
 await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'PRODUCT RULE');await writeMemoryFixture(dataDir,'urovo-product-expert','PRODUCT MEMORY');
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

test('admin contact notes persist, Bridge can register but cannot edit notes, and user aliases do not rename sessions', {timeout:30000},async t=>{
 const f=await setup(t);const browser=await f.browser();
 const {id:sessionId}=await f.api.json('/sessions','POST',{});await f.api.json(`/sessions/${sessionId}`,'PATCH',{title:'独立对话标题'});
 const first=await f.api.json('/contacts','POST',{botId:'bot',userId:'u',chatType:'single',at:Date.now()});const id=first.contact.id;
 assert.equal((await fetch(f.base+'/api/wecom-contacts')).status,401);
 const headers={'Content-Type':'application/json',Authorization:`Bearer ${TOKEN}`};
 assert.equal((await fetch(f.base+`/api/wecom-contacts/${id}`,{method:'PATCH',headers,body:JSON.stringify({name:'forged'})})).status,403);
 await assert.rejects(f.api.json('/contacts','POST',{botId:'bot',userId:'u',chatType:'single',at:Date.now(),name:'forged'}),e=>e.status===400);
 assert.equal((await browser(`/api/wecom-contacts/${id}`,'PATCH',{name:'赵芮同'})).status,200);
 const group=await f.api.json('/contacts','POST',{botId:'bot',userId:'u',chatType:'group',chatId:'group',at:Date.now()});assert.equal(group.contact.id,id);assert.equal(group.contact.name,'赵芮同');assert.deepEqual(group.contact.types,['single','group']);
 const other=await f.api.json('/contacts','POST',{botId:'another-bot',userId:'u',chatType:'single',at:Date.now()});assert.notEqual(other.contact.id,id);assert.equal(other.contact.name,'');
 await f.restart();const loggedIn=await f.browser();const list=(await(await loggedIn('/api/wecom-contacts')).json()).contacts;assert.equal(list.find(c=>c.id===id).name,'赵芮同');
 assert.equal((await loggedIn(`/api/wecom-contacts/${id}`,'PATCH',{name:'bad\nname'})).status,400);
 const empty=await loggedIn(`/api/wecom-contacts/${id}`,'PATCH',{name:''});assert.equal((await empty.json()).contact.name,'');
 assert.equal((await f.api.json(`/sessions/${sessionId}`)).title,'独立对话标题');
 assert.equal(f.requestCount,0,'identity and note management must not invoke the model');
});

function usageReply(res, usage, tool) {
 res.writeHead(200, {'content-type':'text/event-stream'});
 const delta = tool ? {tool_calls:[{index:0,id:'read-test',type:'function',function:{name:'read',arguments:JSON.stringify({path:tool})}}]} : {content:'统计测试完成'};
 for (const [value,finish_reason] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']]) res.write(`data: ${JSON.stringify({id:'stats',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:value,finish_reason}]})}\n\n`);
 if (usage) res.write(`data: ${JSON.stringify({id:'stats',choices:[],usage})}\n\n`);
 res.end('data: [DONE]\n\n');
}

test('per-sender usage counts tool turns once, includes cached input, flags missing usage, survives restart and session deletion', {timeout:30000}, async t => {
 const f=await setup(t); const browser=await f.browser();
 assert.equal((await fetch(f.base+'/wecom-contacts',{redirect:'manual'})).status,302);
 const page=await browser('/wecom-contacts'); assert.equal(page.status,200); assert.match(await page.text(),/contacts.js/);
 assert.equal((await browser('/contacts.js')).status,200);
 const {id}=await f.api.json('/sessions','POST',{});
 const sender=userId=>({botId:'bot',userId,chatType:'group',chatId:'shared-group',at:Date.now()});
 let step=0;
 f.setHandler((_body,res)=>{
  step++;
  if(step===1)return usageReply(res,{prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{cached_tokens:400},completion_tokens_details:{reasoning_tokens:10}},path.join(f.dataDir,'urovo-product-expert/SKILL.md'));
  if(step===2)return usageReply(res,{prompt_tokens:600,completion_tokens:30});
  if(step===3)return usageReply(res); // provider omitted usage
  return usageReply(res,{prompt_tokens:200,completion_tokens:10});
 });
 const first=await f.api.run(id,'A 的工具问题',[],()=>{},undefined,sender('a'));
 assert.equal(first.run.usage.requests,2);assert.equal(first.run.usage.input,1600);assert.equal(first.run.usage.output,50);
 assert.equal(first.run.usage.reportedRequests,2);
 await f.api.run(id,'B 的群问题',[],()=>{},undefined,sender('b'));
 const listed=async web=>(await(await web('/api/wecom-contacts')).json()).contacts;
 let contacts=await listed(browser);let a=contacts.find(c=>c.userId==='a'),b=contacts.find(c=>c.userId==='b');
 assert.equal(a.stats.questions,1);assert.equal(a.stats.inputTokens,1600);assert.equal(a.stats.outputTokens,50);assert.equal(a.stats.coveredRuns,1);
 assert.equal(b.stats.questions,1);assert.equal(b.stats.reportedRequests,0);assert.equal(b.stats.requests,1);assert.equal(b.stats.coveredRuns,0);
 assert.equal((await browser(`/api/wecom-contacts/${a.id}`,'PATCH',{name:'A备注'})).status,200);
 await f.restart();const again=await f.browser();
 await f.api.json(`/sessions/${id}`);await f.api.json(`/sessions/${id}`); // recovery snapshots must be idempotent
 await f.api.run(id,'A 第二轮',[],()=>{},undefined,sender('a'));
 contacts=await listed(again);a=contacts.find(c=>c.userId==='a');b=contacts.find(c=>c.userId==='b');
 assert.equal(a.name,'A备注');assert.equal(a.stats.questions,2);assert.equal(a.stats.inputTokens,1800);assert.equal(a.stats.outputTokens,60);assert.equal(a.stats.requests,3);assert.equal(b.stats.questions,1);
 assert.equal((await again(`/api/sessions/${id}/run`,'POST',{text:'伪造发送者',wecomSender:sender('fake')})).status,403);
 await assert.rejects(f.api.run(id,'bad',[],()=>{},undefined,{...sender('fake'),name:'bad'}),e=>e.status===400);
 await f.api.json(`/sessions/${id}`,'DELETE');contacts=await listed(again);assert.equal(contacts.find(c=>c.userId==='a').stats.questions,2);
 await f.restart();const final=await listed(await f.browser());assert.equal(final.find(c=>c.userId==='a').stats.inputTokens,1800);
});

test('parallel independent sessions keep sender counters separate and stopped runs record only received usage', {timeout:30000}, async t=>{
 const f=await setup(t);const browser=await f.browser();const {id:a}=await f.api.json('/sessions','POST',{});const {id:b}=await f.api.json('/sessions','POST',{});
 const sender=userId=>({botId:'bot',userId,chatType:'single',at:Date.now()});
 const pending=[];f.setHandler((_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(': wait\n\n');pending.push(res);});
 const running=f.api.run(a,'要停止',[],()=>{},undefined,sender('stopped'));await waitFor(()=>pending.length===1);
 const second=f.api.run(b,'同时执行',[],()=>{},undefined,sender('other'));await waitFor(()=>pending.length===2);
 await f.api.json(`/sessions/${a}/stop`,'POST',{});const stopped=await running;assert.equal(stopped.run.status,'stopped');
 const response=pending[1];response.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'完成'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10}})}\n\n`);response.end('data: [DONE]\n\n');await second;
 const contacts=(await(await browser('/api/wecom-contacts')).json()).contacts;
 const stoppedStats=contacts.find(c=>c.userId==='stopped').stats;assert.equal(stoppedStats.questions,1);assert.equal(stoppedStats.finishedRuns,1);assert.equal(stoppedStats.reportedRequests,0);
 assert.equal(contacts.find(c=>c.userId==='other').stats.inputTokens,100);
});
