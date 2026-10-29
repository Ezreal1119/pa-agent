import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createFirmwareExtractor} from '../dist/firmware/matcher.js';
import {UsageLedger, meterSession, metered, usageScope, configureUsagePricing} from '../dist/usage/ledger.js';
import {CompletionJournal} from '../dist/sync-notifications/journal.js';
import {SyncNotifications, destinationKey, syncDestination, costText} from '../dist/sync-notifications/service.js';
import {SyncService} from '../dist/knowledge-sync/service.js';
import {AutoSync} from '../dist/knowledge-sync/auto-sync.js';
import {emptyUsage, hash, PlanError} from '../dist/knowledge-sync/core.js';
import {BridgeStore} from '../integrations/wecom-bridge/store.mjs';
import {SyncNotifier} from '../integrations/wecom-bridge/sync-notifications.mjs';
import {WecomBridge} from '../integrations/wecom-bridge/bridge.mjs';
import {AgentApi} from '../integrations/wecom-bridge/api.mjs';
import {createWebServer} from '../dist/web/server.js';

const model={modelId:'deepseek-flash',baseUrl:'https://api.deepseek.com'};
const destination={botId:'bot',recipient:'owner'};
const first='2026-10-28T10:00:00.000Z', second='2026-10-29T10:00:00.000Z', third='2026-10-29T12:00:00.000Z';
const roots=[]; after(async()=>{for(const root of roots)await fs.rm(root,{recursive:true,force:true});});
async function rootFor(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'sync-notify-'));roots.push(root);return root;}
async function coverage(root,since='2026-10-01T00:00:00.000Z'){const ledger=new UsageLedger(root);await ledger.init();await fs.writeFile(path.join(ledger.directory,'coverage.json'),JSON.stringify({version:1,since}));return ledger;}
async function charge(root,finished,amount,scope){const id=randomUUID();await fs.writeFile(path.join(root,'usage-ledger',id+'.json'),JSON.stringify({version:1,id,source:scope?'sync-text':'chat',scope:scope?{kind:'sync',id:scope}:undefined,model:'fixture',started:first,finished,tokens:{input:1,cacheRead:0,output:0},amount}));return id;}
function event(finished=second,extra={}){return {version:1,id:randomUUID(),origin:'manual',started:new Date(Date.parse(finished)-1000).toISOString(),finished,status:'completed',total:1,counts:{published:1},items:[{name:'test.md',status:'published',summary:'updated knowledge'}],scopes:[randomUUID()],jobIds:[randomUUID()],...extra};}
async function notifications(t,root,latest=first){let now=Date.parse(third);const service=new SyncNotifications({dataDir:root,destination,latest:()=>latest,reconcile:async()=>{},now:()=>now});await service.init();t.after(()=>service.close());return {service,advance:ms=>now+=ms,claim:()=>service.claim({...destination,consumer:randomUUID()})};}

test('SDK receipts count cache once, settle once and contain no prompts or API keys',async t=>{
 const root=await rootFor(t);await coverage(root);let calls=0;
 const session={agent:{streamFunction:async()=>{calls++;return {result:async()=>({usage:{input:100,cacheRead:40,cacheWrite:10,output:20},content:'PRIVATE ANSWER'})};}}};
 meterSession(session,root,'chat',model);
 const stream=await session.agent.streamFunction({}, {messages:'PRIVATE PROMPT'}, {apiKey:'PRIVATE KEY'});
 await Promise.all([stream.result(),stream.result()]);assert.equal(calls,1);
 const sum=await new UsageLedger(root).summary(first,'2099-01-01T00:00:00Z');
 assert.equal(sum.requests,1);assert.equal(sum.priced,1);assert.ok(Math.abs(sum.cny-(110*2+40*.04+20*8)/1e6)<1e-12);
 const files=await fs.readdir(path.join(root,'usage-ledger'));const raw=(await Promise.all(files.map(f=>fs.readFile(path.join(root,'usage-ledger',f),'utf8')))).join('');
 assert.ok(!raw.includes('PRIVATE'));assert.equal((await fs.stat(path.join(root,'usage-ledger',files.find(f=>f!=='coverage.json')))).mode&0o777,0o600);
});

test('raw and failed requests preserve unknown amounts instead of inventing zero; scope is isolated',async t=>{
 const root=await rootFor(t),ledger=await coverage(root);
 await usageScope({kind:'sync',id:'run-a'},()=>metered(root,'sync-vision',{modelId:'unknown',baseUrl:'https://vision.example'},async record=>{await record({prompt_tokens:100,completion_tokens:10});}));
 await assert.rejects(metered(root,'chat',model,async()=>{throw Error('provider failed');}));
 const sum=await ledger.summary(first,'2099-01-01T00:00:00Z');assert.equal(sum.requests,2);assert.equal(sum.unpriced,1);assert.equal(sum.missingUsage,1);assert.match(costText(sum),/已记录部分/);
 const own=await ledger.summary(first,'2099-01-01T00:00:00Z',['run-a']);assert.equal(own.requests,1);assert.equal(own.unpriced,1);
});

test('completion-to-completion periods cross midnight and use exclusive start/inclusive end',async t=>{
 const root=await rootFor(t),ledger=await coverage(root);
 await charge(root,first,99);await charge(root,'2026-10-28T23:59:59Z',1);await charge(root,'2026-10-29T00:00:00Z',2);await charge(root,second,3);await charge(root,third,4);
 assert.equal((await ledger.summary(first,second)).cny,6);assert.equal((await ledger.summary(second,third)).cny,4);
 const pending=await ledger.start('chat',model);const sum=await ledger.summary(first,'2099-01-01T00:00:00Z');assert.equal(sum.pending,1);await pending.finish();
 await fs.writeFile(path.join(ledger.directory,'coverage.json'),JSON.stringify({version:1,since:second}));assert.equal((await ledger.summary(first,third)).historyMissing,true);
});

test('notices freeze their cost periods, survive restart and ACK loss, and never replay history',async t=>{
 const root=await rootFor(t);await coverage(root);const journal=new CompletionJournal(root);await journal.record(event(first));
 const f=await notifications(t,root);assert.equal((await f.claim()).notice,null);
 const e=event(second);await charge(root,second,.4,e.scopes[0]);await journal.record(e);
 const a=(await f.claim()).notice;assert.ok(a);assert.match(a.text,/0.400000/);assert.match(a.text,/2026\/10\/28/);assert.match(a.text,/2026\/10\/29/);
 assert.equal((await f.claim()).notice,null);await charge(root,third,.2);
 await f.service.close();const again=new SyncNotifications({dataDir:root,destination,latest:()=>third,reconcile:async()=>{},now:()=>Date.parse(third)+61000});await again.init();t.after(()=>again.close());
 const b=(await again.claim({...destination,consumer:randomUUID()})).notice;assert.equal(b.id,a.id);assert.equal(b.text,a.text);assert.notEqual(b.claim,a.claim);
 assert.equal((await again.ack({id:a.id,claim:a.claim})).ok,false);assert.equal((await again.ack(b)).ok,true);
 const next=event(third);await journal.record(next);const c=(await again.claim({...destination,consumer:randomUUID()})).notice;assert.match(c.text,/0.200000/);assert.ok(!c.text.includes('0.600000'));
});

test('destination is the global private recipient and first bot; blank or changed profiles do not replay old data',async t=>{
 assert.equal(syncDestination({WECOM_ENABLED:'true',WECOM_BOT_ID:'b',WECOM_NOTIFY_USER_ID:''}),undefined);
 assert.deepEqual(syncDestination({WECOM_ENABLED:'true',WECOM_BOTS:'[{"botId":"first","notifyUserId":"wrong"},{"botId":"second"}]',WECOM_NOTIFY_USER_ID:'owner'}),{botId:'first',recipient:'owner'});
 const root=await rootFor(t);await coverage(root);const f=await notifications(t,root);await new CompletionJournal(root).record(event());await f.service.refresh();
 assert.equal((await f.service.claim({botId:'other',recipient:'owner',consumer:randomUUID()})).notice,null);
 assert.equal((await f.service.claim({botId:'bot',recipient:'group',consumer:randomUUID()})).notice,null);
 await f.service.close();const changed=new SyncNotifications({dataDir:root,destination:{botId:'bot',recipient:'new-owner'},latest:()=>second,reconcile:async()=>{}});await changed.init();t.after(()=>changed.close());
 assert.equal((await changed.claim({botId:'bot',recipient:'new-owner',consumer:randomUUID()})).notice,null);
});

async function syncFixture(t,count=1){
 const root=await rootFor(t);await coverage(root);
 const options={dataDir:root,maxBytes:1024*1024,timeoutMs:5000,modelId:()=>model.modelId,redact:e=>String(e.message),
 converter:()=>async source=>({markdown:await fs.readFile(source,'utf8'),sourceHash:hash(await fs.readFile(source)),coverage:[],visual:emptyUsage(),version:4}),
 planner:()=>async()=>{const r=await new UsageLedger(root).start('sync-text',model);await r.finish({input:100,cacheRead:0,cacheWrite:0,output:10},true);throw new PlanError(['Please review'],true);}};
 const sync=new SyncService(options);await sync.init();await fs.mkdir(sync.inbox,{recursive:true});for(let i=0;i<count;i++)await fs.writeFile(path.join(sync.inbox,`${i}.md`),'# Fixture');
 t.after(()=>sync.close());return {root,sync,options};
}

test('manual Sync and Re-Sync produce one immutable completion each with own usage scopes',async t=>{
 const f=await syncFixture(t);const journal=new CompletionJournal(f.root);
 const job=await f.sync.start((await f.sync.incoming()).map(x=>x.id));await f.sync.waitFor(job.id);
 const firstEvents=await journal.list();assert.equal(firstEvents.length,1);assert.equal(firstEvents[0].counts.needs_review,1);
 const report=await f.sync.get(job.id);await f.sync.resync(job.id,report.items[0].id,'Please retry');await f.sync.waitFor(job.id);
 const events=await journal.list();assert.equal(events.length,2);assert.notEqual(events[0].id,events[1].id);assert.deepEqual(events[0],firstEvents[0]);
 const sum=await new UsageLedger(f.root).summary('2000-01-01','2099-01-01',events[1].scopes);assert.equal(sum.requests,1);
});

test('automatic multi-batch Sync has one overall notification; empty/handled runs produce none',async t=>{
 const f=await syncFixture(t,51);const auto=new AutoSync(f.sync,()=>true,e=>String(e.message));await auto.init();t.after(()=>auto.close());
 await auto.trigger();await auto.wait();const events=await new CompletionJournal(f.root).list();assert.equal(events.length,1);assert.equal(events[0].origin,'auto');assert.equal(events[0].total,51);assert.equal(events[0].counts.needs_review,51);assert.equal(events[0].scopes.length,2);
 assert.equal((await new UsageLedger(f.root).summary('2000-01-01','2099-01-01',events[0].scopes)).requests,51);
 await auto.trigger();await auto.wait();assert.equal((await new CompletionJournal(f.root).list()).length,1);
});

test('interrupted new-version reports recover into one completion without replaying work',async t=>{
 const f=await syncFixture(t);await f.sync.close();
 const id=randomUUID(),scope=randomUUID();await fs.writeFile(path.join(f.sync.directory,'jobs',id+'.json'),JSON.stringify({id,kind:'sync',created:first,status:'running',execution:{id:scope,started:first,itemIds:['i']},items:[{id:'i',name:'0.md',sourceHash:'fixture',bytes:1,status:'converting',stage:'Converting',feedback:'',textUsage:emptyUsage(),visualUsage:emptyUsage()}]}));
 const recovered=new SyncService(f.options);await recovered.init();t.after(()=>recovered.close());const events=await new CompletionJournal(f.root).list();assert.equal(events.length,1);assert.equal(events[0].status,'interrupted');assert.equal(events[0].counts.interrupted,1);
 await recovered.reconcileCompletions();assert.equal((await new CompletionJournal(f.root).list()).length,1);
});

test('Bridge only sends to the primary private account, resumes saved chunks and does not resend after ACK loss',async t=>{
 const root=await rootFor(t),store=await new BridgeStore(path.join(root,'bridge')).open();t.after(()=>store.close());
 const notice={id:randomUUID(),claim:randomUUID(),destination:destinationKey(destination),text:'同步结束\n费用约 ¥0.123'};let acked=false,fail=true;const sent=[];
 const api={async json(route){if(route.endsWith('/claim'))return{notice:acked?null:notice};if(fail)throw Error('ACK lost');acked=true;return{ok:true};}};
 const clients=new Map([['bot',{async sendMessage(target,body){sent.push({target,body});}}],['other',{async sendMessage(){throw Error('wrong bot');}}]]);
 let connected=false;
 const make=()=>new SyncNotifier({store,api,clients,...destination,isConnected:id=>connected&&id==='bot',log:{warn(){}}}).start();
 let notifier=make();await notifier.pump();assert.equal(sent.length,0);connected=true;await notifier.pump();assert.equal(sent.length,1);assert.equal(sent[0].target,'owner');await notifier.close();
 fail=false;notifier=make();await notifier.active;await notifier.pump();assert.equal(sent.length,1);assert.equal(acked,true);await notifier.close();
 const blank=new SyncNotifier({store,api,clients,botId:'bot',recipient:'',isConnected:()=>true}).start();await blank.pump();assert.equal(sent.length,1);await blank.close();
});

test('real Web maintenance API -> completion journal -> Bridge private delivery uses no second bot or model query',async t=>{
 const root=await rootFor(t);const saved={};for(const [k,v]of Object.entries({WECOM_ENABLED:'true',WECOM_BOT_ID:'bot',WECOM_BOTS:'',WECOM_NOTIFY_USER_ID:'owner'})){saved[k]=process.env[k];process.env[k]=v;}t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const token='sync-test-token-'.repeat(4);
 const app=await createWebServer({cwd:root,dataDir:path.join(root,'.data'),resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'fixture-pass'},bridgeToken:token,model:{apiKey:'fixture',baseUrl:'https://model.example/v1',modelId:'fixture'},fileTools:{enabled:false},sync:{converter:()=>async source=>({markdown:'# Fixture',sourceHash:hash(await fs.readFile(source)),coverage:[],visual:emptyUsage(),version:4}),planner:()=>async()=>{throw new PlanError(['Review please'],true);}}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const auth=await(await fetch(base+'/api/auth/status')).json();const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':auth.token},body:JSON.stringify({account:'admin',password:'fixture-pass'})});
 const headers={Cookie:login.headers.get('set-cookie').split(';')[0],'X-Local-Token':auth.token,'Content-Type':'application/json'};
 const store=await new BridgeStore(path.join(root,'bridge')).open();const sent=[];const bridge=new WecomBridge({config:{bots:[{botId:'bot',secret:'fixture'}],notifyUserId:'owner',concurrency:2,queueLimit:5,timeoutMs:5000},store,api:new AgentApi(base,token,5000),clients:new Map([['bot',{async sendMessage(target,body){sent.push({target,body});},disconnect(){}}]]),log:{warn(){},error(){}}});
 t.after(async()=>{await bridge.close();await app.close();});await bridge.start();bridge.authenticated('bot');
 await fs.mkdir(path.join(root,'.data/urovo-product-expert/newly_added'),{recursive:true});await fs.writeFile(path.join(root,'.data/urovo-product-expert/newly_added/test.md'),'# Fixture');
 const incoming=await(await fetch(base+'/api/sync/incoming',{headers})).json();const response=await fetch(base+'/api/sync/jobs',{method:'POST',headers,body:JSON.stringify({ids:incoming.files.map(x=>x.id)})});assert.equal(response.status,202);const job=await response.json();
 const deadline=Date.now()+5000;while(true){const current=await(await fetch(base+'/api/sync/jobs/'+job.id,{headers})).json();if(current.finished)break;if(Date.now()>deadline)throw Error('Sync wait timeout');await new Promise(r=>setTimeout(r,10));}
 await bridge.syncNotifier.active;await bridge.syncNotifier.pump();assert.equal(sent.length,1);assert.equal(sent[0].target,'owner');assert.match(sent[0].body.markdown.content,/待处理 1/);assert.match(sent[0].body.markdown.content,/区间模型总消费/);
 await bridge.syncNotifier.pump();assert.equal(sent.length,1);
 assert.equal((await fetch(base+'/api/wecom/sync-notifications/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
});

test('corrupt notification state is preserved without stopping chat or Sync',async t=>{
 const root=await rootFor(t);await fs.mkdir(path.join(root,'sync-notifications'),{recursive:true});const file=path.join(root,'sync-notifications/state.json');await fs.writeFile(file,'{"version":99}');
 const n=new SyncNotifications({dataDir:root,destination,latest:()=>first,reconcile:async()=>{throw Error('should stay paused');}});await n.init();assert.equal((await n.claim({...destination,consumer:randomUUID()})).notice,null);assert.equal(await fs.readFile(file,'utf8'),'{"version":99}');await n.close();
});

test('requests completing after a Sync boundary are counted only in the next period',async t=>{
 const root=await rootFor(t),ledger=await coverage(root);await charge(root,new Date(Date.parse(second)+1).toISOString(),.8);
 assert.equal((await ledger.summary(first,second)).requests,0);assert.equal((await ledger.summary(second,third)).cny,.8);
});

test('a receipt settling after a frozen boundary is carried forward even in the same millisecond',async t=>{
 const root=await rootFor(t),ledger=await coverage(root);const r=await ledger.start('chat',model);
 const cut='2098-01-01T00:00:00.000Z';assert.equal((await ledger.summary(first,cut)).pending,1);
 await r.finish({input:100,cacheRead:0,cacheWrite:0,output:10},true);
 assert.equal((await ledger.summary(first,cut)).requests,0);assert.equal((await ledger.summary(cut,'2098-01-02T00:00:00.000Z')).priced,1);
});


test('real SDK streaming usage is durably metered before a model task returns',async t=>{
 const root=await rootFor(t);await coverage(root);const criteria={model:'SQ68MB',date:'260422',index:'01'};
 const server=createServer(async(req,res)=>{
  for await(const chunk of req){};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta,finish_reason=null,usage)=>res.write(`data: ${JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',created:1,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})}\n\n`);
  chunk({role:'assistant'});chunk({tool_calls:[{index:0,id:'extract',type:'function',function:{name:'extract_firmware_query',arguments:JSON.stringify(criteria)}}]});
  chunk({},'tool_calls',{prompt_tokens:120,completion_tokens:10,total_tokens:130,prompt_tokens_details:{cached_tokens:40}});res.end('data: [DONE]\n\n');
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 configureUsagePricing(root,JSON.stringify({version:'fixture-rates',modelId:'fixture',baseUrl,currency:'CNY',input:2,cacheRead:.04,output:8,search:.005,fetch:.005,source:'fixture'}));
 const extract=createFirmwareExtractor(()=>({apiKey:'PRIVATE KEY',baseUrl,modelId:'fixture',contextWindow:32000,maxTokens:2048}),path.join(root,'matching'),root);
 assert.deepEqual(await extract('帮我下载 SQ68MB 的 260422_01 固件',AbortSignal.timeout(5000)),criteria);
 const sum=await new UsageLedger(root).summary(first,'2099-01-01');assert.equal(sum.requests,1);assert.equal(sum.priced,1);assert.ok(sum.cny>0);
});
