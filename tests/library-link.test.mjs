import { memoryFixturePath, writeMemoryFixture } from './memory-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createLibraryLinkTool, LIBRARY_LINK_TOOL_NAME} from '../dist/tools/library-link.js';
import {createWebServer} from '../dist/web/server.js';
import {AgentApi} from '../integrations/wecom-bridge/api.mjs';

const endpoint='https://tool-files.patrick-shenzhen.org/api/ai-search';
const execute=(tool,prompt='我要 DT50S 的规格书',signal)=>tool.execute('test-call',{prompt},signal);

test('library link search POSTs only the original prompt verbatim to the fixed endpoint and preserves all returned links',async()=>{
 const original='  我要 DT50S 的规格书\n英文版，请同时给我工具下载链接。  ';
 let calls=0;
 const data={outcome:'matched',message:'相关结果',matches:[{name:'DT50S Spec.pdf',url:'https://files.example/DT50S%20Spec.pdf',comment:'英文规格书'},{name:'utility.zip',url:'https://files.example/utility.zip'}]};
 const tool=createLibraryLinkTool({getPrompt:()=>original,request:async(url,init)=>{
  calls++;assert.equal(url,endpoint);assert.equal(init.method,'POST');assert.equal(init.headers['Content-Type'],'application/json');assert.equal(init.redirect,'error');
  assert.deepEqual(JSON.parse(init.body),{prompt:original});assert.equal(Object.keys(JSON.parse(init.body)).length,1);return Response.json(data);
 }});
 assert.equal(tool.name,LIBRARY_LINK_TOOL_NAME);
 const result=await execute(tool,'模型改写后的关键词');assert.equal(calls,1);assert.equal(result.details.prompt,original);assert.deepEqual(result.details.response,data);assert.equal(JSON.parse(result.content[0].text).response.matches.length,2);
});

test('no match stays a successful empty result and missing current user text never falls back to invented arguments',async()=>{
 const empty={outcome:'no_match',message:'未找到相关文件',matches:[]};
 const tool=createLibraryLinkTool({request:async()=>Response.json(empty)});
 assert.deepEqual((await execute(tool)).details.response,empty);
 const missing=createLibraryLinkTool({getPrompt:()=>undefined,request:async()=>{throw new Error('must not send');}});
 await assert.rejects(execute(missing,'invented'),/当前用户原文/);
 await assert.rejects(execute(tool,'  '),/当前用户原文/);
});

test('HTTP failures, invalid JSON and oversized streamed responses fail without retries or downloading any matches',async()=>{
 let calls=0;
 const http=createLibraryLinkTool({request:async()=>{calls++;return new Response('private upstream diagnostic',{status:503});}});
 await assert.rejects(execute(http),e=>/HTTP 503/.test(e.message)&&!e.message.includes('private'));assert.equal(calls,1);
 await assert.rejects(execute(createLibraryLinkTool({request:async()=>new Response('<html>error</html>')})),/有效 JSON/);
 await assert.rejects(execute(createLibraryLinkTool({request:async()=>Response.json(['wrong'])})),/格式不正确/);
 let cancelled=false;
 const huge=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(200000));},cancel(){cancelled=true;}});
 await assert.rejects(execute(createLibraryLinkTool({request:async()=>new Response(huge)})),/大小限制/);assert.equal(cancelled,true);
 await assert.rejects(execute(createLibraryLinkTool({request:async()=>new Response('small',{headers:{'content-length':String(1024*1024)}})})),/大小限制/);
});

function waitingRequest(_url,{signal}) { return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>resolve(Response.json({outcome:'no_match',matches:[]})),1000);
 signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
}); }
test('cancellation and timeout abort the outbound request, including cancellation before it starts',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(execute(createLibraryLinkTool({request:async()=>{calls++;return Response.json({});}}),'原文',controller.signal),/已取消/);assert.equal(calls,0);
 await assert.rejects(execute(createLibraryLinkTool({timeoutMs:5,request:waitingRequest})),/超时/);
 const running=new AbortController();const pending=execute(createLibraryLinkTool({request:waitingRequest}),'原文',running.signal);running.abort();await assert.rejects(pending,/已取消/);
});

function reply(res,tool,url='https://files.example/spec.pdf') {
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=tool?{tool_calls:[{index:0,id:'library-call',type:'function',function:{name:LIBRARY_LINK_TOOL_NAME,arguments:JSON.stringify({prompt:'模型自行改写的检索词'})}}]}:{content:`[下载文件](${url})`};
 for(const [value,finish_reason] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'mock',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:value,finish_reason}]})}\n\n`);
 res.end('data: [DONE]\n\n');
}

test('shared Web/WeCom Core preserves original prompts, isolates concurrency and applies an independent persistent library switch to new and restored sessions',{timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'library-link-'));const dataDir=path.join(root,'.data');await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});
 await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'PRIVATE_SKILL_SENTINEL');await writeMemoryFixture(dataDir,'urovo-product-expert','PRIVATE_MEMORY_SENTINEL');
 let enabled=true,binaryEnabled=false;let assertionError;const model=createServer(async(req,res)=>{
  try{
   let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
   assert.equal(body.tools.some(t=>t.function.name===LIBRARY_LINK_TOOL_NAME),enabled);assert.equal(body.tools.length,5+Number(enabled)+Number(binaryEnabled));
   const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
   if(enabled)assert.match(system,/Copy the full current user prompt verbatim/);else assert.ok(!system.includes(LIBRARY_LINK_TOOL_NAME));
   const last=body.messages.at(-1);if(last.role==='tool'){
    if(!enabled){assert.match(last.content,/not found|not available|unknown/i);return reply(res,false);}
    const output=JSON.parse(last.content);assert.equal(output.ok,true);assert.equal(output.response.matches.length,1);return reply(res,false,output.response.matches[0].url);
   }
   // Also forge a call while disabled: Core must refuse execution without HTTP.
   reply(res,true);
  }catch(error){assertionError=error;res.writeHead(500);res.end('mock assertion failed');}
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 const originalFetch=globalThis.fetch;const outbound=[];
 globalThis.fetch=async(url,init)=>{
  if(String(url)!==endpoint)return originalFetch(url,init);
  const body=JSON.parse(init.body);outbound.push(body);assert.deepEqual(Object.keys(body),['prompt']);assert.ok(!init.body.includes('PRIVATE_'));
  await new Promise(r=>setTimeout(r,5));return Response.json({outcome:'matched',message:'found',matches:[{name:'file.pdf',url:'https://files.example/spec.pdf'}]});
 };
 const token='test-library-link-token-'.repeat(3);const options={cwd:root,dataDir,bridgeToken:token,admin:{account:'admin',password:'test-password'},fileTools:{enabled:false},model:{apiKey:'test',modelId:'fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`}};
 let app,base,api;
 async function start(){app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;api=new AgentApi(base,token);}
 t.after(async()=>{globalThis.fetch=originalFetch;await app?.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});await start();
 const {id:a}=await api.json('/sessions','POST',{});const {id:b}=await api.json('/sessions','POST',{});
 const first='  我要 DT50S 的规格书\n英文版。  ',second='给我 UMS 工具的下载链接';
 const done=await Promise.all([api.run(a,first,[],()=>{}),api.run(b,second,[],()=>{})]);if(assertionError)throw assertionError;
 assert.deepEqual(new Set(outbound.map(v=>v.prompt)),new Set([first,second]));assert.ok(done.every(v=>!v.failed&&v.run.toolCallCount===1));
 const calls=await api.json(`/sessions/${a}`);assert.equal(calls.runs[0].toolCallCount,1);assert.match(JSON.stringify(calls.messages),/https:\/\/files.example\/spec.pdf/);
 await app.close();await start();const third='现在给我产品介绍 PPT 的链接';await api.run(a,third,[],()=>{});if(assertionError)throw assertionError;
 assert.equal(outbound.length,3);assert.equal(outbound.at(-1).prompt,third);
 // The browser entry goes through the same runtime and preserves surrounding whitespace too.
 const auth=await(await originalFetch(base+'/api/auth/status')).json();const login=await originalFetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':auth.token},body:JSON.stringify(options.admin)});const cookie=login.headers.get('set-cookie').split(';')[0];
 const web=(route,body)=>originalFetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':auth.token,Cookie:cookie},body:JSON.stringify(body)});
 const browserId=(await(await web('/api/sessions',{})).json()).id;const fourth='  请给我工具链接\n保留这句原文。  ';await(await web(`/api/sessions/${browserId}/run`,{text:fourth})).text();if(assertionError)throw assertionError;
 assert.equal(outbound.length,4);assert.equal(outbound.at(-1).prompt,fourth);

 // The admin switch affects both browser and machine API sessions, including restored sessions.
 const preferences=(await(await originalFetch(base+'/api/agent-settings',{headers:{Cookie:cookie}})).json()).settings;
 assert.equal(preferences.libraryLinks.enabled,true);assert.ok(Object.values(preferences.fileTools.tools).every(value=>value===false));
 const save=async(value)=>{
  const status=await(await originalFetch(base+'/api/auth/status')).json();
  const login=await originalFetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':status.token},body:JSON.stringify(options.admin)});
  const headers={'Content-Type':'application/json','X-Local-Token':status.token,Cookie:login.headers.get('set-cookie').split(';')[0]};
  const response=await originalFetch(base+'/api/agent-settings',{method:'PUT',headers,body:JSON.stringify(value)});assert.equal(response.status,200);return headers;
 };
 enabled=false;binaryEnabled=true;preferences.libraryLinks.enabled=false;
 for(const name of Object.keys(preferences.fileTools.tools))preferences.fileTools.tools[name]=name==='pdf_read';
 let headers=await save(preferences);
 await api.run(a,'关闭链接检索后不能调用',[],()=>{});
 const browserNew=(await(await originalFetch(base+'/api/sessions',{method:'POST',headers,body:'{}'})).json()).id;
 await(await originalFetch(base+`/api/sessions/${browserNew}/run`,{method:'POST',headers,body:JSON.stringify({text:'网页也不能调用'})})).text();
 if(assertionError)throw assertionError;assert.equal(outbound.length,4);
 const disabledCalls=await api.json(`/sessions/${a}`);assert.ok(disabledCalls.runs.at(-1).toolCallCount>=1);
 await app.close();await start();
 const restartedAuth=await(await originalFetch(base+'/api/auth/status')).json();
 const restartedLogin=await originalFetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':restartedAuth.token},body:JSON.stringify(options.admin)});
 headers={Cookie:restartedLogin.headers.get('set-cookie').split(';')[0]};
 assert.deepEqual((await(await originalFetch(base+'/api/agent-settings',{headers})).json()).settings,preferences);
 await api.run(a,'重启并恢复的会话仍然关闭',[],()=>{});if(assertionError)throw assertionError;assert.equal(outbound.length,4);
 enabled=true;binaryEnabled=false;preferences.libraryLinks.enabled=true;for(const name of Object.keys(preferences.fileTools.tools))preferences.fileTools.tools[name]=false;await save(preferences);
 await api.run(a,'重新启用后给我文件链接',[],()=>{});if(assertionError)throw assertionError;assert.equal(outbound.length,5);
 assert.equal(outbound.at(-1).prompt,'重新启用后给我文件链接');
});
