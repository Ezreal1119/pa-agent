import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {onesFixture, currentTools, lastUser, system, streamReply, until} from "./ones-fixtures.mjs";
import {writeMemory, recallFixtureReply, memoryRequest, memoryRows, recallReply} from "./memory-recall-fixture.mjs";
import {getToolRuns} from "../dist/web/tool-calls.js";
import {memorySnapshot, retrieveMemory} from "../dist/memory-recall/retrieve.js";
import {previewPrompt} from "../dist/prompts/composition.js";
import {memoryRecallConfig} from "../dist/memory-recall/config.js";

const setup = async (t, inputMode = "candidates") => {
  const f = await onesFixture(t, {extra:{memoryRecall:{enabled:true,inputMode}, ones:{enabled:false}}});
  await writeMemory(f.dataDir);
  f.setModel(recallFixtureReply);
  return f;
};

test("recall ranks exact model and version, preserves correction entries and can find nothing", async t => {
  const f = await setup(t);
  const memory = await memorySnapshot(f.dataDir);
  const candidates = retrieveMemory(memory, "它支持吗？", {query:"SQ29M R01 协议", identifiers:["SQ29M","R01"]});
  assert.deepEqual(new Set(candidates.slice(0,2).map(c=>c.id)),new Set(["mem_target","mem_extra"]));
  assert.deepEqual(retrieveMemory(memory, "heliotrope", {query:"heliotrope"}), []);
});

test("Supervisor gets scoped evidence, sees newly edited memory next round, and retains historical tool details", async t => {
  const f = await setup(t);
  const s = await f.create(false);
  await s.prompt("它支持什么协议？");
  const requests = f.requests.filter(memoryRequest);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(JSON.parse(lastUser(request).content).question,"它支持什么协议？");
  assert.ok(!system(f.requests[0]).includes("M7"));
  assert.ok(!JSON.stringify(request).includes("打印耗材"));
  assert.equal(request.tools, undefined);
  assert.deepEqual(request.response_format, {type:"json_object"});
  const calls = [...getToolRuns(s).values()];
  const result = calls[0].calls[0].result.details.memoryTask;
  assert.equal(result.status,"matched");
  assert.equal(result.evidence[0].relevance,"说明所查询版本的协议支持范围。");
  assert.deepEqual(result.usage,{input:100,output:7,requests:1,reportedRequests:1});
  const ledgerDir = path.join(f.dataDir,"usage-ledger");
  const ledger = await Promise.all((await fs.readdir(ledgerDir)).map(async name => JSON.parse(await fs.readFile(path.join(ledgerDir,name),"utf8"))));
  const receipts = ledger.filter(record=>record.source==="memory-recall");
  assert.equal(receipts.length,1);
  assert.deepEqual(receipts[0].tokens,{input:70,cacheRead:30,output:7});
  assert.match(calls[0].calls[0].result.content[0].text,/M7/);
  await writeMemory(f.dataDir,"SQ29M R01 仅支持 M8 新协议");
  const start = f.requests.length;
  await s.prompt("那最新版呢？");
  const next = f.requests.slice(start);
  assert.ok(!JSON.stringify(next[0]).includes("仅支持 M7"));
  assert.ok(JSON.stringify(next.find(memoryRequest)).includes("M8 新协议"));
  assert.match(currentTools(next.at(-1))[0].content,/M8 新协议/);
  assert.match([...getToolRuns(s).values()][0].calls[0].result.content[0].text,/M7/);
  const preview = await previewPrompt(f.runtime.config, false, []);
  assert.ok(preview.tools.some(tool=>tool.name==="recall_memory"));
  assert.ok(!preview.system.includes("M8 新协议"));
  assert.match(preview.system,/Revision: [a-f0-9]{64}/);
});

test("full recall sends the exact snapshot as a stable prefix across parents and queries", async t => {
  assert.equal(memoryRecallConfig({}, {}).inputMode, "full");
  const f = await setup(t,"full");
  const fact = 'SQ29M R01 仅支持 "M7" 协议\n\n- 路径：sample\\v1\n- 限定：仅测试版';
  await writeMemory(f.dataDir,fact);
  const a = await f.create(false), b = await f.create(false);
  await a.prompt("它支持什么协议？");
  await b.prompt("测试版有区别吗？");
  const [first, second] = f.requests.filter(memoryRequest);
  assert.equal(f.requests.filter(memoryRequest).length,2);
  assert.deepEqual(first.messages.slice(0,-1),second.messages.slice(0,-1));
  assert.notEqual(lastUser(first).content,lastUser(second).content);
  const memory = memoryRows(first);
  assert.deepEqual(memory[0], {ref:"main:mem_target", id:"mem_target", source:"main", kind:"fact", updated:"2026-11-20T00:00:00.000Z", excerpt:fact});
  assert.deepEqual(memory.map(entry=>entry.ref),["main:mem_target","main:mem_other","main:mem_unrelated","extra:mem_extra"]);
  assert.ok(!first.messages[1].content.includes("unknown@example.test"));
});

test("memory get reads the full entry from the current snapshot and removes old reads from later model context", async t => {
  const f = await setup(t,"full");
  const get = (res, id, source) => streamReply(res, {tool:{name:"memory",args:{action:"get",id,source}}});
  f.setModel(async (body,res) => {
    if (memoryRequest(body)) {
      const entry = memoryRows(body).find(e=>e.ref==="main:mem_target");
      await writeMemory(f.dataDir,"SQ29M R01 更新版 M8 协议");
      return recallReply(res,{status:"matched",evidence:[{ref:entry.ref,quote:"M7 协议",scope:"SQ29M R01",relevance:"说明该型号支持的协议"}],notes:""});
    }
    const tools = currentTools(body);
    if (lastUser(body).content.includes("更新版")) return tools.length ? streamReply(res,{text:"已核对更新。"}) : get(res,"mem_target","main");
    if (tools.length === 1) return get(res,"mem_target","main");
    if (tools.length === 2) return get(res,"mem_extra","extra");
    if (tools.length === 3) return get(res,"mem_target","extra");
    return recallFixtureReply(body,res);
  });
  const s = await f.create(false);
  await s.prompt("请核对原文条件");
  const first = [...getToolRuns(s).values()][0].calls;
  assert.equal(f.requests.filter(memoryRequest).length,1);
  assert.equal(JSON.parse(first[1].result.content[0].text).content,"SQ29M R01 仅支持 M7 协议");
  assert.match(JSON.parse(first[2].result.content[0].text).content,/仅客户测试版/);
  assert.match(first[3].result.content[0].text,/not found in this source/);
  const start = f.requests.length;
  await s.prompt("更新版写了什么？");
  assert.ok(!JSON.stringify(f.requests[start]).includes("SQ29M R01 仅支持 M7 协议"));
  assert.match(currentTools(f.requests.at(-1))[0].content,/更新版 M8 协议/);
  assert.match([...getToolRuns(s).values()][0].calls[1].result.content[0].text,/仅支持 M7 协议/);
});

test("invalid model evidence fails without another request or publication", async t => {
  const f = await setup(t);
  f.setModel((body,res)=>{
    if (!memoryRequest(body)) return recallFixtureReply(body,res);
    return recallReply(res,{status:"matched",evidence:[{ref:memoryRows(body)[0].ref,quote:"made-up fact",scope:"",relevance:"claimed match"}],notes:""});
  });
  const s = await f.create(false);
  await s.prompt("它支持什么协议？");
  const result = [...getToolRuns(s).values()][0].calls[0].result.details.memoryTask;
  assert.equal(f.requests.filter(memoryRequest).length,1);
  assert.equal(result.status,"failed");
  assert.deepEqual(result.evidence,[]);
});

test("identical recall queries share one request and budget slot only within the current turn", async t => {
  const f = await onesFixture(t,{extra:{memoryRecall:{enabled:true,maxDelegations:2},ones:{enabled:false}}});
  await writeMemory(f.dataDir);
  const first = {query:"SQ29M R01 协议", identifiers:["SQ29M","R01"]};
  const repeated = {query:" SQ29M R01 协议 ", background:" ", identifiers:["R01"," SQ29M ","R01"]};
  const changed = {...first,background:"确认是客户测试版"};
  f.setModel((body,res)=>{
    if (memoryRequest(body)) return recallReply(res,{status:"no_match",evidence:[],notes:"当前没有可确认的条目。"});
    const tools = currentTools(body);
    const next = lastUser(body).content === "下一轮" ? [first][tools.length] : [first,repeated,changed,first][tools.length];
    if (next) return streamReply(res,{tool:{name:"recall_memory",args:next}});
    return streamReply(res,{text:"目前没有可确认的相关信息。"});
  });
  const s = await f.create(false);
  await s.prompt("核对协议");
  const results = [...getToolRuns(s).values()][0].calls.map(c=>c.result.details.memoryTask);
  assert.equal(f.requests.filter(memoryRequest).length,2);
  assert.deepEqual(results.map(r=>r.reused===true),[false,true,false,true]);
  assert.ok(results.every(r=>r.status==="no_match"));
  assert.equal(results[0].taskId,results[1].taskId);
  assert.equal(results[0].taskId,results[3].taskId);
  assert.notEqual(results[0].taskId,results[2].taskId);
  assert.equal(s.sessionManager.getBranch().filter(e=>e.customType==="memory-delegation-v1").length,2);
  await s.prompt("下一轮");
  assert.equal(f.requests.filter(memoryRequest).length,3);
  assert.equal([...getToolRuns(s).values()][1].calls[0].result.details.memoryTask.reused,undefined);
});

test("a failed recall can be retried with the same inputs", async t => {
  const f = await setup(t);
  let requests = 0;
  f.setModel((body,res)=>{
    if (memoryRequest(body)) {
      if (++requests===1) return recallReply(res,{status:"matched",evidence:[],notes:""});
      return recallFixtureReply(body,res);
    }
    if (currentTools(body).length<2) return streamReply(res,{tool:{name:"recall_memory",args:{query:"SQ29M R01 支持什么协议",identifiers:["SQ29M","R01"]}}});
    return streamReply(res,{text:"已核对。"});
  });
  const s = await f.create(false);
  await s.prompt("它支持什么协议？");
  assert.equal(requests,2);
  const results = [...getToolRuns(s).values()][0].calls.map(c=>c.result.details.memoryTask);
  assert.deepEqual(results.map(r=>r.status),["failed","matched"]);
  assert.ok(results.every(r=>!r.reused));
});

test("failed or cancelled semantic selection cannot publish evidence to another parent", async t => {
  const f = await setup(t);
  const a = await f.create(false), b = await f.create(false);
  let entered = false;
  f.setModel((body,res)=>{
    if (memoryRequest(body) && lastUser(body).content.includes("CANCEL_ONLY")) {entered=true;return;}
    return recallFixtureReply(body,res);
  });
  const task = a.prompt("CANCEL_ONLY");
  await until(()=>entered);
  await b.prompt("CHECK_OTHER");
  await a.abort(); await task;
  assert.ok(f.requests.filter(memoryRequest).every(body=>!(lastUser(body).content.includes("CHECK_OTHER") && lastUser(body).content.includes("CANCEL_ONLY"))));
  const receipt = a.sessionManager.getBranch().find(e=>e.customType==="memory-delegation-v1");
  assert.equal(receipt.data.result.status,"cancelled");
});

test("explicit memory updates require a recalled extra entry and the current revision", async t => {
  const f = await setup(t);
  const s = await f.create(false);
  const memory = await memorySnapshot(f.dataDir);
  const args = {action:"edit",id:"mem_extra",content:"SQ29M R01 更新后的测试条件",expected_revision:memory.extra.revision};
  f.setModel((body,res)=>{
    if (memoryRequest(body)) return recallFixtureReply(body,res);
    const tools = currentTools(body);
    if (!tools.length) return streamReply(res,{tool:{name:"memory",args}});
    if (tools.length === 1) return recallFixtureReply(body,res);
    if (tools.length === 2) return streamReply(res,{tool:{name:"memory",args}});
    return streamReply(res,{text:"更新完成"});
  });
  await s.prompt("请更新 SQ29M R01 的测试条件记忆");
  const calls = [...getToolRuns(s).values()][0].calls;
  assert.equal(calls[0].status,"failed");
  assert.match(calls[0].result.content[0].text,/recall_memory/);
  assert.equal(calls[2].status,"completed");
  assert.match((await memorySnapshot(f.dataDir)).extra.text,/更新后的测试条件/);
});
