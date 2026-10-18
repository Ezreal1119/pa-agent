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
 const sessions=new Map(),runs=[];let delay=15,active=0,peak=0;const busy=new Set();
 const api={async json(route,method='GET',body){
  if(route==='/status')return{fileTools:{enabled:true,tools:['excel_read'],maxFileBytes:30*1024*1024}};
  if(route==='/sessions'){const id=randomUUID();sessions.set(id,{id,runs:[],messages:[]});return{id};}
  const id=route.split('/')[2];if(!sessions.has(id))throw new ApiError(404,'missing');if(method==='PATCH')return{};return sessions.get(id);
 },async upload(id,name,buffer){const file={id:randomUUID(),name,bytes:buffer.length};return file;},async download(){return Buffer.from('generated');},async run(id,text,ids,event,signal){
  assert.ok(!busy.has(id),'same conversation must serialize');busy.add(id);active++;peak=Math.max(peak,active);const run={id:randomUUID(),status:'completed'};runs.push({id,text,ids});
  await event('start',{run});signal?.throwIfAborted();await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});});
  const done={run,messages:[{role:'assistant',text:`回答 ${text}`,run}],failed:false};sessions.set(id,{...done,runs:[run],running:false});active--;busy.delete(id);return done;
 }};
 const config={directory,concurrency:2,queueLimit:8,maxFileBytes:30*1024*1024,timeoutMs:10000,token:'t'.repeat(64),bots:[{botId:'bot',secret:'s'}],...overrides};const client=fakeClient();const clients=new Map([['bot',client],['other',fakeClient()]]);
 const options={config,store,api,clients,download:async()=>({name:'标书.xlsx',buffer:Buffer.from('file')}),log:{error(){},warn(){}}};let bridge=new WecomBridge(options);await bridge.start();bridge.authenticated('bot');bridge.authenticated('other');
 t.after(async()=>{await bridge.close();await fs.rm(directory,{recursive:true,force:true});});
 return {get bridge(){return bridge;},get store(){return options.store;},api,client,clients,runs,sessions,get peak(){return peak;},setDelay(ms){delay=ms;},async restart(){await bridge.close();options.store=await new BridgeStore(directory).open();bridge=new WecomBridge(options);await bridge.start();bridge.authenticated('bot');bridge.authenticated('other');}};
}

test('simultaneous users execute concurrently, group members serialize into one session, bots isolate, duplicates persist',async t=>{
 const f=await setup(t);const same=message('a','first');await Promise.all([f.bridge.receive('bot',same),f.bridge.receive('bot',same),f.bridge.receive('bot',message('b','second'))]);await f.bridge.idle();assert.equal(f.runs.length,2);assert.equal(f.peak,2);assert.notEqual(f.runs[0].id,f.runs[1].id);
 await Promise.all([f.bridge.receive('bot',message('a','group one','g')),f.bridge.receive('bot',message('b','group two','g'))]);await f.bridge.idle();assert.equal(f.runs.at(-1).id,f.runs.at(-2).id);
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
 await f.bridge.receive('bot',message());await new Promise(r=>setTimeout(r,100));assert.equal(f.runs.length,1);const job=f.store.data.jobs.find(j=>j.state==='delivering');assert.ok(job);job.retryAt=0;f.bridge.pump();await f.bridge.idle();assert.equal(f.runs.length,1);assert.equal(f.client.files[0].options.filename,'filled.xlsx');assert.equal(f.client.texts.length,1);
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
 await f.bridge.receive('bot',message());await new Promise(r=>setTimeout(r,100));assert.deepEqual(delivered,['one.xlsx']);
 const job=f.store.data.jobs.find(job=>job.state==='delivering');assert.ok(job);job.retryAt=0;await f.store.save();secondFails=false;
 await f.restart();await f.bridge.idle();assert.deepEqual(delivered,['one.xlsx','two.xlsx']);assert.equal(f.runs.length,1);assert.equal(f.client.texts.length,1);
});
