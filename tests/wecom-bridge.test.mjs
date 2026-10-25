import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {BridgeStore} from '../integrations/wecom-bridge/store.mjs';
import {WecomBridge} from '../integrations/wecom-bridge/bridge.mjs';
import {ApiError} from '../integrations/wecom-bridge/api.mjs';

export function fakeClient(){return {texts:[],files:[],async replyStream(frame,id,text,finish){if(finish)this.texts.push(text);},async replyStreamNonBlocking(){},async sendMessage(target,body){this.texts.push(body.markdown.content);},async uploadMedia(buffer,options){this.files.push({buffer,options});return{media_id:'media'};},async replyMedia(){},async sendMediaMessage(){},disconnect(){}};}
const message=(user='u',text='问题',chat)=>({headers:{req_id:randomUUID()},body:{msgid:randomUUID(),from:{userid:user},chattype:chat?'group':'single',chatid:chat,msgtype:'text',text:{content:text}}});
async function setup(t,overrides={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-bridge-'));const store=await new BridgeStore(directory).open();
 const sessions=new Map(),runs=[],roles=new Map();let delay=15,active=0,peak=0;const busy=new Set();
 const api={async json(route,method='GET',body){
  if(route.startsWith('/role?')){const key=new URL(route,'http://test').searchParams.get('scope');if(method==='PUT')roles.set(key,body.text);if(method==='DELETE')roles.delete(key);return{text:roles.get(key)??null};}
  if(route==='/contacts')return{contact:{userId:body.userId,name:''}};
  if(route==='/status')return{fileTools:{enabled:true,tools:['excel_read'],maxFileBytes:30*1024*1024}};
  if(route==='/sessions'){const id=randomUUID();sessions.set(id,{id,runs:[],messages:[]});return{id};}
  const id=route.split('/')[2];if(!sessions.has(id))throw new ApiError(404,'missing');if(method==='PATCH')return{};return sessions.get(id);
 },async upload(id,name,buffer){const file={id:randomUUID(),name,bytes:buffer.length};return file;},async download(){return Buffer.from('generated');},async run(id,text,ids,event,signal,sender){
  assert.ok(!busy.has(id),'same conversation must serialize');busy.add(id);active++;peak=Math.max(peak,active);const run={id:randomUUID(),status:'completed'};runs.push({id,text,ids,sender});
  try { await event('start',{run});signal?.throwIfAborted();await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});});
  const done={run,messages:[{role:'assistant',text:`回答 ${text}`,run}],failed:false};sessions.set(id,{...done,runs:[run],running:false});return done;} finally {active--;busy.delete(id);}
 }};
 const config={directory,concurrency:2,queueLimit:8,maxFileBytes:30*1024*1024,timeoutMs:10000,token:'t'.repeat(64),bots:[{botId:'bot',secret:'s'}],...overrides};const client=fakeClient();const clients=new Map([['bot',client],['other',fakeClient()]]);
 const options={config,store,api,clients,download:async()=>({name:'标书.xlsx',buffer:Buffer.from('file')}),log:{error(){},warn(){}}};let bridge=new WecomBridge(options);await bridge.start();bridge.authenticated('bot');bridge.authenticated('other');
 t.after(async()=>{await bridge.close();await fs.rm(directory,{recursive:true,force:true});});
 return {get bridge(){return bridge;},get store(){return options.store;},api,client,clients,runs,sessions,roles,get peak(){return peak;},setDelay(ms){delay=ms;},async restart(){await bridge.close();options.store=await new BridgeStore(directory).open();bridge=new WecomBridge(options);await bridge.start();bridge.authenticated('bot');bridge.authenticated('other');}};
}

test('simultaneous users execute concurrently, group members serialize into one session, bots isolate, duplicates persist',async t=>{
 const f=await setup(t);const same=message('a','first');await Promise.all([f.bridge.receive('bot',same),f.bridge.receive('bot',same),f.bridge.receive('bot',message('b','second'))]);await f.bridge.idle();assert.equal(f.runs.length,2);assert.equal(f.peak,2);assert.notEqual(f.runs[0].id,f.runs[1].id);
 await Promise.all([f.bridge.receive('bot',message('a','group one','g')),f.bridge.receive('bot',message('b','group two','g'))]);await f.bridge.idle();assert.equal(f.runs.at(-1).id,f.runs.at(-2).id);assert.equal(f.runs.at(-2).sender.userId,'a');assert.equal(f.runs.at(-1).sender.userId,'b');assert.equal(f.runs.at(-1).sender.chatId,'g');
 await f.bridge.receive('other',message('a','other bot','g'));await f.bridge.idle();assert.notEqual(f.runs.at(-1).id,f.runs.at(-2).id);
 await f.restart();await f.bridge.receive('bot',same);await f.bridge.idle();assert.equal(f.runs.length,5);
});
test('file-only uploads wait for the sender, bind to the next prompt, and clean inbox data',async t=>{
 const f=await setup(t);const file=message('a','','g');file.body.msgtype='file';file.body.file={url:'https://example.invalid/file'};await f.bridge.receive('bot',file);await f.bridge.idle();assert.equal(f.runs.length,0);assert.match(f.client.texts.at(-1),/已收到/);
 await f.bridge.receive('bot',message('b','别人的问题','g'));await f.bridge.idle();assert.equal(f.runs[0].ids.length,0);
 await f.bridge.receive('bot',message('a','填写刚才的标书','g'));await f.bridge.idle();assert.equal(f.runs.at(-1).ids.length,1);assert.equal((await fs.readdir(path.join(f.store.directory,'inbox'))).length,0);
});
test('multiple pending files require selection or explicit all; new conversation resets group mapping',async t=>{
 const f=await setup(t);for(let i=0;i<2;i++){const file=message('a','','g');file.body.msgtype='file';file.body.file={url:`https://example.invalid/${i}`};await f.bridge.receive('bot',file);await f.bridge.idle();}
 await f.bridge.receive('bot',message('a','填写标书','g'));await f.bridge.idle();assert.equal(f.runs.length,0);assert.match(f.client.texts.at(-1),/多份/);
 await f.bridge.receive('bot',message('a','处理全部附件','g'));await f.bridge.idle();assert.equal(f.runs[0].ids.length,2);
 await f.bridge.receive('bot',message('b','新建对话','g'));await f.bridge.idle();await f.bridge.receive('bot',message('a','新问题','g'));await f.bridge.idle();assert.notEqual(f.runs.at(-1).id,f.runs[0].id);
});
test('structured outputs send files even when answer omits names, retry only delivery after failure',async t=>{
 const f=await setup(t);let count=0;const original=f.api.run;f.api.run=async(id,text,ids,event,signal)=>{const done=await original(id,text,ids,event,signal);const file={id:randomUUID(),name:'filled.xlsx',bytes:9};await event('output',{file});done.messages.at(-1).outputs=[file];return done;};
 f.client.uploadMedia=async(buffer,options)=>{if(!count++)throw new Error('transient');f.client.files.push({buffer,options});return{media_id:'ok'};};
 await f.bridge.receive('bot',message());await f.bridge.idle();assert.equal(f.runs.length,1);const job=f.store.data.jobs.find(j=>j.state==='delivering');assert.ok(job);job.retryAt=0;f.bridge.pump();await f.bridge.idle();assert.equal(f.runs.length,1);assert.equal(f.client.files[0].options.filename,'filled.xlsx');assert.equal(f.client.texts.length,1);
});
test('queue bounds, interrupted execution is recovered without replay, and expired map is recreated',async t=>{
 const f=await setup(t,{concurrency:1,queueLimit:1});f.setDelay(100);
 await f.bridge.receive('bot',message('a','one'));await f.bridge.receive('bot',message('b','two'));await f.bridge.receive('bot',message('c','three'));await f.bridge.idle();assert.equal(f.runs.length,2);assert.ok(f.client.texts.some(text=>text.includes('排队')));
 const who=message('a','unknown');await f.bridge.receive('bot',who);for(let n=0;f.runs.length<3 && n<100;n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.runs.length,3);await f.restart();await f.bridge.idle();assert.equal(f.runs.length,3);assert.ok(f.client.texts.some(text=>/未完整完成|中断|上次/.test(text)));
 const oldId=f.runs[0].id;f.sessions.delete(oldId);await f.bridge.receive('bot',message('a','after deletion'));await f.bridge.idle();assert.notEqual(f.runs.at(-1).id,oldId);
});

test('queued staged attachments survive a restart without downloading expired URLs again',async t=>{
 const f=await setup(t);f.bridge.disconnected('bot');let downloads=0;f.bridge.download=async()=>{downloads++;return{name:'待填.xlsx',buffer:Buffer.from('staged')};};
 const file=message('a','填写此文件');file.body.quote={msgtype:'file',file:{url:'https://expired.example/file'}};
 await f.bridge.receive('bot',file);assert.equal(downloads,1);assert.equal(f.runs.length,0);
 await f.restart();await f.bridge.idle();assert.equal(downloads,1);assert.equal(f.runs.length,1);assert.equal(f.runs[0].ids.length,1);
});
test('restart resumes remaining output delivery without replaying the run or resending an acknowledged file',async t=>{
 const f=await setup(t);const original=f.api.run;const files=[{id:randomUUID(),name:'one.xlsx',bytes:9},{id:randomUUID(),name:'two.xlsx',bytes:9}];
 f.api.run=async(id,text,ids,event,signal)=>{const done=await original(id,text,ids,event,signal);for(const file of files)await event('output',{file});return done;};
 let secondFails=true;const delivered=[];
 f.client.uploadMedia=async(buffer,options)=>{if(options.filename==='two.xlsx'&&secondFails)throw new Error('network');delivered.push(options.filename);return{media_id:options.filename};};
 await f.bridge.receive('bot',message());await f.bridge.idle();assert.deepEqual(delivered,['one.xlsx']);
 const job=f.store.data.jobs.find(job=>job.state==='delivering');assert.ok(job);job.retryAt=0;await f.store.save();secondFails=false;
 await f.restart();await f.bridge.idle();assert.deepEqual(delivered,['one.xlsx','two.xlsx']);assert.equal(f.runs.length,1);assert.equal(f.client.texts.length,1);
});

import { WELCOME, welcome } from '../integrations/wecom-bridge/commands.mjs';
const keyOf = (user='u', chat, bot='bot') => JSON.stringify([bot,chat?'group':'single',chat??user]);
const until = async predicate => { const end=Date.now()+5000; while(!predicate()){if(Date.now()>end)throw new Error('wait timeout');await new Promise(r=>setTimeout(r,5));} };

test('welcome responds only to private enter-chat events, using the approved text without inference',async()=>{
 const replies=[];const client={async replyWelcome(frame,body){replies.push({frame,body});}};
 await welcome(client,{body:{chattype:'single'}});await welcome(client,{body:{chattype:'group'}});
 assert.equal(replies.length,1);assert.equal(replies[0].body.msgtype,'text');assert.equal(replies[0].body.text.content,WELCOME);
 assert.match(WELCOME,/Hi，我是 AI Patrick 🤖/);assert.match(WELCOME,/\/clear 清空当前对话，保留角色设置/);
});

test('role prefixes work after any turn; raw input replaces preferences, cancel and clear are distinct and isolated',async t=>{
 const f=await setup(t);await f.bridge.receive('bot',message('a','ordinary'));await f.bridge.idle();
 const frames=[];const reply=f.client.replyStream;f.client.replyStream=async(...args)=>{frames.push(args);return reply(...args);};
 await f.bridge.receive('bot',message('a','/role ignore this suffix'));await f.bridge.idle();
 assert.match(f.client.texts.at(-1),/销售产品助理/);assert.match(f.client.texts.at(-1),/技术支持助理/);assert.match(f.client.texts.at(-1),/日常工作助理/);assert.match(f.client.texts.at(-1),/未设置/);
 const style='  原文角色\n回答要简洁。\n\n保留这些换行。  ';
 await f.bridge.receive('bot',message('a',style));await f.bridge.idle();assert.equal(f.roles.get(keyOf('a')),style);assert.equal(f.runs.length,1);
 assert.ok(frames.every(args=>args[3]===true),'control messages have no thinking placeholder');
 await f.bridge.receive('bot',message('a','/roleanything'));await f.bridge.idle();assert.ok(f.client.texts.at(-1).includes(style));
 await f.bridge.receive('bot',message('a','取消'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('a')),style);assert.equal(f.client.texts.at(-1),'已取消，原角色与回答风格保持不变。');
 await f.bridge.receive('bot',message('b','/role'));await f.bridge.idle();assert.match(f.client.texts.at(-1),/未设置/);
 await f.bridge.receive('bot',message('b','其他角色'));await f.bridge.idle();
 await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();await f.bridge.receive('bot',message('a','清除'));await f.bridge.idle();
 assert.equal(f.client.texts.at(-1),'已清除自定义角色与回答风格，恢复默认设置。');assert.equal(f.roles.has(keyOf('a')),false);assert.equal(f.roles.get(keyOf('b')),'其他角色');
 await f.bridge.receive('bot',message('a','取消'));await f.bridge.idle();assert.equal(f.runs.at(-1).text,'取消','ordinary vocabulary is not globally reserved');
});

test('group role entry belongs to its initiator, permits takeover, persists across restart, and rejects attachments and blanks',async t=>{
 const f=await setup(t);await f.bridge.receive('bot',message('a','/role','g'));await f.bridge.idle();
 await f.bridge.receive('bot',message('b','这是一条普通问题','g'));await f.bridge.idle();assert.equal(f.runs.at(-1).text,'这是一条普通问题');assert.equal(f.roles.size,0);
 const file=message('a','','g');file.body.msgtype='file';file.body.file={url:'https://invalid.test/file'};
 await f.bridge.receive('bot',file);await f.bridge.idle();await f.bridge.receive('bot',message('a','  ','g'));await f.bridge.idle();assert.equal(f.roles.size,0);assert.match(f.client.texts.at(-1),/非空纯文本/);
 await f.restart();await f.bridge.receive('bot',message('a','群角色','g'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('a','g')),'群角色');
 await f.bridge.receive('bot',message('a','/role','g'));await f.bridge.idle();await f.bridge.receive('bot',message('b','/role suffix','g'));await f.bridge.idle();
 await f.bridge.receive('bot',message('a','清除','g'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('b','g')),'群角色');assert.equal(f.runs.at(-1).text,'清除');
 await f.bridge.receive('bot',message('b','清除','g'));await f.bridge.idle();assert.equal(f.roles.size,0);
 await f.bridge.receive('other',message('a','/role','g'));await f.bridge.idle();await f.bridge.receive('other',message('a','另一机器人风格','g'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('a','g','other')),'另一机器人风格');
});

test('clear bypasses busy capacity, cancels only its scope and old delivery, preserves roles and archived sessions',async t=>{
 const f=await setup(t,{concurrency:1,queueLimit:8});f.setDelay(500);
 f.roles.set(keyOf('a'),'保留角色');
 await f.bridge.receive('bot',message('a','old active'));await until(()=>f.runs.length===1);
 const oldId=f.runs[0].id;
 await f.bridge.receive('bot',message('a','old queued'));await f.bridge.receive('bot',message('b','other user'));
 const clear=message('a','/clear ignore all suffix');await f.bridge.receive('bot',clear);await f.bridge.idle();
 assert.ok(f.client.texts.includes('已清除当前的会话历史。'));assert.ok(!f.client.texts.some(text=>text.includes('回答 old')));assert.ok(f.client.texts.includes('回答 other user'));
 assert.ok(f.sessions.has(oldId));assert.equal(f.roles.get(keyOf('a')),'保留角色');assert.ok(!f.runs.some(run=>run.text==='old queued'));
 await f.bridge.receive('bot',message('a','new question'));await f.bridge.idle();assert.notEqual(f.runs.at(-1).id,oldId);
 const count=f.sessions.size;await f.restart();await f.bridge.receive('bot',clear);await f.bridge.idle();assert.equal(f.sessions.size,count,'duplicate clear never creates another conversation');
 await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();await f.bridge.receive('bot',message('a','/clear again'));await f.bridge.idle();await f.bridge.receive('bot',message('a','normal question'));await f.bridge.idle();assert.equal(f.runs.at(-1).text,'normal question');assert.equal(f.roles.get(keyOf('a')),'保留角色');
});

test('clear fences slow media receipt and removes pending attachment bindings without deleting the archive',async t=>{
 const f=await setup(t);const file=message('a','');file.body.msgtype='file';file.body.file={url:'https://test.invalid/file'};
 await f.bridge.receive('bot',file);await f.bridge.idle();const prior=f.store.data.conversations[keyOf('a')];assert.equal(prior.pending.a.files.length,1);
 await f.bridge.receive('bot',message('a','/clear'));await f.bridge.idle();await f.bridge.receive('bot',message('a','next'));await f.bridge.idle();assert.equal(f.runs.at(-1).ids.length,0);assert.ok(f.sessions.has(prior.sessionId));
 let release,started=false;f.bridge.download=async()=>{started=true;await new Promise(r=>release=r);return{name:'late.xlsx',buffer:Buffer.from('late')};};
 const slow=message('a','old file');slow.body.quote={msgtype:'file',file:{url:'https://test.invalid/late'}};
 const receiving=f.bridge.receive('bot',slow);await until(()=>started);
 await f.bridge.receive('bot',message('a','/clear'));await until(()=>f.client.texts.filter(text=>text==='已清除当前的会话历史。').length===2);
 release();await receiving;await f.bridge.idle();assert.ok(!f.runs.some(run=>run.text==='old file'));
});

test('role writes recover idempotently after lost responses and restart, with later questions behind the command',async t=>{
 const f=await setup(t);await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();
 const json=f.api.json;let fail=true;f.api.json=async(route,method,body,...rest)=>{const result=await json(route,method,body,...rest);if(method==='PUT'&&fail)throw new Error('response lost');return result;};
 const set=message('a','唯一角色');await f.bridge.receive('bot',set);await f.bridge.idle();assert.equal(f.roles.get(keyOf('a')),'唯一角色');
 await f.bridge.receive('bot',message('a','waiting question'));await f.bridge.idle();assert.equal(f.runs.length,0);
 await f.restart();fail=false;const job=f.store.data.jobs.find(job=>job.control?.kind==='set');job.retryAt=0;f.bridge.pump();await f.bridge.idle();
 assert.equal(f.runs.length,1);assert.equal(f.client.texts.filter(text=>text==='角色与回答风格已更新。').length,1);
 await f.bridge.receive('bot',set);await f.bridge.idle();assert.equal(f.client.texts.filter(text=>text==='角色与回答风格已更新。').length,1);
});

test('clear waits out in-flight media transport and fences old files before its acknowledgement',async t=>{
 const f=await setup(t);const run=f.api.run;const file={id:randomUUID(),name:'old.xlsx',bytes:9};
 f.api.run=async(...args)=>{const done=await run(...args);done.messages.at(-1).outputs=[file];return done;};
 let release,started=false,delivered=0;f.client.uploadMedia=async()=>{started=true;await new Promise(r=>release=r);return{media_id:'old'};};f.client.replyMedia=async()=>{delivered++;};f.client.sendMediaMessage=async()=>{delivered++;};
 await f.bridge.receive('bot',message('a','old output'));await until(()=>started);
 await f.bridge.receive('bot',message('a','/clear'));await new Promise(r=>setTimeout(r,20));assert.ok(!f.client.texts.includes('已清除当前的会话历史。'));
 release();await f.bridge.idle();assert.equal(delivered,0);assert.equal(f.client.texts.at(-1),'已清除当前的会话历史。');
});

test('rapid repeated clears carry the old session stop target through persisted command replacement',async t=>{
 const f=await setup(t);await f.bridge.receive('bot',message('a','old'));await f.bridge.idle();const old=f.runs[0].id;
 f.bridge.disconnected('bot');await f.bridge.receive('bot',message('a','/clear first'));await f.bridge.receive('bot',message('a','/clear second'));
 const stop=[];const json=f.api.json;f.api.json=async(route,...args)=>{if(route.endsWith('/stop'))stop.push(route);return json(route,...args);};
 await f.restart();await f.bridge.idle();assert.ok(stop.includes(`/sessions/${old}/stop`));assert.equal(f.client.texts.filter(text=>text==='已清除当前的会话历史。').length,1);
});

test('cancel exits role entry even when its backend preview is unavailable, without changing the saved role',async t=>{
 const f=await setup(t);f.roles.set(keyOf('a'),'原角色');const json=f.api.json;f.api.json=async(route,...args)=>{if(route.startsWith('/role?')&&(!args[0]||args[0]==='GET'))throw new Error('backend down');return json(route,...args);};
 await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();await f.bridge.receive('bot',message('a','取消'));await f.bridge.idle();
 assert.equal(f.client.texts.at(-1),'已取消，原角色与回答风格保持不变。');assert.equal(f.roles.get(keyOf('a')),'原角色');
 f.api.json=json;await f.bridge.receive('bot',message('a','normal'));await f.bridge.idle();assert.equal(f.runs.at(-1).text,'normal');assert.ok(!f.client.texts.some(text=>text.includes('当前角色与风格：')));
});

test('command prefixes in mixed messages take priority over attachments and never trigger downloads',async t=>{
 const f=await setup(t);let downloads=0;f.bridge.download=async()=>{downloads++;throw new Error('command must not download attachments');};
 const mixed=text=>{const frame=message('a','');frame.body.msgtype='mixed';frame.body.mixed={msg_item:[{msgtype:'text',text:{content:text}},{msgtype:'image',image:{url:'https://invalid.test/image'}}]};return frame;};
 await f.bridge.receive('bot',mixed('/role suffix'));await f.bridge.idle();await f.bridge.receive('bot',message('a','mixed command style'));await f.bridge.idle();
 await f.bridge.receive('bot',mixed('/clear suffix'));await f.bridge.idle();assert.equal(downloads,0);assert.equal(f.runs.length,0);assert.equal(f.roles.get(keyOf('a')),'mixed command style');assert.equal(f.client.texts.at(-1),'已清除当前的会话历史。');
});

test('hidden welcome prefix replies with the same text in private and group chats without Agent calls or sessions',async t=>{
 const f=await setup(t);const json=f.api.json,calls=[];f.api.json=async(route,...args)=>{if(route!=='/contacts')calls.push(route);return json(route,...args);};
 const frames=[];const reply=f.client.replyStream;f.client.replyStream=async(...args)=>{frames.push(args);return reply(...args);};
 const once=message('a','/welcome arbitrary suffix');await f.bridge.receive('bot',once);await f.bridge.idle();await f.bridge.receive('bot',once);await f.bridge.idle();
 await f.bridge.receive('bot',message('b','/welcomeanything','g'));await f.bridge.idle();
 assert.deepEqual(f.client.texts,[WELCOME,WELCOME]);assert.ok(!WELCOME.includes('/welcome'));assert.equal(f.runs.length,0);assert.equal(f.sessions.size,0);assert.deepEqual(calls,[]);assert.ok(frames.every(args=>args[3]===true));
});

test('welcome preserves the conversation, saved style, pending attachments and unfinished role entry',async t=>{
 const f=await setup(t);await f.bridge.receive('bot',message('a','existing conversation'));await f.bridge.idle();
 const file=message('a','');file.body.msgtype='file';file.body.file={url:'https://invalid.test/file'};await f.bridge.receive('bot',file);await f.bridge.idle();
 f.roles.set(keyOf('a'),'saved style');const before=structuredClone(f.store.data.conversations[keyOf('a')]);
 await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();const generation=f.store.data.scopes[keyOf('a')].generation;
 const mixed=message('a','');mixed.body.msgtype='mixed';mixed.body.mixed={msg_item:[{msgtype:'text',text:{content:'/welcome suffix'}},{msgtype:'image',image:{url:'https://invalid.test/must-not-download'}}]};
 f.bridge.download=async()=>{throw new Error('welcome must bypass attachments');};await f.bridge.receive('bot',mixed);await f.bridge.idle();
 assert.equal(f.client.texts.at(-1),WELCOME);assert.deepEqual(f.store.data.conversations[keyOf('a')],before);assert.equal(f.roles.get(keyOf('a')),'saved style');assert.equal(f.store.data.scopes[keyOf('a')].awaitingUser,'a');assert.equal(f.store.data.scopes[keyOf('a')].generation,generation);assert.equal(f.runs.length,1);
 await f.bridge.receive('bot',message('a','replacement style'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('a')),'replacement style');assert.equal(f.runs.length,1);
});

function commandApi(f, handler = async () => ({text:'文件\nhttps://files.example/sdk.zip'})) {
 const original = f.api.json; const calls=[];
 f.api.json=async(route,method,body,signal)=>{
  if (['/files','/balance'].includes(route)) {calls.push({route,method,body,signal});return handler(route,body,signal);}
  return original(route,method,body,signal);
 };
 return calls;
}

test('files requires the command first, ignores suffix, preserves raw next input and leaves model/session untouched',async t=>{
 const f=await setup(t);const calls=commandApi(f);
 assert.ok(WELCOME.includes('/files 获取相关资料，文件或者工具'));assert.ok(!WELCOME.includes('/patrick_balance'));
 await f.bridge.receive('bot',message('a','/files 给我 K388Pro 的 SDK'));await f.bridge.idle();
 assert.equal(calls.length,0);assert.match(f.client.texts.at(-1),/下一条需求/);
 const raw='  给我K388Pro的SDK\n保留这些空格。  ';const input=message('a',raw);
 await f.bridge.receive('bot',input);await f.bridge.receive('bot',input);await f.bridge.idle();
 assert.equal(calls.length,1);assert.equal(calls[0].route,'/files');assert.equal(calls[0].method,'POST');assert.deepEqual(calls[0].body,{prompt:raw});
 assert.equal(f.runs.length,0);assert.equal(f.sessions.size,0);assert.equal(f.client.files.length,0);
 assert.equal(f.store.data.scopes[keyOf('a')].awaitingUser,undefined);
 await f.bridge.receive('bot',message('a','ordinary'));await f.bridge.idle();assert.equal(f.runs.length,1);
});

test('files mode survives restart, validates pure text, cancels and never clears saved role',async t=>{
 const f=await setup(t);const calls=commandApi(f);f.roles.set(keyOf('a'),'销售');
 await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();await f.restart();
 let downloads=0;f.bridge.download=async()=>{downloads++;throw new Error('must not download');};
 for(const text of ['', 'x'.repeat(12001), 'bad\0input']) {await f.bridge.receive('bot',message('a',text));await f.bridge.idle();assert.match(f.client.texts.at(-1),/非空纯文本文件需求/);}
 const quote=message('a','query');quote.body.quote={msgtype:'file',file:{url:'https://files.example/x'}};
 const mixed=message('a','query');mixed.body.msgtype='mixed';mixed.body.mixed={msg_item:[{msgtype:'text',text:{content:'q'}},{msgtype:'file',file:{url:'https://files.example/x'}}]};
 for(const input of [quote,mixed]) {await f.bridge.receive('bot',input);await f.bridge.idle();assert.equal(f.store.data.scopes[keyOf('a')].awaitingMode,'files');}
 assert.equal(downloads,0);assert.equal(calls.length,0);
 await f.bridge.receive('bot',message('a','清除'));await f.bridge.idle();assert.equal(calls[0].body.prompt,'清除');assert.equal(f.roles.get(keyOf('a')),'销售');
 await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();await f.bridge.receive('bot',message('a','取消'));await f.bridge.idle();assert.equal(calls.length,1);assert.match(f.client.texts.at(-1),/已取消文件查询/);
});

test('files ownership is isolated by bot/private/group; mode switches supersede failed role previews',async t=>{
 const f=await setup(t);const calls=commandApi(f);
 await f.bridge.receive('bot',message('a','/files','g'));await f.bridge.idle();
 await f.bridge.receive('bot',message('b','ordinary','g'));await f.bridge.idle();assert.equal(f.runs.length,1);assert.equal(calls.length,0);
 await f.bridge.receive('other',message('a','ordinary','g'));await f.bridge.idle();
 await f.bridge.receive('bot',message('a','ordinary'));await f.bridge.idle();assert.equal(f.runs.length,3);
 await f.bridge.receive('bot',message('b','/files','g'));await f.bridge.idle();await f.bridge.receive('bot',message('b','group query','g'));await f.bridge.idle();assert.equal(calls[0].body.prompt,'group query');
 const original=f.api.json;
 f.api.json=async(route,...args)=>{if(route.startsWith('/role?'))throw new Error('preview offline');return original(route,...args);};
 await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();assert.ok(f.store.data.jobs.some(job=>job.control?.kind==='open'&&job.state==='command'));
 await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();assert.match(f.client.texts.at(-1),/下一条需求/);
 await f.bridge.receive('bot',message('a','query'));await f.bridge.idle();assert.equal(calls.length,2);
 f.api.json=original;await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();await f.bridge.receive('bot',message('a','/role'));await f.bridge.idle();await f.bridge.receive('bot',message('a','new role'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('a')),'new role');
});

test('hidden balance preserves pending modes/uploads and legacy role state; lookups fail once without model or retry loops',async t=>{
 const f=await setup(t);const calls=commandApi(f,async(route)=>{if(route==='/files')throw new ApiError(429,'请稍后重试');return{text:'CNY：12.34'};});
 await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();await f.bridge.receive('bot',message('a','/patrick_balance'));await f.bridge.idle();
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].body,undefined);assert.equal(f.store.data.scopes[keyOf('a')].awaitingMode,'files');
 await f.bridge.receive('bot',message('a','query'));await f.bridge.idle();assert.match(f.client.texts.at(-1),/查询未完成/);assert.ok(f.store.data.jobs.every(job=>job.state==='done'));assert.equal(calls.length,2);assert.equal(f.runs.length,0);
 f.store.data.scopes[keyOf('b')]={generation:0,awaitingUser:'b'};await f.store.save();await f.restart();
 await f.bridge.receive('bot',message('b','/patrick_balance'));await f.bridge.idle();await f.bridge.receive('bot',message('b','legacy role'));await f.bridge.idle();assert.equal(f.roles.get(keyOf('b')),'legacy role');
 const file=message('c','');file.body.msgtype='file';file.body.file={url:'https://files.example/pending'};await f.bridge.receive('bot',file);await f.bridge.idle();
 const pending=JSON.stringify(f.store.data.conversations[keyOf('c')].pending);
 await f.bridge.receive('bot',message('c','/patrick_balance'));await f.bridge.idle();assert.equal(JSON.stringify(f.store.data.conversations[keyOf('c')].pending),pending);
});

test('direct lookup result delivery survives restart without requery and reset cancels late results',async t=>{
 const f=await setup(t);const calls=commandApi(f);await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();
 const reply=f.client.replyStream;const send=f.client.sendMessage;
 f.client.replyStream=async(...args)=>{if(args[3])throw new Error('delivery offline');return reply(...args);};f.client.sendMessage=async()=>{throw new Error('delivery offline');};
 await f.bridge.receive('bot',message('a','SDK'));await f.bridge.idle();assert.equal(calls.length,1);
 const job=f.store.data.jobs.find(job=>job.state==='delivering');assert.ok(job);job.retryAt=0;await f.store.save();f.client.replyStream=reply;f.client.sendMessage=send;
 await f.restart();await f.bridge.idle();assert.equal(calls.length,1);assert.match(f.client.texts.at(-1),/sdk.zip/);
 let aborted=false;let started=false;
 f.api.json=async(route,method,body,signal)=>{if(route==='/files'){started=true;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true});});}if(route==='/sessions')return{id:randomUUID()};return{};};
 await f.bridge.receive('bot',message('a','/files'));await f.bridge.idle();await f.bridge.receive('bot',message('a','slow'));await until(()=>started);
 const before=f.client.texts.length;await f.bridge.receive('bot',message('a','/clear'));await f.bridge.idle();assert.equal(aborted,true);assert.deepEqual(f.client.texts.slice(before),['已清除当前的会话历史。']);assert.equal(f.store.data.scopes[keyOf('a')].awaitingMode,undefined);
});
