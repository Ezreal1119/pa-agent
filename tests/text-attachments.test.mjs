import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {FileStore} from '../dist/file-tools/store.js';
import {fileToolConfig,TEXT_INPUT_EXTENSIONS,TEXT_OUTPUT_EXTENSIONS} from '../dist/file-tools/config.js';
import {createWebServer} from '../dist/web/server.js';
import {writeMemoryFixture} from './memory-fixtures.mjs';
import {WecomBridge} from '../integrations/wecom-bridge/bridge.mjs';
import {BridgeStore} from '../integrations/wecom-bridge/store.mjs';
import {AgentApi} from '../integrations/wecom-bridge/api.mjs';

test('text allowlist preserves UTF-8 chunks and original bytes; disguised binary, incomplete UTF-8, paths and limits fail without partial files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'text-inputs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new FileStore(fileToolConfig(root,{maxFileBytes:1024},{ }));const id=randomUUID();
 const bytes=Buffer.from('\ufeff中文😀\r\n<script>DO_NOT_RUN</script>\n');
 for(const ext of TEXT_INPUT_EXTENSIONS){const file=await store.upload(id,'source'+ext,Array.from(bytes,b=>Buffer.from([b])));const opened=await store.open(id,file.id);try{assert.deepEqual(await opened.handle.readFile(),bytes);}finally{await opened.handle.close();}}
 const before=(await store.list(id)).length;
 for(const bytes of [Buffer.from('abc\0data'),Buffer.from([0xff,0xfe,0x41,0]),Buffer.from([0xe4,0xb8]),Buffer.from('%PDF\0binary')])await assert.rejects(store.upload(id,'bad.txt',[bytes]),/UTF-8/);
 await assert.rejects(store.upload(id,'too-large.log',[Buffer.alloc(1025,65)]),/size/);
 for(const name of ['../escape.txt','.env','payload.exe','old.doc'])await assert.rejects(store.upload(id,name,[Buffer.from('data')]));
 assert.equal((await store.list(id)).length,before);
 assert.equal((await fs.readdir(path.join(store.directory(id),'inputs'))).length,before);
 assert.ok(!TEXT_OUTPUT_EXTENSIONS.has('.log'),'receiving logs does not widen output formats');
});

function reply(res,tool,text='Located the requested log evidence.'){
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=tool?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{content:text};
 for(const [value,end] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:value,finish_reason:end}]})}\n\n`);
 res.end('data: [DONE]\n\n');
}
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'text-chat-'));const dataDir=path.join(root,'.data');
 await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'FIXTURE');await writeMemoryFixture(dataDir,'urovo-product-expert','MEMORY');
 let handler;let modelError;const payloads=[];
 const model=createServer(async(req,res)=>{try{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);payloads.push(body);handler(body,res);}catch(error){modelError=error;res.destroy(error);}});
 model.listen(0,'127.0.0.1');await once(model,'listening');
 let app;let bridge;
 t.after(async()=>{await bridge?.close();await app?.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
 const token='text-bridge-fixture-key-'.repeat(3);
 const options={cwd:root,dataDir,resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'fixture'},bridgeToken:token,model:{apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`},fileTools:{enabled:true,tools:['pdf_read']}};
 let base,csrf,cookie;
 async function start(){
  app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;
  csrf=(await(await fetch(base+'/api/auth/status')).json()).token;const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'x-local-token':csrf,'content-type':'application/json'},body:JSON.stringify({account:'admin',password:'fixture'})});cookie=login.headers.get('set-cookie').split(';')[0];
 }
 await start();
 const request=(url,method='GET',body,headers={})=>fetch(base+url,{method,headers:{Cookie:cookie,'x-local-token':csrf,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});
 return {root,dataDir,get base(){return base;},token,payloads,request,async restart(){await app.close();await start();},check(){if(modelError)throw modelError;},set handler(value){handler=value;},set bridge(value){bridge=value;}};
}
const attached=body=>{
 const brief=body.messages.filter(m=>m.role==='user').flatMap(m=>Array.isArray(m.content)?m.content:[]).findLast(c=>c.type==='text'&&c.text.startsWith('Files attached to this message'));
 assert.ok(brief);return JSON.parse(brief.text.split('\n')[1])[0];
};
test('Web text/code attachments use real scoped grep/read without a new tool, survive restore, and never inject a multi-megabyte log wholesale',{timeout:30000},async t=>{
 const f=await setup(t);const tools=[];
 f.handler=(body,res)=>{
  const file=attached(body);assert.equal(file.format,'plain-text');assert.ok(path.isAbsolute(file.readPath));assert.ok(JSON.stringify(body).length<60000);
  assert.ok(!body.tools.some(t=>t.function.name==='text_read'));
  const last=body.messages.at(-1);
  if(last.role!=='tool'){tools.push('grep');return reply(res,{name:'grep',args:{path:file.readPath,pattern:'ACTION_PTT|KEYCODE_PTT',limit:3,context:1}});}
  assert.match(last.content,/ACTION_PTT|KEYCODE_PTT/);
  if(last.tool_call_id&&body.messages.filter(m=>m.role==='tool').length===1){tools.push('read');return reply(res,{name:'read',args:{path:file.readPath,offset:80001,limit:3}});}
  reply(res);
 };
 const log=Buffer.from('noise line with no matching event data\n'.repeat(80000)+'ACTION_PTT pressed KEYCODE_PTT=123\nACTION_PTT released\n'+'noise line after the event\n'.repeat(40000));assert.ok(log.length>3.66*1024*1024);
 const status=await(await f.request('/api/status')).json();assert.equal(status.fileTools.maxFileBytes,30*1024*1024);for(const ext of ['.txt','.md','.java','.log','.jsonl'])assert.ok(status.fileTools.acceptedExtensions.includes(ext));
 const session=(await(await f.request('/api/sessions','POST',{})).json()).id;
 const uploaded=await f.request(`/api/sessions/${session}/files?name=android.LOG`,'POST',log,{'content-type':'application/octet-stream'});assert.equal(uploaded.status,201);const file=(await uploaded.json()).file;
 const run=await f.request(`/api/sessions/${session}/run`,'POST',{text:'Find the call broadcast or keycode',attachmentIds:[file.id]});const events=await run.text();f.check();assert.ok(!events.includes('"failed":true'),events);assert.deepEqual(tools,['grep','read']);
 const download=await f.request(`/api/sessions/${session}/files/${file.id}`);assert.deepEqual(Buffer.from(await download.arrayBuffer()),log);
 // The existing association persists on disk; scoped read paths are computed again from it.
 const saved=await fs.readdir(path.join(f.dataDir,'sessions'));const transcript=await fs.readFile(path.join(f.dataDir,'sessions',saved.find(n=>n.endsWith('.jsonl'))),'utf8');assert.ok(transcript.includes('message-attachments-v1'));assert.ok(!transcript.includes('noise line with no matching event data\nnoise line'));
 await f.restart();let restoredRead=false;
 f.handler=(body,res)=>{const file=attached(body);if(body.messages.at(-1).role==='tool'){assert.match(body.messages.at(-1).content,/ACTION_PTT/);restoredRead=true;return reply(res);}reply(res,{name:'read',args:{path:file.readPath,offset:80001,limit:3}});};
 await(await f.request(`/api/sessions/${session}/run`,'POST',{text:'Read the relevant lines in the previous log again'})).text();f.check();assert.ok(restoredRead);
 const second=(await(await f.request('/api/sessions','POST',{})).json()).id;
 const forbidden=path.join(f.dataDir,'files',session,file.path);let blocked=false;
 f.handler=(body,res)=>{if(body.messages.at(-1).role==='tool'){assert.match(body.messages.at(-1).content,/outside|denied/i);blocked=true;return reply(res);}reply(res,{name:'read',args:{path:forbidden}});};
 await(await f.request(`/api/sessions/${second}/run`,'POST',{text:'Try a different conversation file'})).text();f.check();assert.ok(blocked);
});

test('WeCom quoted TXT/Java/Markdown files reach the real Agent read tool and remain associated with their user message',{timeout:30000},async t=>{
 const f=await setup(t);let reads=0;
 f.handler=(body,res)=>{const file=attached(body);if(body.messages.at(-1).role==='tool'){assert.match(body.messages.at(-1).content,/TEXT_FIXTURE_CONTENT/);reads++;return reply(res);}reply(res,{name:'read',args:{path:file.readPath,limit:5}});};
 const store=await new BridgeStore(path.join(f.dataDir,'wecom')).open();
 const client={texts:[],async replyStream(_frame,_stream,text,done){if(done)this.texts.push(text);},async replyStreamNonBlocking(){},async sendMessage(_target,body){this.texts.push(body.markdown.content);},disconnect(){}};
 const bridge=new WecomBridge({store,api:new AgentApi(f.base,f.token),clients:new Map([['bot',client]]),config:{concurrency:1,queueLimit:8,maxFileBytes:30*1024*1024,timeoutMs:30000,token:f.token,bots:[{botId:'bot',secret:'fixture'}]},download:async media=>({name:new URL(media.url).pathname.slice(1),buffer:Buffer.from('TEXT_FIXTURE_CONTENT 中文\n<script>Never run this</script>\n')})});f.bridge=bridge;await bridge.start();bridge.authenticated('bot');
 for(const ext of ['txt','java','md','html','json']){await bridge.receive('bot',{headers:{req_id:randomUUID()},body:{msgid:randomUUID(),chattype:'single',from:{userid:'user-'+ext},msgtype:'text',text:{content:'Read this file'},quote:{msgtype:'file',file:{url:`https://fixture.invalid/input.${ext}`}}}});await bridge.idle();f.check();}
 assert.equal(reads,5);assert.ok(store.data.jobs.every(job=>job.state==='done'));assert.equal(client.texts.length,5);
});
