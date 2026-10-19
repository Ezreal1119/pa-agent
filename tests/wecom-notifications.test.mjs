import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MessageObserver,notificationText} from '../integrations/wecom-bridge/notifications.mjs';
import {bridgeConfig} from '../integrations/wecom-bridge/config.mjs';
import {WecomContacts} from '../dist/web/wecom-contacts.js';
import {WecomBridge} from '../integrations/wecom-bridge/bridge.mjs';
import {BridgeStore} from '../integrations/wecom-bridge/store.mjs';

function who(userId='user',type='single',botId='bot',msgid=randomUUID()){return{botId,userId,msgid,key:JSON.stringify([botId,type,type==='group'?'group-id':userId])};}
async function setup(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-notices-'));const contacts=new WecomContacts(path.join(directory,'data'));let now=Date.now(),connected=true,alias='',fail=false;const messages=[],seen=[];
 const api={async json(_route,_method,body){seen.push(body);return{contact:{...body,name:alias}};}};
 const client={async sendMessage(target,body){if(fail)throw new Error('delivery error');messages.push({target,text:body.markdown.content});}};
 const options={directory,api,clients:new Map([['bot',client],['bot2',client]]),isConnected:()=>connected,recipientFor:()=> 'owner',log:{warn(){}},now:()=>now};let observer=await new MessageObserver(options).open();
 t.after(async()=>{await observer.close();await fs.rm(directory,{recursive:true,force:true});});
 return{directory,contacts,messages,seen,options,get observer(){return observer;},setAlias(value){alias=value;},setFail(value){fail=value;},advance(ms){now+=ms;},connect(value){connected=value;},async restart(){await observer.close();observer=await new MessageObserver(options).open();}};
}

test('private and group messages use the same sender alias, exclude owner everywhere, and never include a session title',async t=>{
 const f=await setup(t);f.setAlias('赵芮同');
 await f.observer.enqueue(who('owner'),{text:'我的私聊',attachments:[]});await f.observer.enqueue(who('owner','group'),{text:'我的群聊',attachments:[]});
 await f.observer.enqueue(who('person'),{text:'产品问题',attachments:[]});await f.observer.enqueue(who('person','group'),{text:'群里追问',attachments:[]});await f.observer.idle();
 assert.equal(f.messages.length,2);assert.ok(f.messages.every(m=>m.target==='owner'&&m.text.includes('对话人：赵芮同')));assert.ok(f.messages[1].text.includes('群聊：group-id'));assert.ok(!f.messages[0].text.includes('会话：'));assert.ok(!f.messages.some(m=>m.text.includes('我的')));assert.equal(f.seen.length,4);
 assert.ok(f.seen.every(body=>!('text'in body)),'prompt must not enter contacts API');
});
test('dedup survives restart, recipient changes do not leak pending messages, and a cleared alias falls back to User ID',async t=>{
 const f=await setup(t);const sender=who('person');await f.observer.enqueue(sender,{text:'一次',attachments:[]});await f.observer.idle();await f.restart();await f.observer.enqueue(sender,{text:'重复',attachments:[]});await f.observer.idle();assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/对话人：person/);
 f.connect(false);await f.observer.enqueue(who('later'),{text:'原收件人私有消息',attachments:[]});f.options.recipientFor=()=> 'new-owner';await f.restart();f.connect(true);f.observer.pump();await f.observer.idle();assert.equal(f.messages.length,1);
 const saved=JSON.parse(await fs.readFile(path.join(f.directory,'message-events.json'),'utf8'));assert.ok(saved.entries.every(e=>!e.text&&!e.parts));
});
test('failed notifications retry independently with latest alias; file names and escaped text are forwarded without bytes or tool results',async t=>{
 const f=await setup(t);f.setFail(true);const sender=who('person');await f.observer.enqueue(sender,{text:'<@all> **question**',attachments:['文件']});await f.observer.attachments('bot',sender.msgid,['标书.xlsx']);await f.observer.idle();assert.equal(f.messages.length,0);
 f.setFail(false);f.setAlias('新备注');f.advance(6000);f.observer.pump();await f.observer.idle();assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/标书.xlsx/);assert.ok(!f.messages[0].text.includes('<@all>'));
 // Name is read before each first successful text delivery; replace unsent rendering on retry.
 assert.match(f.messages[0].text,/对话人：新备注/);
});
test('notification text uses Beijing time and Unicode byte limits, and notification config supports per-bot overrides',async t=>{
 const f=await setup(t);await f.observer.enqueue(who(),{text:'中😀'.repeat(2500),attachments:[]});await f.observer.idle();assert.ok(f.messages.every(m=>Buffer.byteLength(m.text)<=18000));
 const text=notificationText({userId:'u',chatType:'single',at:Date.UTC(2026,9,18,16,15),text:'x'},'名字');assert.match(text,/10\/19 00:15/);
 const config=bridgeConfig({WECOM_ENABLED:'true',WECOM_BOT_ID:'bot',WECOM_BOT_SECRET:'secret',WECOM_NOTIFY_USER_ID:'owner'},'/tmp');assert.equal(config.notifyUserId,'owner');
 assert.throws(()=>bridgeConfig({WECOM_ENABLED:'true',WECOM_BOTS:'[{"botId":"a","secret":"s","notifyUserId":123}]'},'/tmp'),/notifyUserId/);
});
test('contacts import old single/group identities, persist aliases across sessions/restarts, serialize updates and protect write boundaries',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-contacts-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'wecom');await fs.mkdir(dir);const at=Date.now();const key=JSON.stringify(['bot','single','u']);const group=JSON.stringify(['bot','group','g']);
 await fs.writeFile(path.join(dir,'bridge-state.json'),JSON.stringify({conversations:{[key]:{sessionId:'old',updated:at}},jobs:[{key:group,botId:'bot',userId:'u',created:at},{key:group,botId:'bot',userId:'other',created:at}]}));
 const store=new WecomContacts(root);let rows=await store.list();assert.equal(rows.length,2);const u=rows.find(c=>c.userId==='u');assert.deepEqual(u.types,['single','group']);assert.deepEqual(u.groups,['g']);
 await Promise.all([store.rename(u.id,{name:'赵芮同'}),store.record({botId:'bot',userId:'u',chatType:'group',chatId:'g2',at:at+1})]);rows=await new WecomContacts(root).list();assert.equal(rows.find(c=>c.id===u.id).name,'赵芮同');
 await fs.unlink(path.join(dir,'bridge-state.json'));assert.equal((await store.list()).find(c=>c.id===u.id).name,'赵芮同');
 await store.rename(u.id,{name:''});assert.equal((await store.list()).find(c=>c.id===u.id).name,'');
 assert.throws(()=>store.rename(u.id,{name:'x\nwrong'}),/Display names/);assert.throws(()=>store.record({botId:'bot',userId:'u',chatType:'single',at,name:'untrusted'}),/Invalid/);
 assert.equal((await fs.stat(path.join(dir,'contacts.json'))).mode&0o777,0o600);
 await fs.rename(path.join(dir,'contacts.json'),path.join(dir,'original.json'));await fs.symlink(path.join(dir,'original.json'),path.join(dir,'contacts.json'));await assert.rejects(store.list(),/regular file/);
});
test('slow notification transport never blocks a user run or consumes an Agent slot',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-unblocked-'));const store=await new BridgeStore(directory).open();let finish,ran=0;
 const api={async json(route,_method,body){if(route==='/contacts')return{contact:{name:'备注'}};if(route==='/sessions')return{id:'session'};return{};},async run(_id,_text,_files,event){ran++;await event('start',{run:{id:'run'}});return{messages:[{role:'assistant',text:'正常回答',run:{id:'run'}}]};}};
 const client={replyStream:async()=>{},sendMessage:()=>new Promise(resolve=>{finish=resolve;}),disconnect(){finish?.();}};
 const bridge=new WecomBridge({store,api,clients:new Map([['bot',client]]),config:{concurrency:1,queueLimit:8,timeoutMs:10000,notifyUserId:'owner',bots:[{botId:'bot',secret:'s'}]},log:{warn(){},error(){}}});await bridge.start();bridge.authenticated('bot');
 t.after(async()=>{finish?.();await bridge.close();await fs.rm(directory,{recursive:true,force:true});});
 await bridge.receive('bot',{headers:{req_id:'req'},body:{msgid:'msg',from:{userid:'other'},chattype:'single',msgtype:'text',text:{content:'问题'}}});await bridge.idle();assert.equal(ran,1);assert.equal(store.data.jobs[0].state,'done');finish?.();
});

test('partial long-notification delivery resumes after restart without resending acknowledged chunks',async t=>{
 const f=await setup(t);let calls=0,failSecond=true;
 f.options.clients.get('bot').sendMessage=async(target,body)=>{calls++;if(calls===2&&failSecond)throw new Error('lost connection');f.messages.push({target,text:body.markdown.content});};
 await f.observer.enqueue(who(),{text:'中文字'.repeat(3500),attachments:[]});await f.observer.idle();assert.equal(f.messages.length,1);assert.equal(f.observer.entries[0].sent,1);
 failSecond=false;f.advance(6000);await f.restart();await f.observer.idle();assert.equal(f.messages.length,2);assert.equal(new Set(f.messages.map(m=>m.text)).size,2);assert.ok(f.observer.entries[0].done);
});
