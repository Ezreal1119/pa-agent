import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createWebServer} from '../dist/web/server.js';
import {McpStore,emptyUsage} from '../dist/mcp/store.js';
import {mcpConfig} from '../dist/mcp/config.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=text=>createHash('sha256').update(text).digest('hex');
function reply(res,{tool,usage=true,text='Expert answer',prompt=100,completion=7}={}){
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const delta=tool?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{content:text};
 for(const [data,end] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:data,finish_reason:end}],...(end&&usage?{usage:{prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion,prompt_tokens_details:{cached_tokens:30},completion_tokens_details:{reasoning_tokens:3}}}:{})})}\n\n`);
 res.end('data: [DONE]\n\n');
}
async function fixture(t,mcp={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'expert-mcp-'));const dataDir=path.join(root,'.data');await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});
 for(const file of ['SKILL.md','MEMORY.md'])await fs.writeFile(path.join(dataDir,'urovo-product-expert',file),'PRIVATE_BUSINESS_CONTEXT');
 await fs.writeFile(path.join(root,'.env'),'PRIVATE_LOCAL_ENV=DO_NOT_EXPOSE');
 const requests=[];let handler;let defaultDelay=0;
 const model=createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const body=JSON.parse(text);requests.push(body);
  try{if(handler)return handler(body,res);const timer=setTimeout(()=>reply(res),defaultDelay);res.on('close',()=>clearTimeout(timer));}catch(error){res.writeHead(500);res.end(error.message);}
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 const options={cwd:root,dataDir,resourcesDir:path.resolve('resources'),admin:{account:'test',password:'test-password'},fileTools:{enabled:true},mcp:{enabled:true,waitMs:1000,...mcp},model:{apiKey:'MCP_MODEL_SECRET',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,modelId:'fixture'}};
 let app,base,adminHeaders;const clients=[];
 async function start(){
  app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;
  const auth=await(await fetch(base+'/api/auth/status')).json();const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':auth.token},body:JSON.stringify(options.admin)});assert.equal(login.status,200);adminHeaders={'Content-Type':'application/json','X-Local-Token':auth.token,Cookie:login.headers.get('set-cookie').split(';')[0]};
 }
 async function client(){const client=new Client({name:'test-mcp-client',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));clients.push(client);return client;}
 const admin=(route,method='GET',body)=>fetch(base+route,{method,headers:adminHeaders,body:body===undefined?undefined:JSON.stringify(body)});
 await start();t.after(async()=>{await Promise.allSettled(clients.map(c=>c.close()));await app.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 return{root,dataDir,requests,options,client,admin,get base(){return base;},setHandler(fn){handler=fn;},setDelay(ms){defaultDelay=ms;},async restart(){await Promise.allSettled(clients.splice(0).map(c=>c.close()));await app.close();await start();}};
}
const call=(client,name,args)=>client.callTool({name,arguments:args});
async function result(client,id){const value=await call(client,'get_task_result',{task_id:id});assert.ok(value.structuredContent,JSON.stringify(value));return value.structuredContent;}
async function finished(client,id){const deadline=Date.now()+10000;while(Date.now()<deadline){const task=await result(client,id);if(!['queued','running'].includes(task.status))return task;await sleep(10);}throw new Error('Task did not finish');}
async function until(fn){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await fn())return;await sleep(5);}throw new Error('Condition timed out');}

test('official MCP client works without auth; fast text replies include exact usage and private admin APIs stay protected',{timeout:20000},async t=>{
 const f=await fixture(t);const client=await f.client();const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name),['ask_product_expert','get_task_result','cancel_task']);
 const reply=await call(client,'ask_product_expert',{question:'Compare products'});assert.equal(reply.isError,undefined);assert.equal(reply.content[0].text,'Expert answer');const task=reply.structuredContent;
 assert.equal(task.status,'completed');assert.deepEqual(task.usage,{input_tokens:100,output_tokens:7,total_tokens:107,model_requests:1,reported_requests:1,missing_requests:0,coverage:'complete'});
 assert.deepEqual(f.requests[0].tools.map(t=>t.function.name).sort(),['find','get_file_link_from_library','grep','ls','read']);assert.ok(!JSON.stringify(f.requests[0]).includes('MCP_MODEL_SECRET'));assert.ok(!JSON.stringify(f.requests[0]).includes('file-skills'));
 assert.equal((await fetch(f.base+'/api/mcp/usage')).status,401);assert.equal((await fetch(f.base+'/api/sessions')).status,401);assert.equal((await fetch(f.base+'/mcp-usage',{redirect:'manual'})).status,302);
 const usage=await(await f.admin('/api/mcp/usage')).json();assert.equal(usage.authentication,'none');assert.equal(usage.totals.totalTokens,107);assert.equal(usage.totals.submitted,1);assert.equal(usage.totals.started,1);assert.equal(usage.totals.completed,1);
 for(let n=0;n<3;n++)assert.equal((await result(client,task.task_id)).answer,'Expert answer');assert.equal(f.requests.length,1);assert.equal((await(await f.admin('/api/mcp/usage')).json()).totals.totalTokens,107);
 const page=await(await f.admin('/mcp-usage')).text();assert.match(page,/MCP usage/);assert.doesNotMatch(page,/\p{Script=Han}/u);
});

test('long tasks return opaque handles, survive disconnect and reconnect, accept only text and reject other channel IDs',{timeout:20000},async t=>{
 const f=await fixture(t,{waitMs:5});f.setDelay(100);const client=await f.client();
 const response=await call(client,'ask_product_expert',{question:'Long question'});const first=response.structuredContent;assert.ok(['queued','running'].includes(first.status));assert.equal(first.answer,null);await client.close();
 const other=await f.client();const done=await finished(other,first.task_id);assert.equal(done.answer,'Expert answer');assert.equal(done.conversation_id,first.conversation_id);assert.equal(f.requests.length,1);
 const next=(await call(other,'ask_product_expert',{question:'Follow-up',conversation_id:first.conversation_id})).structuredContent;await finished(other,next.task_id);assert.equal(next.conversation_id,first.conversation_id);assert.equal(f.requests.at(-1).messages.filter(m=>m.role==='user').length,2);
 for(const args of [{question:'valid',attachmentIds:[randomUUID()]},{question:{file:'x'}},{question:' '},{question:'x'.repeat(12001)},{question:'valid',file_ids:[]},{question:'valid',conversation_id:randomUUID()}])assert.equal((await call(other,'ask_product_expert',args)).isError,true);
 const web=(await(await f.admin('/api/sessions','POST',{})).json()).id;assert.equal((await call(other,'ask_product_expert',{question:'Cross channel',conversation_id:web})).isError,true);
 assert.equal((await call(other,'get_task_result',{task_id:randomUUID()})).isError,true);await assert.rejects(call(other,'read',{path:'/etc/passwd'}),/not found/);assert.equal(f.requests.length,2);
 const third=(await call(other,'ask_product_expert',{question:'Independent topic'})).structuredContent;await finished(other,third.task_id);assert.notEqual(third.conversation_id,first.conversation_id);
});

test('token accounting includes every tool-loop/cache input and output reasoning only once; idempotent retries and restarts never rebill',{timeout:20000},async t=>{
 const f=await fixture(t);const client=await f.client();
 f.setHandler((body,res)=>body.messages.at(-1).role==='tool'?reply(res,{prompt:200,completion:13}):reply(res,{tool:{name:'read',args:{path:path.join(f.dataDir,'urovo-product-expert/SKILL.md')}},prompt:100,completion:7}));
 const requestId=randomUUID();const first=(await call(client,'ask_product_expert',{question:'Use the product knowledge',request_id:requestId})).structuredContent;
 assert.equal(first.usage.input_tokens,300);assert.equal(first.usage.output_tokens,20);assert.equal(first.usage.total_tokens,320);assert.equal(first.usage.model_requests,2);assert.equal(first.tool_calls,1);
 const duplicate=(await call(client,'ask_product_expert',{question:'Use the product knowledge',request_id:requestId})).structuredContent;assert.equal(duplicate.task_id,first.task_id);assert.equal(f.requests.length,2);
 assert.equal((await call(client,'ask_product_expert',{question:'Changed question',request_id:requestId})).isError,true);
 await f.restart();const restored=await f.client();assert.equal((await result(restored,first.task_id)).usage.total_tokens,320);
 await call(restored,'ask_product_expert',{question:'Use the product knowledge',request_id:requestId});assert.equal(f.requests.length,2);
 const summary=await(await f.admin('/api/mcp/usage')).json();assert.equal(summary.totals.submitted,1);assert.equal(summary.totals.totalTokens,320);
});

test('MCP cannot execute memory/file mutations or read configuration even with file tools enabled for Web',{timeout:20000},async t=>{
 const f=await fixture(t);const client=await f.client();let mode='memory';const results=[];
 f.setHandler((body,res)=>{
  assert.ok(!body.tools.some(t=>['memory','excel_read','excel_patch_template','bash','write','edit'].includes(t.function.name)));
  if(body.messages.at(-1).role==='tool'){results.push(body.messages.at(-1).content);return reply(res);}
  const tool=mode==='memory'?{name:'memory',args:{action:'add',content:'MALICIOUS_WRITE'}}:mode==='file'?{name:'excel_patch_template',args:{sourcePath:'/etc/passwd',outputPath:'x.xlsx',operations:[]}}:{name:'read',args:{path:path.join(f.root,'.env')}};
  reply(res,{tool});
 });
 for(mode of ['memory','file','env']){const response=await call(client,'ask_product_expert',{question:'Try forbidden action'});assert.equal(response.structuredContent.status,'completed');}
 assert.match(results[0],/not found|not available/i);assert.match(results[1],/not found|not available/i);assert.match(results[2],/outside|denied/i);
 assert.ok(!results.some(text=>text.includes('DO_NOT_EXPOSE')));assert.equal(await fs.readFile(path.join(f.dataDir,'urovo-product-expert/MEMORY.md'),'utf8'),'PRIVATE_BUSINESS_CONTEXT');assert.equal(await fs.stat(path.join(f.dataDir,'memory/MEMORY.md')).catch(()=>null),null);
});

test('cancellation preserves partial returned usage and missing usage is explicit, not invented',{timeout:20000},async t=>{
 const f=await fixture(t,{waitMs:5});const client=await f.client();let phase='partial';
 f.setHandler((body,res)=>{
  if(phase==='missing')return reply(res,{usage:false});
  if(body.messages.at(-1).role!=='tool')return reply(res,{tool:{name:'read',args:{path:path.join(f.dataDir,'urovo-product-expert/SKILL.md')}}});
  // Keep the second request pending until cancellation; no final usage is available.
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
 });
 const task=(await call(client,'ask_product_expert',{question:'Partial task'})).structuredContent;await until(()=>f.requests.length===2);
 await call(client,'cancel_task',{task_id:task.task_id});const cancelled=await finished(client,task.task_id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.usage.input_tokens,100);assert.equal(cancelled.usage.output_tokens,7);assert.equal(cancelled.usage.model_requests,2);assert.equal(cancelled.usage.reported_requests,1);assert.equal(cancelled.usage.coverage,'partial');
 phase='missing';const missing=(await call(client,'ask_product_expert',{question:'Missing usage'})).structuredContent;const done=await finished(client,missing.task_id);assert.equal(done.usage.coverage,'unavailable');assert.equal(done.usage.total_tokens,0);assert.equal(done.usage.missing_requests,1);
 const before=(await(await f.admin('/api/mcp/usage')).json()).totals;await call(client,'cancel_task',{task_id:task.task_id});await result(client,task.task_id);assert.deepEqual((await(await f.admin('/api/mcp/usage')).json()).totals,before);
});

test('MCP shares the Web run gate and cancels queued work without model usage',{timeout:20000},async t=>{
 const f=await fixture(t,{waitMs:0});f.options.maxConcurrentRuns=1;f.options.runQueueLimit=1;await f.restart();let finishWeb;f.setHandler((_body,res)=>{finishWeb=()=>reply(res);});
 const client=await f.client();const webId=(await(await f.admin('/api/sessions','POST',{})).json()).id;
 const webRun=f.admin(`/api/sessions/${webId}/run`,'POST',{text:'Web takes the slot'}).then(res=>res.text());await until(()=>f.requests.length===1);
 const queued=(await call(client,'ask_product_expert',{question:'Queued MCP'})).structuredContent;assert.equal(queued.status,'queued');assert.equal(queued.usage.model_requests,0);
 await call(client,'cancel_task',{task_id:queued.task_id});const done=await finished(client,queued.task_id);assert.equal(done.status,'cancelled');assert.equal(done.usage.coverage,'not_started');assert.equal(f.requests.length,1);finishWeb();await webRun;
 const total=(await(await f.admin('/api/mcp/usage')).json()).totals;assert.equal(total.totalTokens,0);assert.equal(total.cancelled,1);assert.equal(total.started,0);
});

test('timeout and pending capacity are bounded; distinct anonymous conversations run independently',{timeout:20000},async t=>{
 const f=await fixture(t,{waitMs:0,pendingLimit:1,taskTimeoutMs:1000});const client=await f.client();
 f.setHandler((_body,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();});
 const a=(await call(client,'ask_product_expert',{question:'Timeout'})).structuredContent;
 const excess=await call(client,'ask_product_expert',{question:'Too many tasks'});assert.equal(excess.isError,true);assert.match(excess.content[0].text,/queue is full/);
 const timeout=await finished(client,a.task_id);assert.equal(timeout.status,'cancelled');assert.match(timeout.error,/time limit/);assert.equal(timeout.usage.coverage,'unavailable');
 f.setHandler((_body,res)=>reply(res));const b=(await call(client,'ask_product_expert',{question:'Next task'})).structuredContent;assert.notEqual(b.conversation_id,a.conversation_id);assert.equal((await finished(client,b.task_id)).status,'completed');
});

test('startup replays JSONL usage snapshots exactly once and recovers answer publication after a simulated metadata crash',{timeout:20000},async t=>{
 const f=await fixture(t);const client=await f.client();const a=(await call(client,'ask_product_expert',{question:'Recover my totals'})).structuredContent;
 const file=path.join(f.dataDir,'mcp/state.json');const state=JSON.parse(await fs.readFile(file,'utf8'));const task=state.tasks[a.task_id];task.status='running';task.usage=emptyUsage();state.totals.inputTokens=0;state.totals.outputTokens=0;state.totals.requests=0;state.totals.reportedRequests=0;state.totals.completed=0;state.conversations[a.conversation_id].usage=emptyUsage();await fs.writeFile(file,JSON.stringify(state));
 await f.restart();let c=await f.client();const recovered=await result(c,a.task_id);assert.equal(recovered.status,'completed');assert.equal(recovered.answer,'Expert answer');assert.equal(recovered.usage.total_tokens,107);assert.equal(f.requests.length,1);
 const total=(await(await f.admin('/api/mcp/usage')).json()).totals;assert.equal(total.totalTokens,107);assert.equal(total.completed,1);
 await f.restart();c=await f.client();assert.equal((await result(c,a.task_id)).usage.total_tokens,107);assert.deepEqual((await(await f.admin('/api/mcp/usage')).json()).totals,total);assert.equal(f.requests.length,1);
 // A crash with an unfinished last JSONL snapshot is interrupted, never automatically replayed.
 const pending=JSON.parse(await fs.readFile(file,'utf8'));const sid=pending.tasks[a.task_id].sessionId;pending.tasks[a.task_id].status='running';pending.totals.completed--;
 await fs.writeFile(file,JSON.stringify(pending));await fs.rm(path.join(f.dataDir,'mcp/answers',a.task_id+'.json'));
 const log=(await fs.readdir(path.join(f.dataDir,'sessions'))).find(name=>name.includes(sid));const logPath=path.join(f.dataDir,'sessions',log);
 const lines=(await fs.readFile(logPath,'utf8')).trim().split('\n').map(JSON.parse);const last=lines.findLast(entry=>entry.type==='custom'&&entry.customType==='web-run-metrics-v1');last.data.status='running';last.data.finishedAt=null;last.data.elapsedMs=null;await fs.writeFile(logPath,lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
 await f.restart();c=await f.client();const interrupted=await result(c,a.task_id);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.usage.total_tokens,107);assert.match(interrupted.error,/restart/);assert.equal(f.requests.length,1);
 assert.equal((await(await f.admin('/api/mcp/usage')).json()).totals.interrupted,1);
});

test('manual session deletion removes MCP handles/answers but keeps cumulative token accounting',{timeout:20000},async t=>{
 const f=await fixture(t);const client=await f.client();const a=(await call(client,'ask_product_expert',{question:'Delete this conversation'})).structuredContent;
 const state=JSON.parse(await fs.readFile(path.join(f.dataDir,'mcp/state.json'),'utf8'));const sessionId=state.tasks[a.task_id].sessionId;
 assert.equal((await f.admin(`/api/sessions/${sessionId}`,'DELETE')).status,200);
 assert.equal((await call(client,'get_task_result',{task_id:a.task_id})).isError,true);assert.equal((await call(client,'ask_product_expert',{question:'Try again',conversation_id:a.conversation_id})).isError,true);
 assert.equal(await fs.stat(path.join(f.dataDir,'mcp/answers',a.task_id+'.json')).catch(()=>null),null);const total=await(await f.admin('/api/mcp/usage')).json();assert.equal(total.totals.totalTokens,107);assert.equal(total.retainedTasks,0);
});

test('retention and storage reject links/corruption, serialize usage deltas and preserve totals beyond thirty days',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new McpStore(root,4);await store.load();
 const a=(await store.submit(hash('one'))).task;const b=(await store.submit(hash('two'))).task;
 const usage={input:100,output:7,requests:1,reportedRequests:1};
 await Promise.all([store.update(a.id,{status:'completed',usage,started:Date.now(),finished:Date.now()},{answer:'one'}),store.update(b.id,{status:'completed',usage,started:Date.now(),finished:Date.now()},{answer:'two'})]);
 await store.update(a.id,{usage});assert.equal((await store.summary()).totals.totalTokens,214);await assert.rejects(store.update(a.id,{usage:emptyUsage()}),/monotonic/);
 await store.cleanup(undefined,Date.now()+31*86400000);assert.equal((await store.summary()).retainedTasks,0);assert.equal((await store.summary()).totals.totalTokens,214);assert.equal(await store.answer(a.id),undefined);
 const orphan=path.join(root,'mcp/answers',randomUUID()+'.json');await fs.writeFile(orphan,JSON.stringify({answer:'orphaned after cleanup crash'}));await store.cleanup();assert.equal(await fs.stat(orphan).catch(()=>null),null);
 assert.equal((await fs.stat(store.file)).mode&0o777,0o600);await fs.writeFile(store.file,'broken JSON');await assert.rejects(new McpStore(root).load());
 await fs.rm(store.file);const target=path.join(root,'sentinel.json');await fs.writeFile(target,'{"DO_NOT_RESET":true}');await fs.symlink(target,store.file);await assert.rejects(new McpStore(root).load(),/regular file/);assert.equal(await fs.readFile(target,'utf8'),'{"DO_NOT_RESET":true}');
 assert.equal(mcpConfig({},{}).enabled,false);assert.throws(()=>mcpConfig({waitMs:30000},{}));
});

test('MCP protects Host/Origin and body size without requiring credentials or weakening normal Web CSRF',{timeout:20000},async t=>{
 const f=await fixture(t);const client=await f.client();assert.equal((await client.listTools()).tools.length,3);
 const list={jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'}}}};
 const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'};
 assert.equal((await fetch(f.base+'/mcp',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(list)})).status,403);
 assert.equal((await fetch(f.base+'/mcp',{method:'POST',headers,body:' '.repeat(65537)})).status,413);
 const csrf=await f.admin('/api/sessions','POST',{});assert.equal(csrf.status,201);
 assert.equal((await fetch(f.base+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 // Backward-compatible stateless calls for 2025 clients are supported by the official SDK.
 const legacy=await fetch(f.base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});assert.equal(legacy.status,200,await legacy.clone().text());
});
