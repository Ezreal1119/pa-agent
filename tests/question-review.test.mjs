import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {readCases} from '../dist/question-review/source.js';
import {scrub,safeCandidate} from '../dist/question-review/privacy.js';
import {defaults,publicRun} from '../dist/question-review/types.js';
import {ReviewStore,write} from '../dist/question-review/store.js';
import {ReviewKnowledge} from '../dist/question-review/knowledge.js';
import {executeReview} from '../dist/question-review/engine.js';
import {QuestionReviewService} from '../dist/question-review/service.js';
import {requestReview} from '../dist/question-review/transport.js';
import {nextDue,previousDayRange} from '../dist/question-review/schedule.js';
import {createWebServer} from '../dist/web/server.js';

const resourcesDir=path.resolve('resources');
const from='2026-11-02T00:00:00.000Z',to='2026-11-04T00:00:00.000Z';
const stamp='2026-11-03T08:00:00.000Z';
const question={category:'knowledge_gap',question:'DT50 终端在 Android 13 下接入 USB 外设时有哪些兼容性限制？',products:['DT50'],versions:['Android 13'],explanation:'不同系统版本的外设兼容条件缺少完整说明，需要补充适用范围。',evidence:'记录中的回复未提供充分的兼容性依据，资料范围有限，需人工核实。',cases:['case-1']};
const model={apiKey:'fake-review-model-key',modelId:'fixture',baseUrl:'http://127.0.0.1:1/v1',contextWindow:128000,maxTokens:4096};
async function root(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'question-review-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));await fs.mkdir(path.join(p,'sessions'));await fs.mkdir(path.join(p,'urovo-product-expert/product-knowledge-vault/products'),{recursive:true});await fs.writeFile(path.join(p,'urovo-product-expert/product-knowledge-vault/products/DT50.md'),'# DT50\nUSB 兼容要求需根据系统版本确认。');return p;}
async function log(dataDir,{name='conversation.jsonl',questions=['DT50 Android 13 能连读卡器吗？'],status='completed',answer='目前的资料无法确定读卡器连接条件，需要进一步确认。',timestamp=stamp,tools=true}={}){
 const entries=[{type:'session',version:3,id:randomUUID(),timestamp,cwd:'/private/user/workspace'}];let parentId;
 const push=(type,fields)=>{const e={type,id:randomUUID(),parentId,timestamp,...fields};entries.push(e);parentId=e.id;return e;};
 for(let i=0;i<questions.length;i++){
  push('message',{message:{role:'user',content:[{type:'text',text:questions[i]}],timestamp:Date.parse(timestamp)}});
  if(tools){push('message',{message:{role:'assistant',content:[{type:'toolCall',id:randomUUID(),name:'read',arguments:{path:'urovo-product-expert/product-knowledge-vault/products/DT50.md'}}]}});push('message',{message:{role:'toolResult',toolCallId:randomUUID(),content:[{type:'text',text:'DT50 外设兼容需要按系统版本核对。'}]}});}
  push('message',{message:{role:'assistant',content:[{type:'thinking',thinking:'private chain of thought must not be included'},{type:'text',text:answer}],stopReason:'stop'}});
  push('custom',{customType:'web-run-metrics-v1',data:{id:randomUUID(),sequence:i+1,round:i+1,startedAt:timestamp,finishedAt:timestamp,status,wecom:{userId:'private-sender-identifier',target:'private-group-identifier',botId:'private-bot-identifier'}}});
 }
 const file=path.join(dataDir,'sessions',name);await fs.writeFile(file,entries.map(x=>JSON.stringify(x)).join('\n')+'\n');return {file,entries};
}
function run(extra={}){return {version:1,id:randomUUID(),requestId:randomUUID(),from,to,createdAt:stamp,status:'running',settings:{...defaults},modelId:'fixture',modelRequests:0,coverage:{files:0,scanned:0,eligible:0,reviewed:0,remaining:0,unfinished:0,corrupt:0,unavailable:0,oversized:0,evidenceLimited:0,privacyHeld:0},questions:[],processed:[],...extra};}
function caller({candidate=question,unsafe=false,onCall}={}){return {async call(phase,input,schema){onCall?.(phase,input);if(phase==='review')return schema.parse({reviewed:input.cases.map(c=>c.id),candidates:candidate?input.cases.map(c=>({...candidate,cases:[c.id]})):[]});if(phase==='privacy')return schema.parse({decisions:input.candidates.map((c,index)=>({index,safe:!unsafe,...(!unsafe?{candidate:c}:{})}))});if(phase==='generalize')return schema.parse({items:input.items.map(q=>({id:q.id,question:question.question,products:q.products,versions:q.versions,explanation:q.explanation,evidence:q.evidence}))});return schema.parse({groups:input.questions.map((_,i)=>[i])});}};}
const wait=async f=>{const end=Date.now()+12000;while(!await f()){if(Date.now()>end)throw Error('wait timeout');await new Promise(r=>setTimeout(r,20));}};

test('source adapter reconstructs complete turns and tool chains, omits thinking and identities, and is read-only',async t=>{
 const p=await root(t),{file}=await log(p,{questions:['第一轮设备问题','第二轮型号问题']});const before=await fs.readFile(file),stat=await fs.stat(file);
 const result=await readCases(p,from,to);assert.equal(result.cases.length,2);assert.equal(result.coverage.scanned,2);assert.match(result.cases[1].context,/第一轮设备问题/);assert.match(result.cases[0].tools,/read/);
 assert.doesNotMatch(JSON.stringify(result.cases),/private-sender|private-group|private-bot|chain of thought|private\/user/);
 assert.deepEqual(await fs.readFile(file),before);assert.equal((await fs.stat(file)).mtimeMs,stat.mtimeMs);
 assert.equal((await readCases(p,'2026-11-04T00:00:00Z','2026-11-05T00:00:00Z')).cases.length,0);
});
test('unfinished, malformed trailing records, duplicate entries and fixed commands are not misclassified as gaps',async t=>{
 const p=await root(t);const a=await log(p,{status:'running'});await log(p,{name:'commands.jsonl',questions:['/firmware 取消']});
 const line=JSON.stringify(a.entries[1]);await fs.appendFile(a.file,line+'\n{"type":');
 const result=await readCases(p,from,to);assert.equal(result.cases.length,0);assert.equal(result.coverage.unfinished,1);assert.ok(result.coverage.corrupt>=1);
});
test('source branches preserve earlier archived questions without mixing another branch answer',async t=>{
 const p=await root(t),{file,entries}=await log(p);const header=entries[0];
 const user={type:'message',id:'branch-user',parentId:undefined,timestamp:stamp,message:{role:'user',content:'另一分支的问题'}};
 const answer={type:'message',id:'branch-answer',parentId:user.id,timestamp:stamp,message:{role:'assistant',content:[{type:'text',text:'另一分支的回答'}]}};
 await fs.writeFile(file,[...entries,user,answer].map(x=>JSON.stringify(x)).join('\n')+'\n');const result=await readCases(p,from,to);
 assert.equal(result.cases.length,2);assert.equal(result.cases.find(c=>c.question==='另一分支的问题').answer,'另一分支的回答');
});
test('copied session files and repeated message entries do not inflate real question occurrences',async t=>{
 const p=await root(t),{file}=await log(p);await fs.copyFile(file,path.join(p,'sessions','copy.jsonl'));
 const result=await readCases(p,from,to);assert.equal(result.cases.length,1);assert.equal(result.coverage.eligible,1);
});
test('next-run metrics written before the next user message do not turn a completed prior round into unfinished work',async t=>{
 const p=await root(t),{file,entries}=await log(p,{questions:['第一轮问题','第二轮问题']});
 const second=entries.findIndex(e=>e.type==='message'&&e.message?.role==='user'&&e.message.content?.[0]?.text==='第二轮问题');
 const start={type:'custom',id:randomUUID(),parentId:entries[second-1].id,timestamp:stamp,customType:'web-run-metrics-v1',data:{id:randomUUID(),round:2,status:'running',startedAt:stamp}};
 entries[second].parentId=start.id;entries.splice(second,0,start);await fs.writeFile(file,entries.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const result=await readCases(p,from,to);assert.equal(result.cases.length,2);assert.equal(result.coverage.unfinished,0);
});
test('an explicitly failed legacy assistant response is not treated as a complete business answer',async t=>{
 const p=await root(t),{file,entries}=await log(p);
 const legacy=entries.filter(e=>e.type!=='custom');legacy.findLast(e=>e.message?.role==='assistant').message.stopReason='error';
 await fs.writeFile(file,legacy.map(e=>JSON.stringify(e)).join('\n')+'\n');const result=await readCases(p,from,to);assert.equal(result.cases.length,0);assert.equal(result.coverage.unfinished,1);
});
test('readers reject linked paths and knowledge access cannot escape its formal roots',async t=>{
 const p=await root(t),outside=path.join(p,'secrets.md');await fs.writeFile(outside,'do not read');await fs.symlink(outside,path.join(p,'sessions','linked.jsonl'));
 assert.equal((await readCases(p,from,to)).coverage.unavailable,1);
 const k=new ReviewKnowledge(p);await assert.rejects(k.read('products','../secrets.md'));await assert.rejects(k.read('products','newly_added/a.md'));await fs.symlink(outside,path.join(p,'urovo-product-expert','linked.md'));await assert.rejects(k.read('products','linked.md'));
 assert.ok((await k.publicProducts()).has('dt50'));
});
test('privacy preprocessing covers credentials, contacts, paths, identities and high-entropy identifiers',()=>{
 const text=scrub('客户名称：秘密公司，姓名：张三，邮箱 abc@example.com，手机13800138000，https://private.example/a，/Users/name/secret，Bearer abcdefghijklmnopqrstuvwxyz0123456789，token=verysecret，10.2.3.4');
 for(const secret of ['秘密公司','张三','abc@example.com','13800138000','private.example','/Users/name','verysecret','10.2.3.4'])assert.ok(!text.includes(secret),secret);
 assert.match(scrub('DT50 Android 13 USB 5V 5000mAh'),/DT50 Android 13 USB 5V 5000mAh/);
 assert.doesNotMatch(scrub('电话 +44 7911 123456，座机 020-12345678'),/7911|12345678/);
});
test('privacy guard rejects copied questions, source excerpts, unknown product identifiers and raw quoted evidence',()=>{
 const products=new Set(['dt50']);assert.equal(safeCandidate(question,['别的问法'],products),true);
 assert.equal(safeCandidate(question,[question.question],products),false);
 assert.equal(safeCandidate({...question,products:['SecretProject']},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,evidence:'原问题中说：联系人张三'},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,explanation:'请联系 abc@example.com 获取资料'},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,evidence:'资料来源为 product-knowledge-vault/products/DT50.md'},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,evidence:'内部服务位于 private.example.com'},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,question:'该设备是否支持系统升级与外设兼容配置？'},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,explanation:'请联系 ａｂｃ＠ｅｘａｍｐｌｅ．ｃｏｍ 获取资料'},['别的问法'],products),false);
 assert.equal(safeCandidate({...question,explanation:'存在不可见\u200b身份信息'},['别的问法'],products),false);
});
test('review and privacy phases yield generalized questions, deduplicate occurrences and keep source logs untouched',async t=>{
 const p=await root(t),{file}=await log(p,{questions:['读卡器连接条件？','外接读卡设备需要哪些条件？']}),before=await fs.readFile(file),r=run();await new ReviewStore(p).init();
 const phases=[];await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:caller({onCall:p=>phases.push(p)})});
 assert.equal(r.status,'completed');assert.equal(r.coverage.reviewed,2);assert.equal(r.questions.length,1);assert.equal(r.questions[0].occurrences,2);assert.deepEqual(phases,['review','privacy']);
 const visible=JSON.stringify(publicRun(r));assert.doesNotMatch(visible,/sources|manifest|processed|case-1|读卡器连接条件|private-sender/);assert.match(visible,/DT50/);assert.deepEqual(await fs.readFile(file),before);
});
test('unsafe candidates stay withheld and a failed privacy review cannot publish audit-stage text',async t=>{
 const p=await root(t);await log(p);await new ReviewStore(p).init();const r=run();
 await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:caller({unsafe:true})});assert.equal(r.questions.length,0);assert.equal(r.coverage.privacyHeld,1);assert.equal(r.coverage.reviewed,1);
 const broken=run();await assert.rejects(executeReview({dataDir:p,resourcesDir,model,run:broken,signal:new AbortController().signal,caller:{async call(phase,input,schema){if(phase==='privacy')throw Error('provider failure with private text');return caller().call(phase,input,schema);}}}));
 assert.equal(broken.questions.length,0);assert.equal(broken.processed.length,0);
});
test('privacy preserves equivalent casing without permitting new model or version scope',async t=>{
 const p=await root(t);await log(p);await new ReviewStore(p).init();const r=run(),base=caller();
 const c={async call(phase,input,schema){if(phase==='privacy')return schema.parse({decisions:input.candidates.map((v,index)=>({index,safe:true,candidate:{...v,products:['dt50'],versions:['android13']}}))});return base.call(phase,input,schema);}};
 await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:c});assert.equal(r.questions.length,1);assert.deepEqual(r.questions[0].products,['DT50']);assert.deepEqual(r.questions[0].versions,['Android 13']);
});
test('completed checkpoints resume without another model call and missing source data is explicitly partial',async t=>{
 const p=await root(t),{file}=await log(p);await new ReviewStore(p).init();const r=run();
 await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:caller()});
 await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:{call(){throw Error('must reuse completed batch');}}});
 assert.equal(r.questions[0].occurrences,1);
 const missing=run({manifest:['f'.repeat(64)]});await fs.unlink(file);await executeReview({dataDir:p,resourcesDir,model,run:missing,signal:new AbortController().signal,caller:caller()});
 assert.equal(missing.status,'partial');assert.equal(missing.coverage.remaining,1);assert.equal(missing.coverage.unavailable,1);
});
test('legacy scenario-specific questions remain private until generalized, preserving their stable IDs and completed work',async t=>{
 const p=await root(t);await log(p);await new ReviewStore(p).init();const r=run();await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:caller()});
 const id=r.questions[0].id;r.questions[0].generalized=undefined;r.questions[0].question='该设备在某个具体使用场景下的外设配置如何安排？';
 assert.equal(publicRun(r).questions.length,0);const phases=[];
 await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:caller({onCall:phase=>phases.push(phase)})});
 assert.deepEqual(phases,['generalize']);assert.equal(publicRun(r).questions.length,1);assert.equal(r.questions[0].id,id);assert.equal(r.questions[0].question,question.question);assert.equal(r.coverage.reviewed,1);
});
test('semantic merge combines equivalent wording but cannot combine different versions or invent text',async t=>{
 const p=await root(t);await log(p,{questions:['设备外设一','设备外设二']});await new ReviewStore(p).init();const r=run();
 const c=caller();const engine={async call(phase,input,schema){if(phase==='review')return schema.parse({reviewed:['case-1','case-2'],candidates:[question,{...question,question:'DT50 在 Android 13 系统下应如何确认 USB 外设兼容条件？',cases:['case-2']}]});if(phase==='merge')return schema.parse({groups:[[0,1]]});return c.call(phase,input,schema);}};
 await executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:engine});assert.equal(r.questions.length,1);assert.equal(r.questions[0].occurrences,2);
});
test('merger cannot combine different technical versions, and partial reviewed coverage cannot be accepted',async t=>{
 const p=await root(t);await log(p,{questions:['版本A问题','版本B问题']});await new ReviewStore(p).init();const r=run();const c=caller();
 const wrong={async call(phase,input,schema){if(phase==='review')return schema.parse({reviewed:['case-1','case-2'],candidates:[question,{...question,question:'DT50 在 Android 14 下的 USB 外设支持范围如何确认？',versions:['Android 14'],cases:['case-2']}]});if(phase==='merge')return schema.parse({groups:[[0,1]]});return c.call(phase,input,schema);}};
 await assert.rejects(executeReview({dataDir:p,resourcesDir,model,run:r,signal:new AbortController().signal,caller:wrong}),/invalid_merge/);assert.equal(r.questions.length,2);
 const incomplete={async call(phase,input,schema){return schema.parse({reviewed:['case-1'],candidates:[]});}};
 await assert.rejects(executeReview({dataDir:p,resourcesDir,model,run:run(),signal:new AbortController().signal,caller:incomplete}),/invalid_coverage/);
});
test('schedule computes local natural days including DST and advances to the next time without backfill',()=>{
 const sh=previousDayRange(Date.parse('2026-11-04T18:00:00Z'),'Asia/Shanghai');assert.deepEqual(sh,{from:'2026-11-03T16:00:00.000Z',to:'2026-11-04T16:00:00.000Z',date:'2026-11-05'});
 const dst=previousDayRange(Date.parse('2026-11-02T08:00:00Z'),'America/New_York');assert.equal(Date.parse(dst.to)-Date.parse(dst.from),25*3600000);
 assert.equal(nextDue({...defaults,enabled:false},Date.now()),undefined);
 assert.equal(nextDue({...defaults,enabled:true},Date.parse('2026-11-04T18:01:00Z')),'2026-11-05T18:00:00.000Z');
});

function streamReply(res,value,name='submit_review'){res.writeHead(200,{'content-type':'text/event-stream'});for(const [delta,finish_reason] of [[{role:'assistant',tool_calls:[{index:0,id:'review-call',type:'function',function:{name,arguments:JSON.stringify(value)}}]},null],[{},'tool_calls']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}],usage:{prompt_tokens:20,completion_tokens:20}})+'\n\n');res.end('data: [DONE]\n\n');}
async function mockModel(t,{hold=false,loopReads=false,badFirst=false}={}){
 let calls=0;const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls++;
  const content=v=>typeof v==='string'?v:v.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  const first=content(body.messages.find(m=>m.role==='system')?.content??'');const input=JSON.parse(content(body.messages.findLast(m=>m.role==='user').content));
  assert.ok(body.tools.every(t=>['submit_review','search_review_knowledge','read_review_knowledge'].includes(t.function.name)));
  if(hold){return;}if(loopReads&&first.includes('独立评审员')&&body.tools.some(t=>t.function.name==='search_review_knowledge')){streamReply(res,{query:'DT50',offset:0},'search_review_knowledge');return;}
  if(badFirst&&calls===1){streamReply(res,{reviewed:[],candidates:[{...question,category:'invalid-private-value'}]});return;}
  if(first.includes('独立隐私复核员'))streamReply(res,{decisions:input.candidates.map((c,index)=>({index,safe:true,candidate:c}))});
  else if(first.includes('合并已经通过'))streamReply(res,{groups:input.questions.map((_,i)=>[i])});
  else streamReply(res,{reviewed:input.cases.map(c=>c.id),candidates:input.cases.map(c=>({...question,cases:[c.id]}))});
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});return {get calls(){return calls;},model:{...model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}};
}
test('real isolated SDK worker, private CLI transport, idempotency, export and usage accounting work without raw audit logs',async t=>{
 const p=await root(t);const fixture=await log(p),llm=await mockModel(t),service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>llm.model});await service.init();t.after(()=>service.close());
 assert.equal(service.status().settings.enabled,false);const input={from,to,requestId:randomUUID()};const started=await requestReview(path.join(service.store.root,'control.sock'),{op:'runs.start',input});
 const repeat=await service.start(input);assert.equal(repeat.id,started.id);await assert.rejects(service.start({...input,to:'2026-11-03T00:00:00Z'}),e=>e.status===409);
 await wait(async()=>!service.status().activeRunId);const result=await service.get(started.id);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.questions.length,1);assert.equal(result.coverage.reviewed,1);assert.equal(llm.calls,2);
 const exported=await service.export(started.id,'markdown');assert.match(exported,/待核实/);assert.doesNotMatch(exported,/manifest|processed|sources|private-sender|case-1/);
 const receipts=await fs.readdir(path.join(p,'usage-ledger'));assert.ok(receipts.some(x=>x.endsWith('.json')&&x!=='coverage.json'));
 const runtime=await fs.readdir(path.join(service.store.root,'runtime')).catch(()=>[]);assert.equal(runtime.length,0);
 const cli=spawn(process.execPath,[path.resolve('dist/question-review/cli.js'),'status',started.id,'--data-dir',p]);let out='';cli.stdout.on('data',b=>out+=b);assert.equal((await once(cli,'exit'))[0],0);assert.equal(JSON.parse(out).id,started.id);
});
test('cancellation stops the isolated worker and preserves its status without affecting another module',async t=>{
 const p=await root(t);await log(p);const llm=await mockModel(t,{hold:true}),service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>llm.model});await service.init();t.after(()=>service.close());
 const job=await service.start({from,to,requestId:randomUUID()});await wait(()=>llm.calls>0);await assert.rejects(service.start({from,to,requestId:randomUUID()}),e=>e.status===409);
 const stopped=await service.cancel(job.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.coverage.reviewed,0);assert.equal(service.status().activeRunId,null);
});
test('request budget exhaustion cannot publish candidates awaiting privacy approval',async t=>{
 const p=await root(t);await log(p);const llm=await mockModel(t),service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>llm.model});await service.init();t.after(()=>service.close());
 await service.configure({...defaults,maxModelRequests:1});const job=await service.start({from,to,requestId:randomUUID()});await wait(()=>!service.status().activeRunId);
 const result=await service.get(job.id);assert.equal(llm.calls,1);assert.equal(result.modelRequests,1);assert.equal(result.status,'failed');assert.equal(result.coverage.remaining,1);assert.equal(result.questions.length,0);
});
test('repeated knowledge browsing is bounded and the model must submit before spending the whole phase budget',async t=>{
 const p=await root(t);await log(p);const llm=await mockModel(t,{loopReads:true}),service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>llm.model});await service.init();t.after(()=>service.close());
 const job=await service.start({from,to,requestId:randomUUID()});await wait(()=>!service.status().activeRunId);
 const result=await service.get(job.id);assert.equal(result.status,'completed');assert.equal(llm.calls,5);assert.equal(result.questions.length,1);
 const internal=await service.store.get(job.id);assert.equal(internal.diagnostics['review.tool.search_review_knowledge'],3);assert.equal(internal.diagnostics['review.model_requests'],4);
 assert.ok(!('diagnostics' in result));
});
test('invalid structured model submission can be corrected without storing its raw values',async t=>{
 const p=await root(t);await log(p);const llm=await mockModel(t,{badFirst:true}),service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>llm.model});await service.init();t.after(()=>service.close());
 const job=await service.start({from,to,requestId:randomUUID()});await wait(()=>!service.status().activeRunId);const result=await service.get(job.id);
 assert.equal(result.status,'completed');assert.equal(llm.calls,3);const internal=await service.store.get(job.id);assert.ok(Object.keys(internal.diagnostics).some(k=>k.includes('error')||k.includes('validation')));assert.doesNotMatch(JSON.stringify(internal),/invalid-private-value/);
});
test('restart retains configured schedule, interrupts unfinished work, and reconstructs retry request idempotency',async t=>{
 const p=await root(t),store=new ReviewStore(p);await store.init();const requestId=randomUUID(),id=randomUUID();
 const existing=run({id,requestId,status:'running',requestFingerprint:createHash('sha256').update(JSON.stringify([from,to,id])).digest('hex')});await store.save(existing);
 const service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>model});await service.init();
 assert.equal((await service.get(id)).status,'interrupted');
 const replay=await service.start({from,to,requestId,retryRunId:id});assert.equal(replay.id,id);assert.equal(service.status().activeRunId,null);
 await service.configure({...defaults,time:'04:15',timeZone:'UTC'});await service.close();
 const again=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>model});await again.init();t.after(()=>again.close());assert.equal(again.status().settings.time,'04:15');assert.equal(again.status().settings.enabled,false);
});
test('scheduler dispatches a natural day once and never backfills after missed time or duplicates a repeated tick',async t=>{
 const p=await root(t),llm=await mockModel(t);let now=Date.parse('2026-11-04T17:59:00Z');
 const service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>llm.model,now:()=>now});await service.init();t.after(()=>service.close());
 await service.configure({...defaults,enabled:true});now=Date.parse('2026-11-04T18:00:01Z');await service.tick();await service.tick();await wait(()=>!service.status().activeRunId);
 const runs=await service.list();assert.equal(runs.length,1);assert.equal(runs[0].from,'2026-11-03T16:00:00.000Z');assert.equal(runs[0].to,'2026-11-04T16:00:00.000Z');assert.equal(llm.calls,0);
 now=Date.parse('2026-11-06T19:00:00Z');await service.tick();assert.equal((await service.list()).length,1);
});
test('an unconfigured model rejects a run without creating one and module lock conflicts fail in isolation',async t=>{
 const p=await root(t),service=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>({...model,apiKey:''})});await service.init();t.after(()=>service.close());
 await assert.rejects(service.start({from,to,requestId:randomUUID()}),e=>e.status===503);assert.equal((await service.list()).length,0);
 const other=new QuestionReviewService({dataDir:p,resourcesDir,model:()=>model});await other.init();t.after(()=>other.close());assert.equal(other.status().available,false);assert.equal(service.status().available,true);
 assert.equal((await requestReview(path.join(service.store.root,'control.sock'),{op:'settings.get'})).available,true);
});
test('corrupt module settings are preserved and do not prevent the main application from serving authenticated requests',async t=>{
 const p=await root(t);await fs.mkdir(path.join(p,'question-review'));const broken=path.join(p,'question-review/settings.json');await fs.writeFile(broken,'{broken');
 const app=await createWebServer({cwd:p,dataDir:p,resourcesDir,admin:{account:'admin',password:'test-password'},model:{apiKey:'',modelId:'',baseUrl:''}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;assert.equal((await fetch(base+'/api/auth/status')).status,200);assert.equal(await fs.readFile(broken,'utf8'),'{broken');
});
test('administrator endpoints reject anonymous, CSRF-less, foreign-origin and machine callers without model requests',async t=>{
 const p=await root(t),llm=await mockModel(t),token='bridge-test-token-for-question-review';
 const app=await createWebServer({cwd:p,dataDir:p,resourcesDir,admin:{account:'admin',password:'test-password'},bridgeToken:token,model:llm.model});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
 assert.equal((await fetch(base+'/api/question-review/settings')).status,401);
 const bootstrap=await(await fetch(base+'/api/auth/status')).json(),login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','X-Local-Token':bootstrap.token},body:JSON.stringify({account:'admin',password:'test-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,'X-Local-Token':bootstrap.token,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/question-review/settings',{headers})).status,200);
 assert.equal((await fetch(base+'/api/question-review/settings',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(defaults)})).status,403);
 assert.equal((await fetch(base+'/api/question-review/settings',{method:'PUT',headers:{...headers,Origin:'https://foreign.invalid'},body:JSON.stringify(defaults)})).status,403);
 assert.equal((await fetch(base+'/api/wecom/question-review/settings',{headers:{Authorization:'Bearer '+token}})).status,403);
 const bad=await fetch(base+'/api/question-review/settings',{method:'PUT',headers,body:JSON.stringify({...defaults,timeZone:'invalid-zone'})});assert.equal(bad.status,400);
 const good=await fetch(base+'/api/question-review/settings',{method:'PUT',headers,body:JSON.stringify({...defaults,time:'03:30'})});assert.equal(good.status,200);assert.equal(llm.calls,0);
});
