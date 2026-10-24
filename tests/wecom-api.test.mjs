import { memoryFixturePath, writeMemoryFixture } from './memory-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
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
 let handler;let requestCount=0;const requests=[];const model=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push(body);requestCount++;if(handler)return handler(body,res);modelReply(res);});model.listen(0,'127.0.0.1');await once(model,'listening');
 const options={cwd:root,dataDir,bridgeToken:TOKEN,admin:{account:'admin',password:'password'},model:{apiKey:'FAKE_TEST_KEY',modelId:'fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`},...limits};
 let app,base,api;const finalizers=[];
 async function start(){app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;api=new AgentApi(base,TOKEN);}
 await start();t.after(async()=>{for(const cleanup of finalizers)await cleanup();await app.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
 async function browser(){const token=(await(await fetch(base+'/api/auth/status')).json()).token;const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(options.admin)});const cookie=login.headers.get('set-cookie').split(';')[0];return(route,method='GET',body)=>fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Local-Token':token,Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 return {root,dataDir,requests,beforeCleanup:fn=>finalizers.push(fn),get api(){return api;},get base(){return base;},get requestCount(){return requestCount;},browser,setHandler(fn){handler=fn;},async restart(){await app.close();await start();}};
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

const roleRoute = (bot,kind,target) => '/role?scope='+encodeURIComponent(JSON.stringify([bot,kind,target]));
const sender = (user,group,bot='bot') => ({botId:bot,userId:user,chatType:group?'group':'single',...(group?{chatId:group}:{}),at:Date.now()});
const systemOf = body => body.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n');

test('scoped roles persist, appear once after extra memory, stay out of Web/history and preserve tools', {timeout:30000},async t=>{
 const f=await setup(t);const route=roleRoute('bot','single','a');
 assert.deepEqual(await f.api.json(route),{text:null});assert.equal(f.requestCount,0);
 const raw='  原文角色\n只给明确结论。\n\n保留换行与空格。  ';
 await f.api.json(route,'PUT',{text:raw});assert.deepEqual(await f.api.json(route),{text:raw});
 assert.equal((await fs.stat(path.join(f.dataDir,'wecom/roles.json'))).mode&0o777,0o600);
 await f.api.json(roleRoute('bot','group','g'),'PUT',{text:'全群角色'});
 const {id}=await f.api.json('/sessions','POST',{});
 await f.api.run(id,'question-a',[],()=>{},undefined,sender('a'));
 const payload=f.requests.at(-1),system=systemOf(payload);assert.ok(system.endsWith('# User Role & Style\n'+raw));assert.ok(system.indexOf('## Extra agent memory')<system.indexOf('# User Role & Style'));assert.equal(system.split('# User Role & Style').length,2);
 const tools=payload.tools.map(tool=>tool.function.name).sort();assert.ok(tools.includes('read'));assert.ok(tools.includes('memory'));assert.ok(!tools.includes('bash'));
 const {id:other}=await f.api.json('/sessions','POST',{});await f.api.run(other,'question-b',[],()=>{},undefined,sender('b'));assert.ok(!systemOf(f.requests.at(-1)).includes('User Role & Style'));
 await f.api.run(other,'question-other-bot',[],()=>{},undefined,sender('a',undefined,'other'));assert.ok(!systemOf(f.requests.at(-1)).includes('User Role & Style'));
 for(const user of ['a','b']){await f.api.run(other,'group-'+user,[],()=>{},undefined,sender(user,'g'));assert.ok(systemOf(f.requests.at(-1)).endsWith('全群角色'));}
 const browser=await f.browser();await (await browser(`/api/sessions/${id}/run`,'POST',{text:'web-in-same-session'})).text();assert.ok(!systemOf(f.requests.at(-1)).includes('User Role & Style'));
 const logs=await fs.readdir(path.join(f.dataDir,'sessions'),{recursive:true});const all=[];for(const file of logs)if(file.endsWith('.jsonl'))all.push(await fs.readFile(path.join(f.dataDir,'sessions',file),'utf8'));
 assert.ok(all.length);assert.ok(all.every(log=>!log.includes('原文角色')&&!log.includes('# User Role & Style')));
 const restartId=id;await f.restart();assert.deepEqual(await f.api.json(route),{text:raw});await f.api.run(restartId,'after restart',[],()=>{},undefined,sender('a'));assert.ok(systemOf(f.requests.at(-1)).endsWith(raw));
 await f.api.json(route,'DELETE',{});await f.api.run(id,'default style',[],()=>{},undefined,sender('a'));assert.ok(!systemOf(f.requests.at(-1)).includes('User Role & Style'));assert.deepEqual(f.requests.at(-1).tools.map(t=>t.function.name).sort(),tools);assert.equal((await f.api.json(roleRoute('bot','group','g'))).text,'全群角色');
});

test('role API is Bridge-only, validates scopes/text, and never exposes arbitrary filesystem paths',async t=>{
 const f=await setup(t);const route=roleRoute('bot','single','a');
 assert.equal((await fetch(f.base+'/api/wecom'+route)).status,401);
 const browser=await f.browser();assert.equal((await browser('/api/wecom'+route)).status,401);assert.equal((await browser('/api/role','PUT',{text:'forged'})).status,404);
 await assert.rejects(f.api.json('/role?scope=bad'),error=>error.status===400);
 await assert.rejects(f.api.json(roleRoute('bot','wrong','a')),error=>error.status===400);
 for(const text of ['', '  ', 'x'.repeat(12001)])await assert.rejects(f.api.json(route,'PUT',{text}),error=>error.status===400);
 await assert.rejects(f.api.json(route,'PUT',{text:'valid',path:'/tmp/role'}),error=>error.status===400);
 const {id}=await f.api.json('/sessions','POST',{});const headers={'Content-Type':'application/json',Authorization:`Bearer ${TOKEN}`};
 assert.equal((await fetch(f.base+`/api/wecom/sessions/${id}/run`,{method:'POST',headers,body:JSON.stringify({text:'question',userRoleStyle:'forged'})})).status,403);
 assert.equal((await browser(`/api/sessions/${id}/run`,'POST',{text:'question',wecomSender:sender('a')})).status,403);assert.equal(f.requestCount,0);
 const file=path.join(f.dataDir,'wecom/roles.json');await f.api.json(route,'PUT',{text:'valid'});const outside=path.join(f.root,'outside.json');await fs.writeFile(outside,'original');await fs.unlink(file);await fs.symlink(outside,file);
 await assert.rejects(f.api.json(route,'PUT',{text:'overwrite'}));assert.equal(await fs.readFile(outside,'utf8'),'original');
});

test('role snapshots are fixed across actual SDK tool turns and reload for the next run', {timeout:30000},async t=>{
 const f=await setup(t);const route=roleRoute('bot','single','a');await f.api.json(route,'PUT',{text:'FIRST-STYLE'});const {id}=await f.api.json('/sessions','POST',{});let changed=false;
 f.setHandler(async(body,res)=>{
  if(!changed){changed=true;await f.api.json(route,'PUT',{text:'NEXT-STYLE'});res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'tool-request',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'read-knowledge',type:'function',function:{name:'read',arguments:JSON.stringify({path:path.join(f.dataDir,'urovo-product-expert/SKILL.md')})}}]},finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'tool-request',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\n`);res.end('data: [DONE]\n\n');}
  else modelReply(res,'answer');
 });
 await f.api.run(id,'snapshot test',[],()=>{},undefined,sender('a'));assert.equal(f.requests.length,2);for(const body of f.requests)assert.ok(systemOf(body).endsWith('FIRST-STYLE'));
 await f.api.run(id,'next run',[],()=>{},undefined,sender('a'));assert.ok(systemOf(f.requests.at(-1)).endsWith('NEXT-STYLE'));
});

test('real Bridge clear archives old SDK history, resets actual model context and retains scoped System style', {timeout:30000},async t=>{
 const {BridgeStore}=await import('../integrations/wecom-bridge/store.mjs');const {WecomBridge}=await import('../integrations/wecom-bridge/bridge.mjs');
 const f=await setup(t);const store=await new BridgeStore(path.join(f.dataDir,'wecom')).open();const replies=[];
 const client={async replyStream(_frame,_id,text,finish){if(finish)replies.push(text);},async replyStreamNonBlocking(){},async sendMessage(_target,body){replies.push(body.markdown.content);},disconnect(){}};
 const api={json:(...args)=>f.api.json(...args),run:(...args)=>f.api.run(...args)};
 const bridge=new WecomBridge({config:{concurrency:2,queueLimit:8,timeoutMs:10000,token:TOKEN,bots:[{botId:'bot',secret:'fake'}]},store,api,clients:new Map([['bot',client]]),log:{warn(){},error(){}}});await bridge.start();bridge.authenticated('bot');f.beforeCleanup(()=>bridge.close());
 const send=async text=>{await bridge.receive('bot',{headers:{req_id:randomUUID()},body:{msgid:randomUUID(),from:{userid:'a'},chattype:'single',msgtype:'text',text:{content:text}}});await bridge.idle();};
 const key=JSON.stringify(['bot','single','a']);
 await send('old conversation fact');const old=store.data.conversations[key].sessionId;
 await send('/role');await send('My persistent style');const count=f.requestCount;await send('/clear suffix');assert.equal(f.requestCount,count);
 const current=store.data.conversations[key].sessionId;assert.notEqual(current,old);assert.equal((await f.api.json(`/sessions/${current}`)).messages.length,0);assert.ok((await f.api.json(`/sessions/${old}`)).messages.some(message=>message.text==='old conversation fact'));
 await send('fresh question');let body=f.requests.at(-1);assert.deepEqual(body.messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:message.content.filter(c=>c.type==='text').map(c=>c.text).join('')),['fresh question']);assert.ok(systemOf(body).endsWith('My persistent style'));const tools=body.tools;
 await f.restart();await send('after backend restart');assert.ok(systemOf(f.requests.at(-1)).endsWith('My persistent style'));
 await send('/role');await send('清除');await send('/clear');await send('default fresh question');body=f.requests.at(-1);assert.ok(!systemOf(body).includes('User Role & Style'));assert.deepEqual(body.tools,tools);assert.deepEqual(body.messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:message.content.filter(c=>c.type==='text').map(c=>c.text).join('')),['default fresh question']);
 assert.ok(replies.includes('已清除当前的会话历史。'));assert.ok((await f.api.json(`/sessions/${old}`)).messages.length>0);
});
