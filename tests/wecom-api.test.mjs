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

test('Recent conversations use scoped WeCom names without renaming sessions, groups or custom titles', {timeout:30000}, async t => {
 const f=await setup(t);let browser=await f.browser();
 const create=async title=>{const {id}=await f.api.json('/sessions','POST',{});await f.api.json(`/sessions/${id}`,'PATCH',{title});return id;};
 const title='企微 · same-user';
 const a=await create(title),b=await create(title),old=await create(title),group=await create('企微 · 群 same-user'),custom=await create('Customer rollout');
 const webId=(await(await browser('/api/sessions','POST',{})).json()).id;
 await browser(`/api/sessions/${webId}`,'PATCH',{title});
 const record=async botId=>(await f.api.json('/contacts','POST',{botId,userId:'same-user',chatType:'single',at:Date.now()})).contact;
 const ca=await record('bot-a'),cb=await record('bot-b');
 const key=(bot,type,target)=>JSON.stringify([bot,type,target]);
 const state={version:1,conversations:{
  [key('bot-a','single','same-user')]:{sessionId:a,updated:Date.now()},
  [key('bot-b','single','same-user')]:{sessionId:b,updated:Date.now()},
  [key('bot-a','group','same-user')]:{sessionId:group,updated:Date.now()},
 },jobs:[{key:key('bot-a','single','same-user'),sessionId:old},{key:key('bot-a','single','same-user'),sessionId:custom}]};
 const mappingFile=path.join(f.dataDir,'wecom/bridge-state.json');await fs.writeFile(mappingFile,JSON.stringify(state));
 const snapshot=await fs.readFile(mappingFile,'utf8');
 const list=async()=> (await(await browser('/api/sessions')).json()).sessions;
 assert.equal((await list()).find(s=>s.id===a).displayTitle,undefined);
 const alias='<script>张三</script>';
 assert.equal((await browser(`/api/wecom-contacts/${ca.id}`,'PATCH',{name:alias})).status,200);
 assert.equal((await browser(`/api/wecom-contacts/${cb.id}`,'PATCH',{name:'李四'})).status,200);
 let sessions=await list();
 for(const id of [a,old]){assert.equal(sessions.find(s=>s.id===id).displayTitle,`企微 · ${alias}`);assert.equal(sessions.find(s=>s.id===id).title,title);}
 assert.equal(sessions.find(s=>s.id===b).displayTitle,'企微 · 李四');
 for(const id of [group,custom,webId])assert.equal(sessions.find(s=>s.id===id).displayTitle,undefined);
 assert.equal((await f.api.json(`/sessions/${a}`)).title,title);
 assert.equal((await fs.readFile(mappingFile,'utf8')),snapshot,'display lookup must not write bridge mappings');
 await f.restart();browser=await f.browser();sessions=await list();assert.equal(sessions.find(s=>s.id===a).displayTitle,`企微 · ${alias}`);const before=sessions.find(s=>s.id===a).updated;
 await browser(`/api/wecom-contacts/${ca.id}`,'PATCH',{name:'王五'});
 sessions=await list();assert.equal(sessions.find(s=>s.id===a).displayTitle,'企微 · 王五');assert.equal(sessions.find(s=>s.id===a).updated,before);
 await browser(`/api/wecom-contacts/${ca.id}`,'PATCH',{name:''});
 sessions=await list();assert.equal(sessions.find(s=>s.id===a).displayTitle,undefined);assert.equal(sessions.find(s=>s.id===a).title,title);
 assert.equal(sessions.find(s=>s.id===b).displayTitle,'企微 · 李四');
 assert.equal(f.requestCount,0,'display names must not invoke the model');
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

test('explicit WeCom files/balance routes require bridge auth, use fixed upstreams without model/history and honor the library switch',async t=>{
 const f=await setup(t,{webTools:{apiKey:'official-balance-secret',enabled:false}});const browser=await f.browser();
 const original=globalThis.fetch;const outbound=[];let failure=false;
 globalThis.fetch=async(url,init)=>{
  if(String(url)==='https://tool-files.patrick-shenzhen.org/api/ai-search'){
   outbound.push({url,init});if(failure)return new Response('private upstream detail',{status:503});
   return Response.json({outcome:'matched',matches:[{name:'K388Pro SDK.zip',url:'https://files.example/sdk.zip?token=a%2Bb'}]});
  }
  if(String(url)==='https://api.deepseek.com/user/balance'){
   outbound.push({url,init});assert.equal(init.headers.Authorization,'Bearer official-balance-secret');
   return Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.34',granted_balance:'0.00',topped_up_balance:'12.34'}]});
  }
  return original(url,init);
 };t.after(()=>{globalThis.fetch=original;});
 const headers={Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'};
 assert.equal((await fetch(f.base+'/api/wecom/balance')).status,401);
 assert.equal((await browser('/api/wecom/balance')).status,401);
 assert.equal((await fetch(f.base+'/api/wecom/balance',{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(f.base+'/api/wecom/balance',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 assert.equal((await fetch(f.base+'/api/wecom/files',{method:'GET',headers})).status,403);
 assert.equal((await fetch(f.base+'/api/wecom/balance',{method:'POST',headers,body:'{}'})).status,403);
 assert.equal((await fetch(f.base+'/api/wecom/balance?apiKey=untrusted',{headers})).status,400);
 for(const body of [{prompt:'x',history:'private'}, {prompt:''}, {prompt:'x\0'}, {prompt:'x'.repeat(12001)}, {prompt:7}])await assert.rejects(f.api.json('/files','POST',body),e=>e.status===400);
 assert.equal(outbound.length,0);
 const raw='  给我 K388Pro 的 SDK\n不要重写这条需求。  ';
 const result=await f.api.json('/files','POST',{prompt:raw});assert.match(result.text,/sdk.zip\?token=a%2Bb/);
 assert.equal(outbound.length,1);assert.deepEqual(JSON.parse(outbound[0].init.body),{prompt:raw});assert.equal(outbound[0].init.method,'POST');assert.equal(outbound[0].init.redirect,'error');assert.equal(outbound[0].init.headers.Authorization,undefined);
 const info=await f.api.json('/balance');assert.match(info.text,/CNY：12.34/);assert.ok(!JSON.stringify(info).includes('secret'));assert.equal(outbound[1].init.body,undefined);
 assert.equal(f.requestCount,0);assert.deepEqual((await(await browser('/api/sessions')).json()).sessions,[]);
 failure=true;await assert.rejects(f.api.json('/files','POST',{prompt:'try once'}),e=>e.status===424&&/HTTP 503/.test(e.message)&&!e.message.includes('private upstream'));
 assert.equal(outbound.length,3);
 const preferences=(await(await browser('/api/agent-settings')).json()).settings;preferences.libraryLinks.enabled=false;
 assert.equal((await browser('/api/agent-settings','PUT',preferences)).status,200);
 await assert.rejects(f.api.json('/files','POST',{prompt:'disabled'}),e=>e.status===403&&/已关闭/.test(e.message));assert.equal(outbound.length,3);
 await f.api.json('/balance');assert.equal(outbound.length,4);assert.equal(f.requestCount,0);
});

test('balance never forwards a third-party model key when no official key is selected',async t=>{
 const f=await setup(t,{webTools:{apiKey:'',enabled:false}});const original=globalThis.fetch;let external=0;
 globalThis.fetch=async(url,init)=>{if(String(url).startsWith('https://')){external++;throw new Error('must not request');}return original(url,init);};t.after(()=>{globalThis.fetch=original;});
 await assert.rejects(f.api.json('/balance'),e=>e.status===424&&e.message.includes('DEEPSEEK_API_KEY')&&!e.message.includes('FAKE_TEST_KEY'));assert.equal(external,0);assert.equal(f.requestCount,0);
});

test('direct commands use separate bounded capacity and cancel disconnected queued queries',async t=>{
 const f=await setup(t);const original=globalThis.fetch;const releases=[];let calls=0;
 globalThis.fetch=async(url,init)=>{
  if(String(url)==='https://tool-files.patrick-shenzhen.org/api/ai-search'){
   calls++;return new Promise((resolve,reject)=>{releases.push(()=>resolve(Response.json({outcome:'no_match',matches:[]})));init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
  }return original(url,init);
 };t.after(()=>{globalThis.fetch=original;});
 const a=f.api.json('/files','POST',{prompt:'a'}),b=f.api.json('/files','POST',{prompt:'b'});await waitFor(()=>calls===2);
 const controller=new AbortController();const c=f.api.json('/files','POST',{prompt:'c'},controller.signal);const cancelled=c.catch(e=>e);
 await new Promise(r=>setTimeout(r,30));assert.equal(calls,2);assert.equal((await f.api.json('/status')).queue.active,0);
 controller.abort();await cancelled;await new Promise(r=>setTimeout(r,30));for(const release of releases)release();await Promise.all([a,b]);assert.equal(calls,2);
});

test('scheduled balance reaches only the global recipient through the real machine balance API without model work',async t=>{
 const {BridgeStore}=await import('../integrations/wecom-bridge/store.mjs');
 const {WecomBridge}=await import('../integrations/wecom-bridge/bridge.mjs');
 const {bridgeConfig}=await import('../integrations/wecom-bridge/config.mjs');
 const f=await setup(t,{webTools:{apiKey:'scheduled-official-key',enabled:false}});
 const original=globalThis.fetch;let queries=0;let releaseQuery;
 globalThis.fetch=async(url,init)=>{
  if(String(url)==='https://api.deepseek.com/user/balance'){
   queries++;assert.equal(init.headers.Authorization,'Bearer scheduled-official-key');assert.equal(init.method,'GET');
   await new Promise(resolve=>{releaseQuery=resolve;});
   return Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:'123.45',granted_balance:'0.00',topped_up_balance:'123.45'}]});
  }return original(url,init);
 };
 const sent=[];const client={async sendMessage(target,body){sent.push({target,body});},disconnect(){}};
 const store=await new BridgeStore(path.join(f.dataDir,'scheduled-bridge')).open();let now=Date.parse('2026-10-25T14:59:00+08:00');
 const config=bridgeConfig({WECOM_ENABLED:'true',WECOM_BOTS:'[{"botId":"bot","secret":"s","notifyUserId":"wrong-person"}]',WECOM_NOTIFY_USER_ID:'owner',WECOM_API_TOKEN:TOKEN},f.root);
 const bridge=new WecomBridge({config,store,api:f.api,clients:new Map([['bot',client]]),balanceNow:()=>now,log:{warn(){},error(){}}});await bridge.start();bridge.authenticated('bot');
 f.beforeCleanup(async()=>{releaseQuery?.();await bridge.close();globalThis.fetch=original;});
 now=Date.parse('2026-10-25T15:00:00+08:00');const pending=bridge.balanceNotifier.pump();await waitFor(()=>queries===1);
 assert.deepEqual((await f.api.json('/status')).queue.active,0);
 assert.deepEqual((await f.api.json('/sessions','POST',{})).id.length,36,'ordinary backend access remains responsive during the lookup');
 releaseQuery();await pending;
 assert.equal(sent.length,1);assert.equal(sent[0].target,'owner');assert.match(sent[0].body.markdown.content,/CNY：123.45/);assert.match(sent[0].body.markdown.content,/北京时间 2026-10-25 15:00/);
 await bridge.balanceNotifier.pump();assert.equal(queries,1);assert.equal(f.requestCount,0);assert.deepEqual(store.data.jobs,[]);
});
