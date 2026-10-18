import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createWebServer} from '../dist/web/server.js';
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {SessionRetention} from "../dist/agent/retention.js";
import {FileStore} from "../dist/file-tools/store.js";
import {fileToolConfig} from "../dist/file-tools/config.js";
import {fixtures} from './file-fixtures.mjs';

let toolSequence=0;
function reply(res,tool,text='完成测试') {
 res.writeHead(200,{'content-type':'text/event-stream'});
 const chunks=[{role:'assistant'},...(tool?[{tool_calls:[{index:0,id:`test-file-tool-${++toolSequence}`,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}]:[{content:text}]),{}];
 for(const [i,delta] of chunks.entries())res.write(`data: ${JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta,finish_reason:i===chunks.length-1?(tool?'tool_calls':'stop'):null}]})}\n\n`);
 res.end('data: [DONE]\n\n');
}
async function setup(t,enabled=true) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'expert-web-files-'));const dataDir=path.join(root,'.data');await fixtures(path.join(root,'fixtures'));
 for(const name of ['ums-expert','urovo-product-expert']) { await fs.mkdir(path.join(dataDir,name),{recursive:true});await fs.writeFile(path.join(dataDir,name,'SKILL.md'),'BUSINESS SKILL');await fs.writeFile(path.join(dataDir,name,'MEMORY.md'),'BUSINESS MEMORY'); }
 let handler;const payloads=[];const model=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);payloads.push(body);if(handler)return handler(body,res);reply(res);});model.listen(0,'127.0.0.1');await once(model,'listening');
 const options={cwd:root,dataDir,resourcesDir:path.resolve('resources'),admin:{account:'test',password:'test-password'},model:{apiKey:'MAIN_TEST_SECRET',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,modelId:'fixture'},fileTools:{enabled}};
 let app,url,token,cookie;
 async function start(){app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');url=`http://127.0.0.1:${app.server.address().port}`;token=(await(await fetch(url+'/api/auth/status')).json()).token;const login=await fetch(url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify(options.admin)});cookie=login.headers.get('set-cookie').split(';')[0];}
 await start();t.after(async()=>{await app.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
 const request=(route,method='GET',body,headers={})=>fetch(url+route,{method,headers:{'x-local-token':token,Cookie:cookie,...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:typeof body==='object'&&!Buffer.isBuffer(body)?JSON.stringify(body):body});
 const create=async()=>{const res=await request('/api/sessions','POST',{});assert.equal(res.status,201);return(await res.json()).id;};
 const upload=async(id,name)=>{const buffer=await fs.readFile(path.join(root,'fixtures',name));const res=await request(`/api/sessions/${id}/files?name=${encodeURIComponent(name)}`,'POST',buffer,{'content-type':'application/octet-stream'});assert.equal(res.status,201,await res.clone().text());return(await res.json()).file;};
 return {root,dataDir,payloads,request,create,upload,setHandler(fn){handler=fn;},async restart(enabled=options.fileTools.enabled){await app.close();options.fileTools.enabled=enabled;await start();}};
}
const frames=text=>text.split('\n\n').flatMap(frame=>{const event=frame.match(/^event: (.+)$/m)?.[1];const data=frame.match(/^data: (.+)$/m)?.[1];return event&&data?[{event,data:JSON.parse(data)}]:[];});
test('Web binary upload, authenticated download, ownership, restart and session deletion', {timeout:30000}, async t=>{
 const f=await setup(t);const a=await f.create();const b=await f.create();const file=await f.upload(a,'image.png');
 const original=await fs.readFile(path.join(f.root,'fixtures/image.png'));const download=await f.request(`/api/sessions/${a}/files/${file.id}`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),original);assert.match(download.headers.get('content-disposition'),/attachment/);
 assert.equal((await f.request(`/api/sessions/${b}/files/${file.id}`)).status,404);assert.equal((await f.request(`/api/sessions/${a}/files/${file.id}`,'GET',undefined,{Cookie:''})).status,401);
 assert.equal((await f.request(`/api/sessions/${a}/files?name=bad.png`,'POST',original,{'content-type':'application/octet-stream','x-local-token':''})).status,403);
 assert.equal((await f.request(`/api/sessions/${a}/files?name=..%2Fbad.png`,'POST',original,{'content-type':'application/octet-stream'})).status,400);
 await f.restart();const list=await(await f.request(`/api/sessions/${a}/files`)).json();assert.equal(list.files[0].id,file.id);assert.equal((await f.request(`/api/sessions/${a}`)).status,200);
 for(const part of ['outputs','cache','work']){const dir=path.join(f.dataDir,'files',a,part);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'fixture.tmp'),'owned test data');}
 assert.equal((await f.request(`/api/sessions/${a}`,'DELETE')).status,200);assert.equal((await f.request(`/api/sessions/${a}/files/${file.id}`)).status,404);assert.equal(await fs.stat(path.join(f.dataDir,'files',a)).catch(()=>null),null);
});
test('enabled SDK file tools read and patch attachments, retain business injection and expose debug metrics', {timeout:45000}, async t=>{
 const f=await setup(t);const id=await f.create();const file=await f.upload(id,'sample.xlsx');let mode='read';let sawResult=false;
 f.setHandler((body,res)=>{
   const names=body.tools.map(t=>t.function.name);for(const name of ['pdf_read','docx_read','pptx_read','excel_read','excel_patch_template','image_read','memory','read','find','grep','ls'])assert.ok(names.includes(name));
   const system=body.messages.filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content).join('\n');assert.ok(JSON.stringify(body.messages).includes(file.path));assert.equal(system.split('## Extra agent memory\nSource:').length-1,1);
   if(body.messages.at(-1).role==='tool'){const result=JSON.parse(body.messages.at(-1).content);assert.equal(result.ok,true);assert.ok(result.metrics.peakRssKiB>0);sawResult=true;return reply(res);}
   reply(res,mode==='read'?{name:'excel_read',args:{path:file.path,scope:'workbook'}}:{name:'excel_patch_template',args:{sourcePath:file.path,outputPath:'result.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:77}]}});
 });
 const readFrames=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'读取上传的Excel',attachmentIds:[file.id]})).text());const done=readFrames.find(x=>x.event==='done').data;assert.equal(done.failed,false);assert.equal(done.run.toolCallCount,1);assert.ok(sawResult);
 const tools=await(await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();assert.equal(tools.calls[0].status,'completed');assert.ok(tools.calls[0].result.details.metrics.executionMs>=0);
 mode='patch';const patch=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'把B2改成77另存'})).text()).find(x=>x.event==='done').data;assert.equal(patch.failed,false);assert.equal(patch.files.filter(f=>f.direction==='outputs').length,1);assert.equal(patch.messages.filter(m=>m.role==='assistant').at(-1).outputs.length,1);const output=patch.files.find(f=>f.direction==='outputs');assert.equal((await f.request(`/api/sessions/${id}/files/${output.id}`)).status,200);
 assert.ok(!JSON.stringify(f.payloads).includes('data:image/'));
 await f.restart(false);
 f.setHandler((body,res)=>{assert.deepEqual(body.tools.map(t=>t.function.name).sort(),['find','grep','ls','memory','read']);reply(res);});
 const restored=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'关闭文件模块后继续原会话'})).text()).find(x=>x.event==='done').data;assert.equal(restored.failed,false);
 assert.equal((await f.request(`/api/sessions/${id}/files/${output.id}`)).status,200);
 const oldTools=await(await f.request(`/api/sessions/${id}/runs/${done.run.id}/tools`)).json();assert.equal(oldTools.calls[0].name,'excel_read');
 const historical=await(await f.request(`/api/sessions/${id}`)).json();assert.equal(historical.messages.flatMap(m=>m.outputs||[])[0].id,output.id);
});
test('disabled switch preserves exactly five tools and omits file skills and processing', {timeout:30000}, async t=>{
 const f=await setup(t,false);const id=await f.create();
 f.setHandler((body,res)=>{assert.deepEqual(body.tools.map(t=>t.function.name).sort(),['find','grep','ls','memory','read']);assert.ok(!JSON.stringify(body.messages).includes('file-skills'));reply(res);});
 const status=await(await f.request('/api/status')).json();assert.equal(status.fileTools.enabled,false);assert.deepEqual(status.fileTools.tools,[]);
 const result=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'普通问答'})).text()).find(f=>f.event==='done').data;assert.equal(result.failed,false);
 const original=await fs.readFile(path.join(f.root,'fixtures/image.png'));assert.equal((await f.request(`/api/sessions/${id}/files?name=image.png`,'POST',original,{'content-type':'application/octet-stream'})).status,409);
 assert.equal(await fs.stat(path.join(f.dataDir,'files')).catch(()=>null),null);
});
test('enabled native reads cannot bypass session ownership or read configuration', {timeout:30000},async t=>{
 const f=await setup(t);const a=await f.create();const b=await f.create();const file=await f.upload(b,'image.png');await fs.writeFile(path.join(f.root,'.env'),'SENTINEL_SECRET=DO_NOT_READ');let target=path.join(f.root,'.env');let toolResult;
 f.setHandler((body,res)=>{if(body.messages.at(-1).role==='tool'){toolResult=body.messages.at(-1).content;return reply(res);}reply(res,{name:'read',args:{path:target}});});
 await(await f.request(`/api/sessions/${a}/run`,'POST',{text:'test refused read'})).text();assert.match(toolResult,/outside|denied/i);assert.ok(!toolResult.includes('DO_NOT_READ'));
 target=path.join(f.dataDir,'files',b,file.path);await(await f.request(`/api/sessions/${a}/run`,'POST',{text:'test refused cross session'})).text();assert.match(toolResult,/outside|denied/i);
});

test('attachments bind to exact user messages for all five file types and survive restart without rebinding', {timeout:30000}, async t=>{
 const f=await setup(t);const id=await f.create();const files=[];for(const name of ['image.png','sample.pdf','sample.docx','sample.xlsx','sample.pptx'])files.push(await f.upload(id,name));
 f.setHandler((body,res)=>reply(res));
 const run=async(text,ids)=>frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text,attachmentIds:ids})).text()).find(x=>x.event==='done').data;
 const first=await run('分析这五个文件',files.map(file=>file.id));assert.equal(first.failed,false);assert.deepEqual(first.messages.find(m=>m.role==='user').attachments.map(file=>file.id),files.map(file=>file.id));
 const request=f.payloads.at(-1);assert.match(JSON.stringify(request.messages.filter(m=>m.role==='user').at(-1).content),/Files attached to this message/);for(const file of files)assert.ok(JSON.stringify(request.messages.at(-1)).includes(file.path));
 await f.restart();const next=await run('继续说明',[]);assert.deepEqual(next.messages.filter(m=>m.role==='user').at(-1).attachments,[]);const users=f.payloads.at(-1).messages.filter(m=>m.role==='user');assert.match(JSON.stringify(users[0].content),/Files attached to this message/);assert.equal(typeof users.at(-1).content==='string'?users.at(-1).content:users.at(-1).content.map(c=>c.text||'').join(''),'继续说明');
 const third=await run('',[files[1].id]);assert.equal(third.failed,false);assert.equal(third.messages.filter(m=>m.role==='user').at(-1).attachments[0].id,files[1].id);
 const sessions=await SessionManager.list(f.root,path.join(f.dataDir,'sessions'));const raw=await fs.readFile(sessions.find(s=>s.id===id).path,'utf8');const entries=raw.trim().split('\n').map(JSON.parse);assert.ok(entries.some(e=>e.customType==='message-attachments-v1'&&e.data.messageId));const stored=entries.find(e=>e.type==='message'&&e.message.role==='user');assert.ok(!JSON.stringify(stored.message.content).includes('Files attached to this message'));
 // A file prepared later is not silently sent with a text-only run.
 const extra=await f.upload(id,'image.png');await run('没有新附件',[]);assert.ok(!JSON.stringify(f.payloads.at(-1)).includes(extra.path));
 // Seven-plus rounds preserve the existing five-round inference limit.
 for(let i=0;i<5;i++)await run(`普通追问 ${i}`,[]);assert.equal(f.payloads.at(-1).messages.filter(m=>m.role==='user').length,5);assert.ok(!f.payloads.at(-1).messages.filter(m=>m.role==='user').some(m=>JSON.stringify(m.content).includes('Files attached to this message')));
});
test('invalid and cross-session attachment IDs fail before inference; attachment sending is off with the module', {timeout:30000},async t=>{
 const f=await setup(t);const a=await f.create();const b=await f.create();const file=await f.upload(b,'image.png');
 for(const ids of [[file.id],['bad'],[file.id,file.id],'bad'])assert.equal((await f.request(`/api/sessions/${a}/run`,'POST',{text:'test',attachmentIds:ids})).status,400);
 assert.equal(f.payloads.length,0);await f.restart(false);assert.equal((await f.request(`/api/sessions/${b}/run`,'POST',{text:'test',attachmentIds:[file.id]})).status,409);
});
test('expiration removes session and all files together even with file tools off and a fresh attachment mtime', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();await f.upload(id,'sample.pdf');
 const sessions=await SessionManager.list(f.root,path.join(f.dataDir,'sessions'));const file=sessions.find(s=>s.id===id).path;const old=new Date(Date.now()-31*86400000);await fs.utimes(file,old,old);
 // Keep the attachment directory fresh to prove session retention owns the decision.
 await fs.utimes(path.join(f.dataDir,'files',id),new Date(),new Date());await f.restart(false);
 assert.equal(await fs.stat(file).catch(()=>null),null);assert.equal(await fs.stat(path.join(f.dataDir,'files',id)).catch(()=>null),null);assert.equal((await f.request(`/api/sessions/${id}`)).status,404);
});
test('retained sessions keep old file directories and active runs are protected during expiration', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();await f.upload(id,'sample.pdf');const old=new Date(Date.now()-31*86400000);const dir=path.join(f.dataDir,'files',id);await fs.utimes(dir,old,old);
 await f.restart();await f.request(`/api/sessions/${id}`);assert.ok(await fs.stat(dir));
 const sessions=await SessionManager.list(f.root,path.join(f.dataDir,'sessions'));const file=sessions.find(s=>s.id===id).path;
 let release,entered;const started=new Promise(r=>entered=r);f.setHandler(async(body,res)=>{entered();await new Promise(r=>release=r);reply(res);});const running=f.request(`/api/sessions/${id}/run`,'POST',{text:'hold'}).then(r=>r.text());await started;
 await fs.utimes(file,old,old);const retention=new SessionRetention(path.dirname(file),console.error,async sid=>new FileStore(fileToolConfig(f.dataDir,{enabled:true})).remove(sid));assert.deepEqual(await retention.cleanup(),[]);assert.ok(await fs.stat(dir));assert.equal((await f.request(`/api/sessions/${id}`,'DELETE')).status,409);release();await running;
 assert.equal((await f.request(`/api/sessions/${id}`,'DELETE')).status,200);assert.equal(await fs.stat(dir).catch(()=>null),null);
});

test('unsafe attachment storage prevents expiration from deleting the log or following links', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();await f.upload(id,'sample.pdf');const sessions=await SessionManager.list(f.root,path.join(f.dataDir,'sessions'));const log=sessions.find(s=>s.id===id).path;const old=new Date(Date.now()-31*86400000);await fs.utimes(log,old,old);
 const directory=path.join(f.dataDir,'files',id);await fs.rename(directory,directory+'-saved');const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'sentinel'),'keep');await fs.symlink(outside,directory);
 const store=new FileStore(fileToolConfig(f.dataDir,{enabled:false}));const retention=new SessionRetention(path.dirname(log),()=>{},id=>store.remove(id));await assert.rejects(retention.cleanup(),/Unsafe/);assert.ok(await fs.stat(log));assert.equal(await fs.readFile(path.join(outside,'sentinel'),'utf8'),'keep');
});

test('backend output cards support multiple files per run and ignore paths or IDs invented in assistant text', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();const input=await f.upload(id,'sample.xlsx');let step=0;
 f.setHandler((body,res)=>{if(step===2)return reply(res,undefined,'两份文件处理完成。');reply(res,{name:'excel_patch_template',args:{sourcePath:input.path,outputPath:`多份结果-${++step}.xlsx`,operations:[{type:'setCell',sheet:'Data',range:'B2',value:step}]}});});
 const stream=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'生成两份修改版',attachmentIds:[input.id]})).text());const done=stream.find(x=>x.event==='done').data;const events=stream.filter(x=>x.event==='output');assert.equal(events.length,2);assert.ok(events.every(x=>x.data.runId===done.run.id));assert.equal(done.failed,false);
 const answers=done.messages.filter(m=>m.role==='assistant');assert.equal(answers.flatMap(m=>m.outputs).length,2);assert.equal(answers.at(-1).outputs.length,2);assert.ok(!answers.at(-1).text.includes('.xlsx'));
 for(const event of events){const response=await f.request(`/api/sessions/${id}/files/${event.data.file.id}`);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);}
 const sessions=await SessionManager.list(f.root,path.join(f.dataDir,'sessions'));const raw=await fs.readFile(sessions.find(s=>s.id===id).path,'utf8');const records=raw.trim().split('\n').map(JSON.parse).filter(e=>e.customType==='generated-file-v1');assert.equal(records.length,2);assert.ok(records.every(e=>e.data.runId===done.run.id&&e.data.userMessageId&&e.data.toolCallId));
 assert.ok(!JSON.stringify(f.payloads).includes('generated-file-v1'));
 f.setHandler((body,res)=>reply(res,undefined,'已生成 outputs/fiction.xlsx，fileId=00000000-0000-0000-0000-000000000000'));
 const fictional=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'仅文字测试'})).text()).find(x=>x.event==='done').data;assert.deepEqual(fictional.messages.filter(m=>m.role==='assistant').at(-1).outputs,[]);
 await f.restart(false);const restored=await(await f.request(`/api/sessions/${id}`)).json();assert.equal(restored.messages.flatMap(m=>m.outputs||[]).length,2);
});
test('published output remains downloadable after the following model call fails or produces no answer', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();const input=await f.upload(id,'sample.xlsx');
 f.setHandler((body,res)=>{if(body.messages.at(-1).role==='tool'){res.writeHead(401,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'planned model failure'}}));}reply(res,{name:'excel_patch_template',args:{sourcePath:input.path,outputPath:'回答失败仍可下载.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:88}]}});});
 const stream=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'修改后模型失败',attachmentIds:[input.id]})).text());const event=stream.find(x=>x.event==='output');const done=stream.find(x=>x.event==='done').data;assert.ok(event);assert.equal(done.failed,true);const answer=done.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(answer.outputs[0].id,event.data.file.id);assert.match(answer.outputNotice,/未完整完成/);assert.equal((await f.request(`/api/sessions/${id}/files/${event.data.file.id}`)).status,200);
 await f.restart();const restored=await(await f.request(`/api/sessions/${id}`)).json();assert.equal(restored.messages.flatMap(m=>m.outputs||[]).length,1);
});
test('an output event arrives before final text and stopping the run does not discard the file', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();const input=await f.upload(id,'sample.xlsx');
 f.setHandler((body,res)=>{if(body.messages.at(-1).role==='tool')return;reply(res,{name:'excel_patch_template',args:{sourcePath:input.path,outputPath:'停止后仍可下载.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:99}]}});});
 const response=await f.request(`/api/sessions/${id}/run`,'POST',{text:'修改后等待',attachmentIds:[input.id]});const reader=response.body.getReader();let text='';let output;
 while(!output){const {done,value}=await reader.read();assert.equal(done,false);text+=new TextDecoder().decode(value);output=frames(text).find(x=>x.event==='output');}
 assert.ok(!frames(text).some(x=>x.event==='done'));assert.equal((await f.request(`/api/sessions/${id}/files/${output.data.file.id}`)).status,200);assert.equal((await f.request(`/api/sessions/${id}/stop`,'POST',{})).status,200);
 while(true){const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);}
 const done=frames(text).find(x=>x.event==='done').data;assert.equal(done.run.status,'stopped');assert.equal(done.messages.flatMap(m=>m.outputs||[]).length,1);
});
test('legacy backend tool-result metadata restores downloadable cards without parsing assistant paths', {timeout:30000},async t=>{
 const f=await setup(t);const id=await f.create();const input=await f.upload(id,'sample.xlsx');
 f.setHandler((body,res)=>{if(body.messages.at(-1).role==='tool')return reply(res,undefined,'完成。');reply(res,{name:'excel_patch_template',args:{sourcePath:input.path,outputPath:'legacy.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:101}]}});});
 const done=frames(await(await f.request(`/api/sessions/${id}/run`,'POST',{text:'生成旧格式测试'})).text()).find(x=>x.event==='done').data;const file=done.files.find(file=>file.direction==='outputs');const sessions=await SessionManager.list(f.root,path.join(f.dataDir,'sessions'));const log=sessions.find(s=>s.id===id).path;
 const entries=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);const dropped=new Map(entries.filter(e=>e.customType==='generated-file-v1').map(e=>[e.id,e.parentId]));const remaining=entries.filter(e=>e.customType!=='generated-file-v1');for(const entry of remaining)while(dropped.has(entry.parentId))entry.parentId=dropped.get(entry.parentId);await fs.writeFile(log,remaining.map(e=>JSON.stringify(e)).join('\n')+'\n');
 await f.restart(false);const restored=await(await f.request(`/api/sessions/${id}`)).json();assert.equal(restored.messages.flatMap(m=>m.outputs||[])[0].id,file.id);assert.equal((await f.request(`/api/sessions/${id}/files/${file.id}`)).status,200);
});
