import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer, request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createWebServer} from '../dist/web/server.js';
import {writeMemoryFixture} from './memory-fixtures.mjs';
import {httpApiConfig} from '../dist/http-api/config.js';

const KEY='HTTP_API_TEST_SECRET_'.repeat(3), MCP_KEY='MCP_API_TEST_SECRET', BRIDGE_KEY='WECOM_BRIDGE_TEST_SECRET_'.repeat(2);
function reply(res,text='API answer',tool){
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const delta=tool?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{content:text};
 for(const [deltaValue,end] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:deltaValue,finish_reason:end}],...(end?{usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}}:{})})}\n\n`);
 res.end('data: [DONE]\n\n');
}
async function fixture(t,apiOptions={},extra={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plain-http-api-'));const dataDir=path.join(root,'data');
 await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'Private business skill');await writeMemoryFixture(dataDir,'urovo-product-expert','Private business memory');
 const requests=[];let handler;
 const model=createServer(async(req,res)=>{let input='';for await(const part of req)input+=part;const body=JSON.parse(input);requests.push(body);try{if(handler)return handler(body,res);reply(res);}catch(e){res.destroy(e);}});
 model.listen(0,'127.0.0.1');await once(model,'listening');
 const options={cwd:root,dataDir,resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'test-password'},model:{apiKey:'MODEL_TEST_SECRET',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,modelId:'fixture'},fileTools:{enabled:true},httpApi:{enabled:true,apiKey:KEY,waitMs:1000,...apiOptions},mcp:{enabled:true,apiKey:MCP_KEY,waitMs:1000},bridgeToken:BRIDGE_KEY,...extra};
 let app,base;
 async function start(){app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;}
 await start();t.after(async()=>{await app.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
 async function api(route,method='GET',body,headers={}){return fetch(base+'/api/v1'+route,{method,headers:{Authorization:'Bearer '+KEY,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
 async function ask(body){const res=await api('/ask','POST',body);return {http:res.status,body:await res.json()};}
 async function done(id){for(let i=0;i<400;i++){const res=await api('/tasks/'+id);assert.equal(res.status,200);const result=await res.json();if(!['queued','running'].includes(result.status))return result;await new Promise(r=>setTimeout(r,10));}throw Error('Task did not finish');}
 async function admin(){const auth=await(await fetch(base+'/api/auth/status')).json();const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':auth.token},body:JSON.stringify(options.admin)});assert.equal(login.status,200);const headers={Cookie:login.headers.get('set-cookie').split(';')[0],'X-Local-Token':auth.token,'Content-Type':'application/json'};return (route,method='GET',body)=>fetch(base+route,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});}
 return {root,dataDir,options,requests,api,ask,done,admin,get base(){return base;},setHandler(fn){handler=fn;},async restart(){await app.close();await start();}};
}
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Condition timed out');}

test('plain HTTP authenticates separately and returns an answer and exact usage without Cookie, CSRF or MCP',async t=>{
 const f=await fixture(t);const result=await f.ask({question:'Compare DT66 and DT630'});
 assert.equal(result.http,200);assert.equal(result.body.answer,'API answer');assert.equal(result.body.status,'completed');assert.equal(result.body.usage.total_tokens,24);
 assert(f.requests[0].messages.some(m=>typeof m.content==='string'&&m.content.includes('Private business memory')));
 assert.ok(!f.requests[0].tools.some(t=>/memory|image_read|excel/.test(t.function.name)));
 for(const token of [KEY,MCP_KEY,'MODEL_TEST_SECRET'])assert.ok(!JSON.stringify(result).includes(token));
 const first=await(await f.api('/tasks/'+result.body.task_id)).json();assert.equal(first.answer,'API answer');assert.equal(f.requests.length,1);
});

test('missing, wrong, cross-channel and Cookie-only credentials never start a model; admin APIs reject the API key',async t=>{
 const f=await fixture(t);const admin=await f.admin();
 for(const token of ['',MCP_KEY,BRIDGE_KEY,'wrong']){const response=await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({question:'Do not execute'})});assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/Bearer/);}
 assert.equal((await admin('/api/v1/ask','POST',{question:'Cookie cannot authorize'})).status,401);
 assert.equal((await fetch(f.base+'/api/sessions',{headers:{Authorization:'Bearer '+KEY}})).status,401);
 assert.equal((await fetch(f.base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await f.api('/ask','POST',{question:'wrong origin'},{Origin:'https://evil.example'})).status,403);
 assert.equal(f.requests.length,0);
});

test('strict schema, methods, body limits and query restrictions reject invalid requests',async t=>{
 const f=await fixture(t);
 for(const args of [{},{question:' '},{question:'x'.repeat(12001)},{question:'ok',attachmentIds:[]},{question:'ok',role:'admin'},{question:'ok',conversation_id:'bad'},{question:'ok',request_id:null}])assert.equal((await f.ask(args)).http,400);
 assert.equal((await f.api('/ask')).status,405);
 assert.equal((await f.api('/ask?key=bad','POST',{question:'bad'})).status,400);
 assert.equal((await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:'{'})).status,400);
 assert.equal((await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:'Bearer '+KEY},body:'plain'})).status,415);
 assert.equal((await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:' '.repeat(65537)})).status,413);
 assert.equal((await f.api('/tasks/'+randomUUID(),'POST',{})).status,405);
 assert.equal((await f.api('/tasks/'+randomUUID()+'/cancel','POST',{})).status,400);
 assert.equal((await f.api('/tasks/'+randomUUID())).status,404);
 assert.equal((await f.ask({question:'valid',conversation_id:randomUUID()})).http,404);
 assert.equal(f.requests.length,0);
});

test('duplicate Authorization and chunked oversized JSON are rejected with JSON errors',async t=>{
 const f=await fixture(t);
 const send=(headers,content)=>new Promise((resolve,reject)=>{const req=httpRequest(f.base+'/api/v1/ask',{method:'POST',headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(content);});
 assert.equal((await send(['Host',new URL(f.base).host,'Authorization','Bearer '+KEY,'Authorization','Bearer '+KEY,'Content-Type','application/json'],'{"question":"x"}')).status,401);
 assert.equal((await send({'Host':'evil.example','Authorization':'Bearer '+KEY,'Content-Type':'application/json'},'{"question":"wrong host"}')).status,403);
 assert.equal((await send({'Authorization':'Bearer '+KEY,'Content-Type':'application/json','Transfer-Encoding':'chunked'},' '.repeat(70000))).status,413);
 assert.equal(f.requests.length,0);
});

test('follow-ups persist, request_id retries are idempotent and conflicting requests return 409',async t=>{
 const f=await fixture(t);const id=randomUUID();const args={question:'First question',request_id:id};
 const [a,b]=await Promise.all([f.ask(args),f.ask(args)]);assert.equal(a.body.task_id,b.body.task_id);assert.equal(f.requests.length,1);
 assert.equal((await f.ask({question:'Different question',request_id:id})).http,409);
 const follow=await f.ask({question:'Follow-up',conversation_id:a.body.conversation_id});assert.equal(follow.http,200);assert.equal(f.requests.at(-1).messages.filter(m=>m.role==='user').length,2);
 await f.restart();const cached=await f.ask(args);assert.equal(cached.body.task_id,a.body.task_id);assert.equal(cached.body.answer,'API answer');assert.equal(f.requests.length,2);
 assert.equal((await(await f.api('/tasks/'+a.body.task_id)).json()).answer,'API answer');
});

test('long tasks return 202 and continue after connection close; cancellation and same-conversation serialization work',async t=>{
 const f=await fixture(t,{waitMs:0});f.setHandler((_body,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();});
 const a=await f.ask({question:'Long running'});assert.equal(a.http,202);assert.equal(a.body.answer,null);assert.equal(a.body.poll_after_ms,2000);
 await until(()=>f.requests.length===1);
 assert.equal((await f.ask({question:'Overlap',conversation_id:a.body.conversation_id})).http,409);
 const cancel=await f.api('/tasks/'+a.body.task_id+'/cancel','POST');assert([200,202].includes(cancel.status));
 const result=await f.done(a.body.task_id);assert.equal(result.status,'cancelled');assert.equal(f.requests.length,1);
 await f.restart();assert.equal((await f.done(a.body.task_id)).status,'cancelled');
});

test('API task and conversation handles cannot cross to or from MCP and Web, including request_id collisions',async t=>{
 const f=await fixture(t);const admin=await f.admin();const web=(await(await admin('/api/sessions','POST',{})).json()).id;
 assert.equal((await f.ask({question:'Cross Web',conversation_id:web})).http,404);
 const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');const client=new Client({name:'cross-channel-test',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+MCP_KEY}}}));
 const requestId=randomUUID();const mcp=(await client.callTool({name:'ask_product_expert',arguments:{question:'MCP question',request_id:requestId}})).structuredContent;
 assert.equal((await f.api('/tasks/'+mcp.task_id)).status,404);
 assert.equal((await f.api('/tasks/'+mcp.task_id+'/cancel','POST')).status,404);
 assert.equal((await f.ask({question:'Cross MCP',conversation_id:mcp.conversation_id})).http,404);
 const own=await f.ask({question:'API question',request_id:requestId});assert.equal(own.http,200);assert.notEqual(own.body.task_id,mcp.task_id);
 assert.equal((await client.callTool({name:'get_task_result',arguments:{task_id:own.body.task_id}})).isError,true);
 assert.equal((await client.callTool({name:'ask_product_expert',arguments:{question:'Cross API',conversation_id:own.body.conversation_id}})).isError,true);
});

test('shared Web/MCP/API execution gate and API pending limits reject overload without extra model work',async t=>{
 const f=await fixture(t,{waitMs:0,pendingLimit:2},{maxConcurrentRuns:1,runQueueLimit:1});const admin=await f.admin();const web=(await(await admin('/api/sessions','POST',{})).json()).id;
 f.setHandler((_body,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();});
 const webRun=admin(`/api/sessions/${web}/run`,'POST',{text:'Occupy slot'}).then(r=>r.text());await until(()=>f.requests.length===1);
 const queued=await f.ask({question:'API queued'});assert.equal(queued.http,202);
 await until(async()=>{const r=await fetch(f.base+'/api/wecom/status',{headers:{Authorization:'Bearer '+BRIDGE_KEY}});return(await r.json()).queue.waiting===1;});
 const overflow=await f.ask({question:'No capacity'});const overflowResult=await f.done(overflow.body.task_id);assert.equal(overflowResult.status,'failed');assert.equal(overflowResult.error_code,'capacity_exceeded');
 const replay=await f.ask({question:'Replay failed',request_id:randomUUID()});assert([202,429].includes(replay.http));await f.done(replay.body.task_id);
 await f.api('/tasks/'+queued.body.task_id+'/cancel','POST');await f.done(queued.body.task_id);await admin(`/api/sessions/${web}/stop`,'POST',{});await webRun;assert.equal(f.requests.length,1);
});

test('disabled API and unconfigured credentials never invoke the model; rotating only the API key preserves task access',async t=>{
 const f=await fixture(t,{enabled:false});assert.equal((await f.ask({question:'Disabled'})).http,404);assert.equal(f.requests.length,0);
 f.options.httpApi.enabled=true;f.options.httpApi.apiKey='';await f.restart();assert.equal((await f.ask({question:'No key'})).http,401);
 f.options.httpApi.apiKey=KEY;await f.restart();const own=await f.ask({question:'Before rotation'});assert.equal(own.http,200);
 const next='NEW_KEY_FOR_HTTP_API_'.repeat(3);f.options.httpApi.apiKey=next;await f.restart();assert.equal((await f.api('/tasks/'+own.body.task_id)).status,401);
 const restored=await f.api('/tasks/'+own.body.task_id,'GET',undefined,{Authorization:'Bearer '+next});assert.equal(restored.status,200);assert.equal((await restored.json()).answer,'API answer');
});

test('task deadline, API pending admission and configuration overrides are bounded',async t=>{
 const f=await fixture(t,{waitMs:0,pendingLimit:1,taskTimeoutMs:300});f.setHandler((_body,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();});
 const a=await f.ask({question:'Timeout'});assert.equal(a.http,202);assert.equal((await f.ask({question:'Queue overflow'})).http,429);assert.equal((await f.done(a.body.task_id)).status,'cancelled');
 assert.equal(httpApiConfig({},{}).enabled,false);assert.equal(httpApiConfig({},{}).pendingLimit,12);
 assert.throws(()=>httpApiConfig({},{AGENT_API_KEY:'short'}),/at least 32/);assert.throws(()=>httpApiConfig({},{AGENT_API_ENABLED:'yes'}),/true or false/);
});

test('disconnect during the initial wait does not cancel or duplicate the background task',async t=>{
 const f=await fixture(t);let finish;
 f.setHandler((_body,res)=>{finish=()=>reply(res);});
 const requestId=randomUUID(),payload={question:'Survive caller disconnect',request_id:requestId};
 const controller=new AbortController();const disconnected=fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal}).catch(error=>error);
 await until(()=>f.requests.length===1);controller.abort();assert((await disconnected) instanceof Error);
 finish();const retry=await f.ask(payload);assert.equal(retry.http,200);assert.equal(retry.body.status,'completed');assert.equal(retry.body.answer,'API answer');assert.equal(f.requests.length,1);
});

test('API namespace recovers a completed answer from session JSONL after metadata/answer persistence interruption',async t=>{
 const f=await fixture(t);const own=await f.ask({question:'Recover my API answer'});assert.equal(own.body.status,'completed');
 const stateFile=path.join(f.dataDir,'http-api/state.json');const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
 state.tasks[own.body.task_id].status='running';delete state.tasks[own.body.task_id].finished;state.totals.completed=0;
 await fs.writeFile(stateFile,JSON.stringify(state));await fs.rm(path.join(f.dataDir,'http-api/answers',own.body.task_id+'.json'));
 await f.restart();const restored=await f.done(own.body.task_id);assert.equal(restored.status,'completed');assert.equal(restored.answer,'API answer');assert.equal(restored.usage.total_tokens,24);assert.equal(f.requests.length,1);
});
