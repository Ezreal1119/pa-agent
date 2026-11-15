import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createAgentRuntime} from '../dist/index.js';
import {chatCompaction} from '../dist/agent/chat-compaction.js';
import {chatCompactionConfig} from '../dist/agent/compaction-config.js';
import {historyMessages, historyRounds} from '../dist/agent/session-history.js';
import {chatHistory} from '../dist/web/chat-history.js';
import {getToolRuns} from '../dist/web/tool-calls.js';
import {captureMessageAttachments, messageAttachments} from '../dist/agent/message-attachments.js';
import {writeMemoryFixture} from './memory-fixtures.mjs';

const until = async f => { for(let i=0;i<500;i++){if(await f())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out'); };
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const isSummary = body => body.messages.some(m=>m.role==='system' && m.content.includes('context summarization assistant'));
function reply(res, text, tool, usage=20000) {
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const delta=tool ? {tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'read',arguments:JSON.stringify({path:tool})}}]} : {content:text};
  for(const [d,end] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:d,finish_reason:end}],...(end?{usage:{prompt_tokens:usage-1000,prompt_tokens_details:{cached_tokens:5000},completion_tokens:1000,total_tokens:usage}}:{})})}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function fixture(t, config={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chat-compact-')),dataDir=path.join(root,'data');
  await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});
  await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'PRODUCT_PRIVATE_INJECTION');
  await writeMemoryFixture(dataDir,'urovo-product-expert','MEMORY_PRIVATE_INJECTION');
  const requests=[];let handler;
  const model=createServer(async(req,res)=>{let data='';for await(const p of req)data+=p;const body=JSON.parse(data);requests.push(body);try{if(handler)await handler(body,res);else reply(res,isSummary(body)?'SUMMARY-v1':'ANSWER');}catch(e){res.destroy(e);}});
  model.listen(0,'127.0.0.1');await once(model,'listening');
  const options={cwd:root,dataDir,resourcesDir:path.resolve('resources'),fileTools:{enabled:false},model:{apiKey:'FAKE_KEY',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,modelId:'fixture',contextWindow:500000,maxTokens:10000},compaction:{enabled:true,triggerTokens:10000,keepRecentRounds:5,...config}};
  const runtime=await createAgentRuntime(options),sessions=[];
  const create=async()=>{const s=await runtime.createSession();sessions.push(s);return s;};
  const resume=async file=>{const s=await runtime.createSession(SessionManager.open(file, runtime.config.sessionsDir));sessions.push(s);return s;};
  t.after(async()=>{await Promise.all(sessions.map(s=>chatCompaction(s)?.cancel()));sessions.forEach(s=>s.dispose());runtime.dispose();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
  return {root,dataDir,requests,options,runtime,create,resume,setHandler:f=>handler=f};
}
const bodyText = content => typeof content === 'string' ? content : content.map(b=>b.text??'').join('');
const texts = s => s.messages.filter(m=>m.role==='user').map(m=>m.content[0].text);
async function rounds(session,n,start=1){for(let i=start;i<start+n;i++)await session.prompt(`question-${i}`);}

test('configuration defaults, opt-in, independent model capacity and validation',()=>{
  assert.deepEqual(chatCompactionConfig({},{}),{enabled:false,triggerTokens:384000,keepRecentRounds:5});
  assert.equal(chatCompactionConfig({}, {CHAT_COMPACTION_ENABLED:'true'}, {contextWindow:1000000,maxTokens:30000}).enabled,true);
  assert.throws(()=>chatCompactionConfig({}, {CHAT_COMPACTION_ENABLED:'yes'}));
  for(const n of ['0','-1','1.5','NaN','Infinity'])assert.throws(()=>chatCompactionConfig({}, {CHAT_COMPACTION_KEEP_RECENT_ROUNDS:n}));
  assert.throws(()=>chatCompactionConfig({enabled:true},{},{contextWindow:128000,maxTokens:16384}),/CONTEXT_WINDOW/);
});

test('below threshold is retained and cached usage triggers at the exact configured boundary',async t=>{
  const f=await fixture(t,{triggerTokens:20001}),s=await f.create();await rounds(s,7);
  chatCompaction(s).afterAnswer();assert.equal(chatCompaction(s).busy,false);
  assert.equal(texts(s).length,7);assert.equal(f.requests.filter(isSummary).length,0);
  f.setHandler((b,res)=>reply(res,isSummary(b)?'SUMMARY':'ANSWER',undefined,20001));
  await s.prompt('question-8');chatCompaction(s).afterAnswer();await chatCompaction(s).wait();
  assert.equal(f.requests.filter(isSummary).length,1);assert.equal(texts(s).length,5);
});

test('raw rounds accumulate; compaction preserves exactly five whole rounds and native checkpoint resumes',async t=>{
  const f=await fixture(t),s=await f.create();await rounds(s,5);
  chatCompaction(s).afterAnswer();assert.equal(chatCompaction(s).busy,false);
  await s.prompt('question-6');assert.equal(f.requests.at(-1).messages.filter(m=>m.role==='user').length,6);
  const original=s.sessionManager.getBranch().filter(e=>e.type==='message').slice(2);
  chatCompaction(s).afterAnswer();await chatCompaction(s).wait();
  assert.deepEqual(texts(s),['question-2','question-3','question-4','question-5','question-6']);
  assert.equal(historyRounds(s),6);assert.equal(chatHistory(s,[]).rounds,6);
  assert.equal(chatHistory(s,[]).messages.length,12);
  const checkpoint=s.sessionManager.getBranch().findLast(e=>e.type==='compaction');
  assert.equal(checkpoint.firstKeptEntryId,original[0].id);
  assert.equal(checkpoint.summary,'SUMMARY-v1');
  assert.ok(s.messages.some(m=>m.role==='compactionSummary'));
  const body=f.requests.find(isSummary);assert.ok(body);
  assert.ok(!body.tools?.length);assert.equal(body.max_tokens??body.max_completion_tokens,8192);
  assert.ok(!body.messages[0].content.includes('PRODUCT_PRIVATE_INJECTION'));
  assert.ok(!body.messages[0].content.includes('MEMORY_PRIVATE_INJECTION'));
  assert.ok(bodyText(body.messages.at(-1).content).includes('question-1'));
  assert.ok(!bodyText(body.messages.at(-1).content).includes('question-2'));
  const kept=s.messages.filter(m=>m.role!=='compactionSummary');
  assert.deepEqual(kept,original.map(e=>e.message));
  const count=f.requests.length;chatCompaction(s).afterAnswer();await chatCompaction(s).wait();assert.equal(f.requests.length,count);
  const file=s.sessionFile;s.dispose();const restored=await f.resume(file);
  assert.deepEqual(texts(restored),texts(s));
  chatCompaction(restored).afterAnswer();await chatCompaction(restored).wait();assert.equal(f.requests.length,count);
  await restored.prompt('question-7');
  assert.ok(f.requests.at(-1).messages.some(m=>bodyText(m.content).includes('SUMMARY-v1')));
  chatCompaction(restored).afterAnswer();await chatCompaction(restored).wait();
  const summaries=f.requests.filter(isSummary);assert.equal(summaries.length,2);
  assert.ok(bodyText(summaries[1].messages.at(-1).content).includes('<previous-summary>'));
  assert.ok(bodyText(summaries[1].messages.at(-1).content).includes('question-2'));
  assert.ok(!bodyText(summaries[1].messages.at(-1).content).includes('question-1'));
  const receipts=await Promise.all((await fs.readdir(path.join(f.dataDir,'usage-ledger'))).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>fs.readFile(path.join(f.dataDir,'usage-ledger',n),'utf8').then(JSON.parse)));
  assert.equal(receipts.filter(r=>r.source==='chat-compaction').length,2);
  assert.equal(receipts.filter(r=>r.source==='chat').length,7);
});

test('existing sessions start from last five raw rounds and preserve their floor across restart',async t=>{
  const f=await fixture(t,{enabled:false});const old=await f.create();await rounds(old,9);
  const file=old.sessionFile;old.dispose();
  // Timestamp collisions must not move the ID-based migration boundary.
  const entries=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  for(const entry of entries)if(entry.type==='message')entry.message.timestamp=123;
  await fs.writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const enabled=await createAgentRuntime({...f.options,compaction:{enabled:true,triggerTokens:10000,keepRecentRounds:5}});
  let session=await enabled.createSession(SessionManager.open(file, enabled.config.sessionsDir));
  t.after(()=>{session.dispose();enabled.dispose();});
  assert.deepEqual(texts(session),['question-5','question-6','question-7','question-8','question-9']);
  assert.equal(historyRounds(session),9);assert.equal(f.requests.filter(isSummary).length,0);
  session.dispose();session=await enabled.createSession(SessionManager.open(file, enabled.config.sessionsDir));assert.equal(texts(session)[0],'question-5');
  await session.prompt('question-10');chatCompaction(session).afterAnswer();await chatCompaction(session).wait();
  const summary=bodyText(f.requests.find(isSummary).messages.at(-1).content);
  assert.ok(summary.includes('question-5'));assert.ok(!summary.includes('question-4'));
  assert.equal(chatHistory(session,[]).messages.length,20);
});

test('same-session prompts wait for compaction; another session can answer during it',async t=>{
  const f=await fixture(t),s=await f.create(),other=await f.create(),hold=deferred();
  f.setHandler(async(body,res)=>{if(isSummary(body))await hold.promise;reply(res,isSummary(body)?'SUMMARY':'ANSWER');});
  t.after(()=>hold.resolve());await rounds(s,6);chatCompaction(s).afterAnswer();
  await until(()=>f.requests.some(isSummary));
  const queued=s.prompt('queued-question');
  await other.prompt('other-session');
  assert.equal(bodyText(f.requests.at(-1).messages.at(-1).content),'other-session');
  assert.ok(!f.requests.some(b=>!isSummary(b)&&bodyText(b.messages.at(-1).content)==='queued-question'));
  hold.resolve();await queued;
  assert.ok(f.requests.at(-1).messages.some(m=>bodyText(m.content).includes('SUMMARY')));
});

test('failed summaries retain all context, enforce cooldown and never repeat on every call',async t=>{
  const f=await fixture(t),s=await f.create();await rounds(s,6);const before=structuredClone(s.messages);
  f.setHandler((body,res)=>{if(isSummary(body)){res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":{"message":"fixture failure"}}');}else reply(res,'ANSWER');});
  chatCompaction(s).afterAnswer();await chatCompaction(s).wait();
  assert.deepEqual(s.messages,before);assert.ok(!s.sessionManager.getBranch().some(e=>e.type==='compaction'));
  const count=f.requests.length;chatCompaction(s).afterAnswer();await chatCompaction(s).wait();assert.equal(f.requests.length,count);
  await s.prompt('question-7');assert.equal(f.requests.at(-1).messages.filter(m=>m.role==='user').length,7);
  const file=s.sessionFile;s.dispose();let restored=await f.resume(file);
  const beforeRetry=f.requests.length;chatCompaction(restored).afterAnswer();assert.equal(f.requests.length,beforeRetry);
  restored.dispose();
  const entries=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  for(const entry of entries)if(entry.customType==='chat-context-v1'&&entry.data.lastFailureAt)entry.data.lastFailureAt-=60001;
  await fs.writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  restored=await f.resume(file);f.setHandler((body,res)=>reply(res,isSummary(body)?'RECOVERED SUMMARY':'ANSWER'));
  chatCompaction(restored).afterAnswer();await chatCompaction(restored).wait();
  assert.equal(texts(restored).length,5);assert.ok(restored.sessionManager.getBranch().some(e=>e.type==='compaction'));
});

test('timeout and cancellation leave no checkpoint, release the session and cannot write a late summary',async t=>{
  const f=await fixture(t),s=await f.create(),hold=deferred();t.after(()=>hold.resolve());
  await rounds(s,6);const before=structuredClone(s.messages),coordinator=chatCompaction(s);
  coordinator.options.timeoutMs=30;
  f.setHandler(async(b,res)=>{if(isSummary(b))await hold.promise;reply(res,isSummary(b)?'LATE SUMMARY':'ANSWER');});
  coordinator.afterAnswer();await coordinator.wait();
  assert.deepEqual(s.messages,before);assert.ok(!s.sessionManager.getBranch().some(e=>e.type==='compaction'));
  const another=await f.create();await rounds(another,6);
  chatCompaction(another).afterAnswer();await until(()=>f.requests.filter(isSummary).length===2);
  await chatCompaction(another).cancel();const deleted=another.sessionFile;await fs.unlink(deleted);another.dispose();hold.resolve();
  await new Promise(r=>setTimeout(r,20));
  assert.ok(!another.sessionManager.getBranch().some(e=>e.type==='compaction'));
  assert.equal(await fs.stat(deleted).catch(()=>null),null);
  assert.equal(coordinator.busy,false);
});

test('tools, attachment bindings, global round numbers and paged audit history survive compaction',async t=>{
  const f=await fixture(t),s=await f.create();const file=path.join(f.dataDir,'urovo-product-expert/SKILL.md');
  f.setHandler((body,res)=>reply(res,isSummary(body)?'SUMMARY':'ANSWER',!isSummary(body)&&body.messages.at(-1).role==='user'?file:undefined));
  await rounds(s,6);const beforeTools=getToolRuns(s),beforeHistory=chatHistory(s,[],undefined,{limit:30});
  chatCompaction(s).afterAnswer();await chatCompaction(s).wait();
  assert.deepEqual(getToolRuns(s),beforeTools);assert.deepEqual(chatHistory(s,[],undefined,{limit:30}),beforeHistory);
  assert.equal(s.messages.filter(m=>m.role==='toolResult').length,5);
  const release=captureMessageAttachments(s,'run-7',[{id:randomUUID(),name:'log.txt',path:'inputs/log.txt',bytes:12,direction:'inputs'}]);
  await s.prompt('question-7');release();
  const record=messageAttachments(s).at(-1);assert.equal(record.round,7);assert.ok(record.messageId);
  const b=f.requests.filter(b=>!isSummary(b)&&b.messages.at(-1).role==='user').at(-1);
  assert.ok(JSON.stringify(b.messages.at(-1)).includes('Files attached to this message'));
  assert.equal(historyMessages(s).filter(m=>m.role==='user').length,7);
});
