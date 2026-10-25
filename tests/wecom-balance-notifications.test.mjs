import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BalanceNotifier, BALANCE_HOURS, balanceSlot} from '../integrations/wecom-bridge/balance-notifications.mjs';
import {BridgeStore} from '../integrations/wecom-bridge/store.mjs';
import {WecomBridge} from '../integrations/wecom-bridge/bridge.mjs';
import {bridgeConfig} from '../integrations/wecom-bridge/config.mjs';

const at=(hour,minute=0,day=25)=>Date.parse(`2026-10-${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+08:00`);
async function setup(t,overrides={}) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-balance-'));let store=await new BridgeStore(directory).open();
 let now=at(9,59),connected=true;const sent=[],queries=[],warnings=[];
 const api={async json(...args){queries.push(args);return {text:'DeepSeek 账户余额\nCNY：12.34\n赠送余额：0.00\n充值余额：12.34'};}};
 const clients=new Map([['bot',{async sendMessage(target,body){sent.push({bot:'bot',target,body});}}],['other',{async sendMessage(target,body){sent.push({bot:'other',target,body});}}]]);
 const options={store,api,clients,botId:'bot',recipient:'owner',isConnected:()=>connected,log:{warn(text){warnings.push(text);}},now:()=>now,...overrides};
 let notifier=new BalanceNotifier(options).start();
 t.after(async()=>{await notifier.close();await store.close();await fs.rm(directory,{recursive:true,force:true});});
 return {get notifier(){return notifier;},get store(){return store;},options,api,sent,queries,warnings,setTime(value){now=value;},connect(value){connected=value;},async restart(){await notifier.close();await store.close();store=await new BridgeStore(directory).open();options.store=store;notifier=new BalanceNotifier(options).start();await notifier.active;}};
}

test('Beijing schedule has exactly the nine requested hours, only minute zero, with correct UTC/date boundaries',()=>{
 assert.deepEqual(BALANCE_HOURS,[10,11,12,15,16,17,18,20,22]);
 for(let hour=0;hour<24;hour++){
  assert.equal(Boolean(balanceSlot(at(hour))),BALANCE_HOURS.includes(hour),`Beijing ${hour}`);
  assert.equal(balanceSlot(at(hour,1)),undefined);assert.equal(balanceSlot(at(hour,59)),undefined);
 }
 assert.equal(balanceSlot(Date.parse('2026-10-25T02:00:59.999Z')),'2026-10-25T10');
 assert.equal(balanceSlot(Date.parse('2026-10-25T14:00:00Z')),'2026-10-25T22');
 assert.equal(balanceSlot(Date.parse('2026-10-25T16:00:00Z')),undefined);
 assert.equal(balanceSlot(NaN),undefined);
});

test('each daily slot sends once only to the configured user, shares the balance API and never invokes a model',async t=>{
 const f=await setup(t);
 for(const hour of BALANCE_HOURS){f.setTime(at(hour));await Promise.all([f.notifier.pump(),f.notifier.pump(),f.notifier.pump()]);}
 assert.equal(f.sent.length,9);assert.equal(f.queries.length,9);
 assert.ok(f.sent.every(entry=>entry.bot==='bot'&&entry.target==='owner'&&entry.body.msgtype==='markdown'&&entry.body.markdown.content.includes('CNY：12.34')));
 assert.ok(f.queries.every(([route,method,body,signal])=>route==='/balance'&&method==='GET'&&body===undefined&&signal instanceof AbortSignal));
 assert.match(f.sent.at(-1).body.markdown.content,/北京时间 2026-10-25 22:00/);
 assert.equal(f.store.data.balanceSchedule.status,'sent');assert.equal(JSON.stringify(f.store.data).includes('12.34'),false);
 f.setTime(at(10,0,26));await f.notifier.pump();assert.equal(f.sent.length,10);
});

test('blank/invalid global recipients never fall back to other bots or saved recipients',async t=>{
 for(const recipient of ['',undefined,'bad recipient','bad\0id']){
  const f=await setup(t,{recipient});f.store.data.balanceSchedule={lastSlot:'2026-10-24T22',status:'sent',recipient:'someone-else'};
  f.setTime(at(10));await f.notifier.pump();assert.equal(f.queries.length,0);assert.equal(f.sent.length,0);
 }
 const config=bridgeConfig({WECOM_ENABLED:'true',WECOM_BOTS:'[{"botId":"bot","secret":"s","notifyUserId":"someone-else"}]',WECOM_NOTIFY_USER_ID:''},'/tmp');
 assert.equal(config.balanceNotifications,false);assert.equal(config.notifyUserId,'');
 const enabled=bridgeConfig({...{WECOM_ENABLED:'true',WECOM_BOT_ID:'bot',WECOM_BOT_SECRET:'s'},WECOM_NOTIFY_USER_ID:'owner'},'/tmp');assert.equal(enabled.balanceNotifications,true);
});

test('checkpoint survives restarts and clock rollback; changing recipient does not replay a previous slot',async t=>{
 const f=await setup(t);f.setTime(at(10));await f.notifier.pump();await f.restart();await f.notifier.pump();assert.equal(f.sent.length,1);
 const stat=await fs.stat(f.store.file);assert.equal(stat.mode&0o777,0o600);
 const saved=JSON.parse(await fs.readFile(f.store.file,'utf8'));assert.deepEqual(saved.balanceSchedule,{lastSlot:'2026-10-25T10',status:'sent'});
 f.options.recipient='new-owner';await f.restart();assert.equal(f.sent.length,1);
 f.setTime(at(11));await f.notifier.pump();assert.equal(f.sent.at(-1).target,'new-owner');
 f.setTime(at(10));await f.notifier.pump();assert.equal(f.sent.length,2);
});

test('missed/offline slots are not caught up or rerouted; only a connected primary bot can send',async t=>{
 const f=await setup(t);f.connect(false);f.setTime(at(10));await f.notifier.pump();assert.equal(f.queries.length,0);
 f.connect(true);f.setTime(at(10,1));await f.notifier.pump();assert.equal(f.sent.length,0);
 f.setTime(at(11));await f.notifier.pump();assert.equal(f.sent.length,1);assert.equal(f.sent[0].bot,'bot');
 f.connect(false);f.setTime(at(12));await f.restart();await f.notifier.pump();assert.equal(f.sent.length,1);
 f.connect(true);f.setTime(at(15));await f.notifier.pump();assert.equal(f.sent.length,2);
});

test('query failures send an honest notice once; uncertain send failures are not automatically repeated',async t=>{
 const f=await setup(t);f.api.json=async(...args)=>{f.queries.push(args);throw new Error('private-key provider details');};
 f.setTime(at(10));await f.notifier.pump();await f.notifier.pump();assert.equal(f.queries.length,1);assert.equal(f.sent.length,1);assert.match(f.sent[0].body.markdown.content,/本次余额查询未完成/);
 assert.ok(!JSON.stringify([...f.sent,...f.warnings]).includes('private-key'));
 f.options.clients.get('bot').sendMessage=async(target,body)=>{f.sent.push({target,body});throw new Error('may already have been received');};
 f.setTime(at(11));await f.notifier.pump();assert.equal(f.store.data.balanceSchedule.status,'failed');await f.restart();await f.notifier.pump();assert.equal(f.sent.length,2);assert.equal(f.queries.length,2);
});

test('invalid checkpoints fail closed without resetting chat state or consulting saved destinations',async t=>{
 const f=await setup(t);f.store.data.conversations.existing={sessionId:'unchanged'};
 f.store.data.balanceSchedule={lastSlot:'corrupt',status:'sent',recipient:'other-person'};await f.store.save();await f.restart();f.setTime(at(10));await f.notifier.pump();
 assert.equal(f.sent.length,0);assert.equal(f.queries.length,0);assert.deepEqual(f.store.data.conversations.existing,{sessionId:'unchanged'});assert.ok(f.warnings.some(s=>s.includes('disabled')));
});

test('claim is persisted before query, failed persistence cannot send, and crash after claim is not replayed',async t=>{
 const f=await setup(t);f.api.json=async()=>{
  const disk=JSON.parse(await fs.readFile(f.store.file,'utf8'));assert.deepEqual(disk.balanceSchedule,{lastSlot:'2026-10-25T10',status:'claimed'});throw new Error('query failed');
 };
 f.setTime(at(10));await f.notifier.pump();
 f.store.data.balanceSchedule={lastSlot:'2026-10-25T11',status:'claimed'};await f.store.save();f.setTime(at(11));await f.restart();await f.notifier.pump();assert.equal(f.sent.length,1);
 const original=f.store.save.bind(f.store);f.store.save=async()=>{throw new Error('disk full');};f.setTime(at(12));await f.notifier.pump();assert.equal(f.sent.length,1);f.store.save=original;
});

test('shutdown and disconnection after lookup prevent late sends; shutdown aborts the outstanding request',async t=>{
 const f=await setup(t);let started=false,aborted=false;
 f.api.json=async(_route,_method,_body,signal)=>{started=true;return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});};
 f.setTime(at(10));const pending=f.notifier.pump();while(!started)await new Promise(r=>setTimeout(r,1));await f.notifier.close();await pending;assert.equal(aborted,true);assert.equal(f.sent.length,0);
 await f.restart();f.api.json=async()=>{f.connect(false);return{text:'CNY：1.00'};};f.setTime(at(11));f.connect(true);await f.notifier.pump();assert.equal(f.sent.length,0);assert.equal(f.store.data.balanceSchedule.status,'skipped');
});

test('Bridge enables the schedule from global config only, sends from first bot and shuts it down independently of chat',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-balance-bridge-'));const store=await new BridgeStore(directory).open();let now=at(9,59);const sent=[];
 const config=bridgeConfig({WECOM_ENABLED:'true',WECOM_BOTS:'[{"botId":"first","secret":"s","notifyUserId":"someone-else"},{"botId":"second","secret":"s","notifyUserId":"wrong-person"}]',WECOM_NOTIFY_USER_ID:'owner'},directory);
 let queries=0;const api={async json(route){assert.equal(route,'/balance');queries++;return{text:'CNY：5.00'};}};
 const clients=new Map(['first','second'].map(bot=>[bot,{disconnect(){},async sendMessage(target,body){sent.push({bot,target,body});}}]));
 const bridge=new WecomBridge({config,store,api,clients,balanceNow:()=>now,log:{warn(){},error(){}}});await bridge.start();
 t.after(async()=>{await bridge.close();await fs.rm(directory,{recursive:true,force:true});});
 bridge.authenticated('second');now=at(10);await bridge.balanceNotifier.pump();assert.equal(queries,0);
 bridge.authenticated('first');await bridge.balanceNotifier.active;assert.equal(queries,1);assert.equal(sent.length,1);assert.equal(sent[0].bot,'first');assert.equal(sent[0].target,'owner');assert.deepEqual(store.data.jobs,[]);assert.deepEqual(store.data.conversations,{});
 await bridge.close();now=at(11);await bridge.balanceNotifier.pump();assert.equal(sent.length,1);
});
