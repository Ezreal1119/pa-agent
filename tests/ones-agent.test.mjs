import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {onesConfig,ONES_READ_TOOLS} from '../dist/ones-agent/config.js';
import {OnesMcp} from '../dist/ones-agent/mcp.js';
import {recordOnesResult,splitAgentUsage} from '../dist/ones-agent/metrics.js';
import {getToolRuns} from '../dist/web/tool-calls.js';
import {onesFixture,delegation,defaultModel,streamReply,isChild,isSummary,lastUser,currentTools,until} from './ones-fixtures.mjs';

const childRequests=f=>f.requests.filter(isChild);
const run=(f,s,question='SQ29M',signal)=>f.runtime.ones.run(s.sessionId,question,delegation,signal);

test('configuration is opt-in, validates budgets/capacity, and never allows write tools',()=>{
 const model={apiKey:'x',baseUrl:'https://model.example',modelId:'fixture',contextWindow:500000,maxTokens:10000};
 const resources=path.resolve('resources');
 assert.equal(onesConfig(resources,model,{},{}).enabled,false);
 assert.equal(ONES_READ_TOOLS.length,39);
 for(const settings of [{tools:['update_issue']},{timeoutMs:0},{queueLimit:-1},{compaction:{triggerTokens:490000}},{compaction:{enabled:false}}])assert.throws(()=>onesConfig(resources,model,{enabled:true,token:'fake',settings},{}));
 assert.throws(()=>onesConfig(resources,model,{enabled:true,token:'fake',url:'https://x.example/mcp?token=bad'},{}));
 assert.throws(()=>onesConfig(resources,model,{enabled:true},{}),/TOKEN/);
});

test('real local MCP transport uses the dedicated header, filters tools and rejects a write call',async t=>{
 const f=await onesFixture(t);const mcp=new OnesMcp(f.runtime.config.ones,new AbortController().signal);t.after(()=>mcp.close());
 const tools=await mcp.open();assert.deepEqual(tools.map(t=>t.name),['get_issue_details','who_am_i']);
 assert.ok(f.mcpRequests.every(r=>r.token==='ONES_FIXTURE_SECRET'&&!r.authorization));
 await assert.rejects(mcp.call('update_issue',{}),/未获授权/);
 assert.equal(f.toolCalls.length,0);
});

test('independent prompt and tools receive the original question and relevant corrections without main knowledge',async t=>{
 const f=await onesFixture(t),s=await f.create();const result=await run(f,s,'这个型号最新版本？');
 assert.equal(result.status,'completed');assert.equal(result.toolCalls,1);assert.equal(result.usage.requests,2);assert.equal(result.usage.input,200);assert.equal(result.usage.output,14);
 const b=childRequests(f)[0],input=JSON.parse(lastUser(b).content);
 assert.equal(input.originalQuestion,'这个型号最新版本？');assert.deepEqual(input.delegation.corrections,delegation.corrections);assert.equal(input.timezone,'Asia/Shanghai');
 assert.ok(!JSON.stringify(b).includes('BUSINESS_PRIVATE'));assert.ok(!JSON.stringify(b).includes('ONES_FIXTURE_SECRET'));assert.ok(!JSON.stringify(b).includes('MODEL_FIXTURE_SECRET'));
 assert.deepEqual(b.tools.map(t=>t.function.name),['get_issue_details','who_am_i','finish_ones_task']);
 assert.equal(result.sources[0].id,'issue-这个型号最新版本？');
});

test('parent contexts remain isolated, follow-ups survive restart, and child histories are outside the main list',async t=>{
 const f=await onesFixture(t),a=await f.create(),b=await f.create();
 await run(f,a,'AAA_ONLY');await run(f,b,'BBB_ONLY');await run(f,a,'AAA_followup');
 const aLast=childRequests(f).at(-1);assert.ok(JSON.stringify(aLast).includes('AAA_ONLY'));assert.ok(!JSON.stringify(aLast).includes('BBB_ONLY'));
 assert.equal((await SessionManager.list(f.root,f.runtime.config.sessionsDir)).length,2);
 const aid=a.sessionId;await f.restart();
 const result=await f.runtime.ones.run(aid,'AAA_restart',delegation);assert.equal(result.status,'completed');assert.ok(JSON.stringify(childRequests(f).at(-1)).includes('AAA_followup'));
});

test('the main Agent delegates through one tool, backend binds the exact original, and details preserve the response',async t=>{
 const f=await onesFixture(t),s=await f.create(false);
 await s.prompt('用户原文：不是 P8100，是 SQ29M');
 const input=JSON.parse(lastUser(childRequests(f)[0]).content);assert.equal(input.originalQuestion,'用户原文：不是 P8100，是 SQ29M');
 assert.equal(s.messages.findLast(m=>m.role==='assistant').content[0].text,'主 Agent 已整合 ONES 查询结果。');
 const call=[...getToolRuns(s).values()].at(-1).calls.find(c=>c.name==='ask_ones_agent');assert.equal(call.result.details.onesTask.status,'completed');assert.deepEqual(call.arguments.corrections,delegation.corrections);
 const receipt=s.sessionManager.getBranch().find(e=>e.type==='custom'&&e.customType==='ones-delegation-v1');assert.ok(receipt);
});

test('oversized delegation is rejected without opening MCP or silently clipping corrections',async t=>{
 const f=await onesFixture(t,{ones:{maxContextChars:200}}),s=await f.create();
 await assert.rejects(f.runtime.ones.run(s.sessionId,'Q',{...delegation,background:'x'.repeat(300)}),/超过/);assert.equal(f.toolCalls.length,0);assert.equal(f.mcpRequests.length,0);
});

test('authentication failure returns a safe failure, no model call, and no token in the result',async t=>{
 const f=await onesFixture(t),s=await f.create();f.setAuth(401);const result=await run(f,s);
 assert.equal(result.status,'failed');assert.match(result.answer,/认证失败/);assert.ok(!JSON.stringify(result).includes('ONES_FIXTURE_SECRET'));assert.equal(childRequests(f).length,0);
 assert.equal(f.mcpRequests.filter(r=>r.method==='POST').length,1);
});

test('clarification is returned as a structured outcome rather than fabricated data',async t=>{
 const f=await onesFixture(t),s=await f.create();
 f.setModel((b,res)=>isChild(b)?streamReply(res,{tool:{name:'finish_ones_task',args:{status:'needs_clarification',answer:'需要明确项目',sources:[],unknowns:['同型号存在多个客户项目'],questions:['要查询哪个客户项目？']}}}):defaultModel(b,res));
 const r=await run(f,s);assert.equal(r.status,'needs_clarification');assert.deepEqual(r.questions,['要查询哪个客户项目？']);assert.equal(f.toolCalls.length,0);
});

test('invented sources are rejected and the Agent can repair its final submission',async t=>{
 const f=await onesFixture(t),s=await f.create();let rejected=false;
 f.setModel((b,res)=>{
  if(!isChild(b))return defaultModel(b,res);
  if(!currentTools(b).length)return streamReply(res,{tool:{name:'finish_ones_task',args:{status:'completed',answer:'fake',sources:[{id:'invented',title:'fake'}],unknowns:[],questions:[]}}});
  if(currentTools(b).some(t=>String(t.content).includes('未出现在')))rejected=true;
  return streamReply(res,{tool:{name:'finish_ones_task',args:{status:'partial',answer:'没有已验证来源',sources:[],unknowns:['未完成查询'],questions:[]}}});
 });
 const r=await run(f,s);assert.equal(r.status,'partial');assert.equal(rejected,true);
});

test('same-parent execution is serial while separate parents can query concurrently',async t=>{
 const f=await onesFixture(t),a=await f.create(),b=await f.create();let release;const hold=new Promise(r=>release=r);t.after(()=>release());let entered=0;
 f.setTools(async(_name,args)=>{entered++;await hold;return {content:[{type:'text',text:JSON.stringify({id:args.issueID,url:`https://ones.example/issues/${encodeURIComponent(args.issueID)}`})}]};});
 const x=run(f,a,'A1'),y=run(f,a,'A2'),z=run(f,b,'B1');await until(()=>entered===2);assert.equal(childRequests(f).length,2);release();const all=await Promise.all([x,y,z]);assert.ok(all.every(r=>r.status==='completed'));assert.equal(entered,3);
});

test('cancellation stops a child and retains completed tool history and recorded usage',async t=>{
 const f=await onesFixture(t),s=await f.create();let entered=false;
 f.setModel((b,res)=>{if(isChild(b)&&currentTools(b).length){entered=true;return;}return defaultModel(b,res);});
 const c=new AbortController();const pending=run(f,s,'cancel',c.signal);await until(()=>entered);c.abort();const r=await pending;
 assert.equal(r.status,'cancelled');assert.equal(r.usage.requests,2);assert.equal(r.usage.reportedRequests,1);assert.equal(r.usage.input,100);
 const manager=await f.childManager(s.sessionId);assert.ok(manager.getBranch().some(e=>e.type==='message'&&e.message.role==='toolResult'));
});

test('task timeout is bounded and permits a later query using the same parent',async t=>{
 const f=await onesFixture(t,{ones:{timeoutMs:1000}}),s=await f.create();
 f.setModel((b,res)=>{if(isChild(b))return;return defaultModel(b,res);});
 const r=await run(f,s,'timeout');assert.equal(r.status,'cancelled');assert.match(r.answer,/超时/);
 f.setModel(defaultModel);const next=await run(f,s,'retry');assert.equal(next.status,'completed');
});

test('deleting a parent cancels queued/active tasks and cannot recreate its directory',async t=>{
 const f=await onesFixture(t),s=await f.create();let entered=false;
 f.setModel((b,res)=>{if(isChild(b)){entered=true;return;}return defaultModel(b,res);});
 const active=run(f,s,'delete'),queued=run(f,s,'queued');await until(()=>entered);
 await f.runtime.ones.deleteParent(s.sessionId);await Promise.all([active,queued]);
 await assert.rejects(fs.stat(path.join(f.dataDir,'agents/ones/parents',s.sessionId)),{code:'ENOENT'});
 assert.throws(()=>run(f,s,'late'),/deleted/);
 await new Promise(r=>setTimeout(r,30));await assert.rejects(fs.stat(path.join(f.dataDir,'agents/ones/parents',s.sessionId)),{code:'ENOENT'});
});

test('model/tool budgets stop runaway work without granting extra tools',async t=>{
 const f=await onesFixture(t,{ones:{maxModelRequests:2,maxToolCalls:1}}),s=await f.create();
 f.setModel((b,res)=>isChild(b)?streamReply(res,{tool:{name:'get_issue_details',args:{issueID:'budget'}}}):defaultModel(b,res));
 const r=await run(f,s,'budget');assert.equal(r.status,'failed');assert.equal(r.usage.requests,2);assert.equal(r.toolCalls,1);assert.equal(f.toolCalls.length,1);
});

test('compaction preserves five complete task rounds, merges summaries and survives a restart',async t=>{
 const f=await onesFixture(t,{ones:{compaction:{triggerTokens:1}}}),s=await f.create();
 for(let i=1;i<=6;i++)assert.equal((await run(f,s,`Q${i}`)).status,'completed');
 await until(async()=>{const m=await f.childManager(s.sessionId);return m.getBranch().some(e=>e.type==='compaction');});
 let manager=await f.childManager(s.sessionId);const checkpoint=manager.getBranch().findLast(e=>e.type==='compaction');
 const kept=manager.getBranch().slice(manager.getBranch().findIndex(e=>e.id===checkpoint.firstKeptEntryId)).filter(e=>e.type==='message');
 assert.equal(kept.filter(e=>e.message.role==='user').length,5);assert.equal(manager.getBranch().filter(e=>e.type==='message'&&e.message.role==='user').length,6);
 assert.equal(f.requests.filter(isSummary).length,1);assert.ok(!JSON.stringify(f.requests.find(isSummary)).includes('BUSINESS_PRIVATE'));
 await run(f,s,'Q7');await until(()=>f.requests.filter(isSummary).length===2);
 assert.ok(JSON.stringify(f.requests.filter(isSummary).at(-1)).includes('ONES SUMMARY'));
 const sid=s.sessionId;await f.restart();await f.runtime.ones.run(sid,'Q8',delegation);
 assert.ok(JSON.stringify(childRequests(f).at(-1)).includes('ONES SUMMARY'));
});

test('delegated metrics are counted once and retain a separate main/ONES breakdown',()=>{
 const m={usage:{input:100,output:7,requests:1,reportedRequests:1}};const t={taskId:'a',status:'completed',elapsedMs:10,toolCalls:1,usage:{input:200,output:14,requests:2,reportedRequests:2}};
 recordOnesResult(m,{details:{onesTask:t}});recordOnesResult(m,{details:{onesTask:t}});
 assert.equal(m.usage.input,300);assert.equal(m.onesTasks.length,1);assert.deepEqual(splitAgentUsage(m),{main:{input:100,output:7,requests:1,reportedRequests:1},ones:t.usage});
});

test('temporary MCP connection failure retries once without replaying a model task',async t=>{
 const f=await onesFixture(t),s=await f.create();f.setAuth(503);
 const pending=run(f,s,'network');await until(()=>f.mcpRequests.some(r=>r.method==='POST'));f.setAuth(200);
 const r=await pending;assert.equal(r.status,'completed');assert.equal(r.usage.requests,2);assert.equal(f.toolCalls.length,1);
});

test('oversized MCP data produces an explicit error and can finish as partial without hidden truncation',async t=>{
 const f=await onesFixture(t,{ones:{maxResultBytes:4096}}),s=await f.create();
 f.setTools(async()=>({content:[{type:'text',text:'x'.repeat(20000)}]}));
 let sawSizeError=false;
 f.setModel((b,res)=>{
  if(!isChild(b))return defaultModel(b,res);
  if(!currentTools(b).length)return streamReply(res,{tool:{name:'get_issue_details',args:{issueID:'huge'}}});
  sawSizeError=currentTools(b).some(t=>t.content.includes('过大'));
  return streamReply(res,{tool:{name:'finish_ones_task',args:{status:'partial',answer:'需缩小范围或分页',sources:[],unknowns:['响应超过上限'],questions:[]}}});
 });
 const r=await run(f,s,'huge');assert.equal(r.status,'partial');assert.equal(sawSizeError,true);assert.equal(f.toolCalls.length,1);
});

test('a permission failure during a tool call stops the task and is not repeatedly queried',async t=>{
 const f=await onesFixture(t),s=await f.create();
 f.setModel((b,res)=>{if(isChild(b))f.setAuth(403);return defaultModel(b,res);});
 const r=await run(f,s,'denied');assert.equal(r.status,'failed');assert.match(r.answer,/权限/);assert.equal(r.usage.requests,1);assert.equal(r.toolCalls,1);assert.equal(f.toolCalls.length,0);
});

test('child result is delivered before compaction and same-parent followup waits without blocking another parent',async t=>{
 const f=await onesFixture(t,{ones:{compaction:{triggerTokens:1}}}),a=await f.create(),b=await f.create();let release;const hold=new Promise(r=>release=r);t.after(()=>release());let summaries=0;
 f.setModel(async(body,res)=>{if(isSummary(body)){summaries++;await hold;return streamReply(res,{text:'WAITED SUMMARY'});}return defaultModel(body,res);});
 for(let i=1;i<=6;i++)assert.equal((await run(f,a,`round${i}`)).status,'completed');
 await until(()=>summaries===1);
 let followed=false;const follow=run(f,a,'after_summary').then(r=>{followed=true;return r;});
 assert.equal((await run(f,b,'unrelated')).status,'completed');assert.equal(followed,false);
 release();assert.equal((await follow).status,'completed');assert.ok(JSON.stringify(childRequests(f).at(-1)).includes('WAITED SUMMARY'));
});

test('failed compaction preserves the six raw tasks and does not erase the delivered answer',async t=>{
 const f=await onesFixture(t,{ones:{compaction:{triggerTokens:1}}}),s=await f.create();let summaries=0;
 f.setModel((body,res)=>{if(isSummary(body)){summaries++;res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture summary failure'}}));return;}return defaultModel(body,res);});
 let result;for(let i=1;i<=6;i++)result=await run(f,s,`F${i}`);assert.equal(result.status,'completed');
 await until(async()=>{const manager=await f.childManager(s.sessionId);return manager.getBranch().some(e=>e.type==='custom'&&e.customType==='chat-context-v1'&&e.data.lastFailureAt);});
 const manager=await f.childManager(s.sessionId);assert.equal(manager.getBranch().filter(e=>e.type==='compaction').length,0);assert.equal(manager.getBranch().filter(e=>e.type==='message'&&e.message.role==='user').length,6);
 await run(f,s,'F7');await new Promise(r=>setTimeout(r,30));assert.equal(summaries,1);
});

test('shutdown marks unfinished work interrupted and restart recovers unfinished task snapshots without replay',async t=>{
 const f=await onesFixture(t),s=await f.create();let waiting=false;
 f.setModel((body,res)=>{if(isChild(body)&&currentTools(body).length){waiting=true;return;}return defaultModel(body,res);});
 const pending=run(f,s,'shutdown');await until(()=>waiting);await f.runtime.close();const r=await pending;assert.equal(r.status,'interrupted');assert.equal(r.usage.reportedRequests,1);
 const taskFile=path.join(f.dataDir,'agents/ones/parents',s.sessionId,'tasks',`${r.taskId}.json`);const record=JSON.parse(await fs.readFile(taskFile,'utf8'));record.result.status='running';record.result.usage={input:0,output:0,requests:0,reportedRequests:0};await fs.writeFile(taskFile,JSON.stringify(record));
 const count=f.requests.length;await f.restart();const recovered=JSON.parse(await fs.readFile(taskFile,'utf8'));assert.equal(recovered.result.status,'interrupted');assert.equal(recovered.result.usage.input,100);assert.equal(recovered.result.usage.requests,2);assert.equal(f.requests.length,count);
});

test('ONES queue saturation fails promptly and cancellation frees its independent slot',async t=>{
 const f=await onesFixture(t,{ones:{concurrency:1,queueLimit:0}}),a=await f.create(),b=await f.create();let waiting=false;
 f.setModel((body,res)=>{if(isChild(body)){waiting=true;return;}return defaultModel(body,res);});
 const c=new AbortController(),pending=run(f,a,'slot',c.signal);await until(()=>waiting);
 const rejected=await run(f,b,'full');assert.equal(rejected.status,'failed');assert.match(rejected.answer,/queue is full/);
 c.abort();await pending;f.setModel(defaultModel);assert.equal((await run(f,b,'available')).status,'completed');
});

test('query and summary receipts are separated and actual child model requests are billed only once',async t=>{
 const f=await onesFixture(t,{ones:{compaction:{triggerTokens:1}}}),s=await f.create();
 for(let i=1;i<=6;i++)await run(f,s,`B${i}`);
 await until(async()=>{const manager=await f.childManager(s.sessionId);return manager.getBranch().some(e=>e.type==='compaction');});
 const receipts=await Promise.all((await fs.readdir(path.join(f.dataDir,'usage-ledger'))).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(async n=>JSON.parse(await fs.readFile(path.join(f.dataDir,'usage-ledger',n),'utf8'))));
 assert.equal(receipts.filter(r=>r.source==='ones-agent').length,12);assert.equal(receipts.filter(r=>r.source==='ones-compaction').length,1);assert.ok(receipts.filter(r=>r.source==='ones-agent').every(r=>r.scope.kind==='ones'&&r.tokens&&r.finished));
});

test('the main Agent cannot exceed its per-question delegation limit',async t=>{
 const f=await onesFixture(t,{ones:{maxDelegations:2}}),s=await f.create(false);
 f.setModel((b,res)=>{
  if(isChild(b)||isSummary(b))return defaultModel(b,res);
  if(currentTools(b).length<3)return streamReply(res,{tool:{name:'ask_ones_agent',args:delegation}});
  return streamReply(res,{text:'根据已有结果回答'});
 });
 await s.prompt('bounded delegation');assert.equal(f.toolCalls.length,2);assert.equal(childRequests(f).length,4);
 const calls=[...getToolRuns(s).values()].at(-1).calls;assert.equal(calls.length,3);assert.equal(calls.at(-1).status,'failed');assert.match(JSON.stringify(calls.at(-1).result),/委派次数已用尽/);
});
