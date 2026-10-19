import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createWebTools, publicWebUrl} from '../dist/web-tools/tools.js';
import {webToolConfig} from '../dist/web-tools/config.js';
import {WebRequestLimiter} from '../dist/web-tools/rate-limit.js';
import {createWebServer} from '../dist/web/server.js';
import {AgentApi} from '../integrations/wecom-bridge/api.mjs';

const key='fake-deepseek-key-for-tests';
const execute=(tool,args,signal)=>tool.execute('test-call',args,signal);
const tools=options=>Object.fromEntries(createWebTools({apiKey:key,...options}).map(tool=>[tool.name,tool]));

test('online credentials reuse only direct HTTPS DeepSeek, allow a separate key and preserve opt-in defaults',()=>{
 const model={apiKey:key,baseUrl:'https://api.deepseek.com/v1'};
 assert.deepEqual(webToolConfig({},model,{}),{enabled:false,tools:['search','fetch'],apiKey:key});
 for(const baseUrl of ['http://api.deepseek.com','https://api.deepseek.com.evil.example','https://proxy.example/v1','https://user@api.deepseek.com','invalid'])assert.equal(webToolConfig({}, {...model,baseUrl},{}).apiKey,'');
 assert.equal(webToolConfig({}, {...model,baseUrl:'https://other.example'},{DEEPSEEK_API_KEY:'separate-key'}).apiKey,'separate-key');
 assert.equal(webToolConfig({apiKey:'explicit-key'},model,{DEEPSEEK_API_KEY:'env-key'}).apiKey,'explicit-key');
 assert.throws(()=>webToolConfig({enabled:'true'},model,{}));assert.throws(()=>webToolConfig({tools:['bash']},model,{}));
});

test('search uses fixed authenticated POST with short query/default five/no page content; fetch returns bounded Markdown without downloads',async()=>{
 const calls=[];const t=tools({request:async(url,init)=>{
  assert.equal(init.method,'POST');assert.equal(init.headers.Authorization,`Bearer ${key}`);assert.equal(init.redirect,'error');calls.push([url,JSON.parse(init.body)]);
  if(url.endsWith('/search'))return Response.json({results:[{title:'Official specifications',url:'https://www.example.com/spec',summary:'A summary',snippet:'short',content:'must not return this unexpected page body'},{url:'http://127.0.0.1/private',title:'unsafe'}]});
  return Response.json({title:'Specification',content:`# Product\n${key}\n`+'x'.repeat(65000)});
 }});
 const found=await execute(t.search,{query:'TC58 site:zebra.com'});
 assert.deepEqual(calls[0],['https://api.deepseek.com/v1/tools/search',{query:'TC58 site:zebra.com',count:5,need_content:false}]);
 assert.equal(found.details.results.length,1);assert.equal(found.details.results[0].summary,'A summary');assert.ok(!found.content[0].text.includes('must not return'));
 const read=await execute(t.fetch,{url:'https://www.example.com/spec'});
 assert.deepEqual(calls[1],['https://api.deepseek.com/v1/tools/fetch',{url:'https://www.example.com/spec'}]);
 assert.equal(read.details.truncated,true);assert.equal(read.details.content.length,60000);assert.ok(read.details.content.includes('[REDACTED]'));assert.ok(!JSON.stringify(read).includes(key));
 for(const tool of Object.values(t)){assert.match(tool.description,/only when/i);assert.match(tool.promptGuidelines.join(' '),/do not routinely search/i);}
});

test('invalid queries, unsafe URLs and missing credentials fail before requests; no matches and malformed upstream responses are distinguished',async()=>{
 let requests=0;const t=tools({request:async()=>{requests++;return Response.json({results:[]});}});
 for(const query of ['', ' ', 'x'.repeat(129)])await assert.rejects(execute(t.search,{query}));
 for(const count of [0,11,1.5,'5'])await assert.rejects(execute(t.search,{query:'valid',count}));
 for(const url of ['file:///etc/passwd','http://localhost','http://127.0.0.1','http://2130706433','http://[::1]','https://server.internal/path','https://user:password@example.com','https://example.com/has space','https://example.com/'+'x'.repeat(8192)])await assert.rejects(execute(t.fetch,{url}));
 assert.equal(requests,0);await assert.rejects(execute(tools({apiKey:''}).search,{query:'valid'}),/DeepSeek API Key/);
 assert.equal(publicWebUrl('https://www.zebra.cn/a.pdf'),'https://www.zebra.cn/a.pdf');
 assert.deepEqual((await execute(t.search,{query:'not found'})).details.results,[]);
 await execute(t.search,{query:'🙂'.repeat(128),count:1});assert.equal(requests,2);
 for(const data of [{error:'bad'},[],null])await assert.rejects(execute(tools({request:async()=>Response.json(data)}).search,{query:'valid'}),/格式|results/);
 await assert.rejects(execute(tools({request:async()=>Response.json({title:'page',content:''})}).fetch,{url:'https://example.com'}),/正文/);
});

test('HTTP errors are safe and not retried; invalid/oversized responses fail boundedly',async()=>{
 for(const status of [401,402,403,404,429,503]){
  let count=0;const t=tools({request:async()=>{count++;return new Response('private diagnostic '+key,{status});}});
  await assert.rejects(execute(t.fetch,{url:'https://example.com'}),error=>error.message.includes(`HTTP ${status}`)&&!error.message.includes(key)&&!error.message.includes('private diagnostic'));assert.equal(count,1);
 }
 await assert.rejects(execute(tools({request:async()=>new Response('<html>error</html>')}).search,{query:'valid'}),/有效 JSON/);
 let cancelled=false;const huge=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(600000));},cancel(){cancelled=true;}});
 await assert.rejects(execute(tools({request:async()=>new Response(huge)}).fetch,{url:'https://example.com'}),/1MiB/);assert.equal(cancelled,true);
 await assert.rejects(execute(tools({request:async()=>new Response('small',{headers:{'content-length':String(2*1024*1024)}})}).fetch,{url:'https://example.com'}),/1MiB/);
});

test('online cancellation/timeout abort HTTP and pre-cancelled requests never start',async()=>{
 const wait=(_url,{signal})=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(Response.json({results:[]})),500);
  signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
 });
 const cancelled=new AbortController();cancelled.abort();let started=0;
 await assert.rejects(execute(tools({request:async()=>{started++;return Response.json({});}}).search,{query:'valid'},cancelled.signal),/已取消/);assert.equal(started,0);
 await assert.rejects(execute(tools({request:wait,timeoutMs:10}).search,{query:'valid'}),/超时/);
 const controller=new AbortController();const pending=execute(tools({request:wait}).fetch,{url:'https://example.com'},controller.signal);setTimeout(()=>controller.abort(),10);await assert.rejects(pending,/已取消/);
});

test('shared limiter bounds starts and waiting capacity, removes cancelled work and keeps the other endpoint independent',async()=>{
 const limiter=new WebRequestLimiter(2,50,2);const signal=new AbortController().signal;
 await Promise.all([limiter.acquire(signal),limiter.acquire(signal)]);const time=Date.now();
 const abort=new AbortController();const cancelled=limiter.acquire(abort.signal);const next=limiter.acquire(signal);
 await assert.rejects(limiter.acquire(signal),/队列已满/);abort.abort();await assert.rejects(cancelled);
 const later=limiter.acquire(signal);await new WebRequestLimiter(1,50,1).acquire(signal);
 await Promise.all([next,later]);assert.ok(Date.now()-time>=45);
});

function reply(res,toolName){
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const args=toolName==='search'?{query:'TC58 official specifications',count:5}:{url:'https://www.zebra.com/spec'};
 const delta=toolName?{tool_calls:[{index:0,id:'web-call',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]}:{content:'已完成'};
 for(const [value,finish_reason] of [[{role:'assistant'},null],[delta,null],[{},toolName?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'mock',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:value,finish_reason}]})}\n\n`);
 res.end('data: [DONE]\n\n');
}

test('Web and WeCom share persistent individual online switches, registered prompts, calls and original session history',{timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'online-tools-'));const dataDir=path.join(root,'.data');await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});
 await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'PRIVATE_SKILL_SENTINEL');await fs.writeFile(path.join(dataDir,'urovo-product-expert/MEMORY.md'),'PRIVATE_MEMORY_SENTINEL');
 let active=[],error;const payloads=[];const model=createServer(async(req,res)=>{
  try{
   let text='';for await(const part of req)text+=part;const body=JSON.parse(text);payloads.push(body);
   const names=body.tools.map(tool=>tool.function.name);for(const name of ['search','fetch'])assert.equal(names.includes(name),active.includes(name));
   const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.equal(system.includes('do not routinely search'),active.length>0);
   const last=body.messages.at(-1);if(last.role==='tool')return reply(res);
   const user=body.messages.findLast(m=>m.role==='user');const prompt=typeof user.content==='string'?user.content:JSON.stringify(user.content);
   reply(res,prompt.includes('FETCH')?'fetch':'search');
  }catch(e){error=e;res.writeHead(500);res.end('assertion failed');}
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 const originalFetch=globalThis.fetch;const outbound=[];
 globalThis.fetch=async(url,init)=>{
  if(!String(url).startsWith('https://api.deepseek.com/v1/tools/'))return originalFetch(url,init);
  assert.equal(init.headers.Authorization,`Bearer ${key}`);assert.ok(!init.body.includes('PRIVATE_'));outbound.push([String(url),JSON.parse(init.body)]);
  return String(url).endsWith('/search')?Response.json({results:[{title:'official',url:'https://www.zebra.com/spec',summary:'specifications'}]}):Response.json({title:'official',content:'# Specifications'});
 };
 const bridgeToken='online-tools-test-token-'.repeat(3);const options={cwd:root,dataDir,admin:{account:'admin',password:'fixture-password'},bridgeToken,fileTools:{enabled:false},webTools:{apiKey:key},model:{apiKey:'mock-model-key',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,modelId:'fixture'}};
 let app,base,api,headers;
 async function start(){
  app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;api=new AgentApi(base,bridgeToken);
  const status=await(await originalFetch(base+'/api/auth/status')).json();const login=await originalFetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':status.token},body:JSON.stringify(options.admin)});
  headers={'Content-Type':'application/json','X-Local-Token':status.token,Cookie:login.headers.get('set-cookie').split(';')[0]};
 }
 const web=(route,method='GET',body)=>originalFetch(base+'/api'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 t.after(async()=>{globalThis.fetch=originalFetch;await app?.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});await start();
 const initial=await(await web('/agent-settings')).json();assert.deepEqual(initial.settings.webTools,{tools:{search:false,fetch:false}});assert.equal(initial.webToolsConfigured,true);assert.ok(!JSON.stringify(initial).includes(key));
 const preferences=initial.settings;const {id:a}=await api.json('/sessions','POST',{});const {id:b}=await api.json('/sessions','POST',{});
 // Model-forged calls while off must fail without outbound HTTP.
 await api.run(a,'SEARCH despite disabled',[],()=>{});if(error)throw error;assert.equal(outbound.length,0);
 const set=async(names,enabled=true)=>{
  active=enabled?names:[];preferences.webTools={tools:{search:enabled&&names.includes('search'),fetch:enabled&&names.includes('fetch')}};
  const result=await web('/agent-settings','PUT',preferences);assert.equal(result.status,200);assert.ok(!(await result.text()).includes(key));
 };
 await set(['search','fetch']);
 await Promise.all([api.run(a,'SEARCH official',[],()=>{}),(async()=>{const res=await web(`/sessions/${b}/run`,'POST',{text:'FETCH official'});assert.equal(res.status,200);await res.text();})()]);if(error)throw error;
 assert.equal(outbound.length,2);assert.ok(outbound.some(([url])=>url.endsWith('/search')));assert.ok(outbound.some(([url])=>url.endsWith('/fetch')));
 const history=await api.json(`/sessions/${a}`);assert.equal(history.runs.at(-1).toolCallCount,1);const trace=await(await web(`/sessions/${a}/runs/${history.runs.at(-1).id}/tools`)).json();assert.equal(trace.calls[0].name,'search');assert.equal(trace.calls[0].status,'completed');assert.match(JSON.stringify(trace.calls[0].result),/specifications/);assert.ok(trace.calls[0].elapsedMs>=0);
 await set(['search']);await api.run(a,'FETCH disabled individual',[],()=>{});if(error)throw error;assert.equal(outbound.length,2);
 await api.run(a,'SEARCH still enabled',[],()=>{});if(error)throw error;assert.equal(outbound.length,3);
 await app.close();await start();assert.deepEqual((await(await web('/agent-settings')).json()).settings.webTools,preferences.webTools);
 await api.run(a,'SEARCH after restart',[],()=>{});if(error)throw error;assert.equal(outbound.length,4);
 await set(['fetch']);await api.run(b,'FETCH alone',[],()=>{});if(error)throw error;assert.equal(outbound.length,5);
 await set(['search','fetch'],false);await api.run(a,'SEARCH after both switches off',[],()=>{});if(error)throw error;assert.equal(outbound.length,5);
 await app.close();await start();await api.run(b,'FETCH restored with both switches off',[],()=>{});if(error)throw error;assert.equal(outbound.length,5);
 assert.ok(payloads.at(-1).tools.some(tool=>tool.function.name==='get_file_link_from_library'));
 const files=await fs.readdir(path.join(dataDir,'sessions'));assert.ok(files.length>=2);for(const file of files)assert.ok(!(await fs.readFile(path.join(dataDir,'sessions',file),'utf8')).includes(key));
 assert.equal((await fs.stat(path.join(dataDir,'web-agent-settings.json'))).mode&0o777,0o600);
 await app.close();options.webTools.apiKey='';await start();assert.equal((await(await web('/agent-settings')).json()).webToolsConfigured,false);
 const before=(await(await web('/agent-settings')).json()).settings;
 const missing=await web('/agent-settings','PUT',{...before,webTools:{enabled:true,tools:{search:true,fetch:true}}});assert.equal(missing.status,400);assert.match((await missing.json()).error,/DeepSeek/);
 assert.deepEqual((await(await web('/agent-settings')).json()).settings,before);
});
