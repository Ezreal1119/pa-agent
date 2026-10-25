import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchBudget, BudgetError, budgetTotals, pricingFor } from "../dist/research/budget.js";
import { ResearchLedger } from "../dist/research/ledger.js";
import { ResearchStore, hash, runSummary } from "../dist/research/store.js";
import { ResearchService } from "../dist/research/service.js";
import { registerLeads } from "../dist/research/leads.js";
import { defaults, windowDays } from "../dist/research/domain.js";
const checks = {readableBody:true,dateVerified:true,factsSupported:true,businessLink:true,productSupported:true,consistent:true};
const resourcesDir = path.resolve("resources");
const model = { modelId: "deepseek-flash", baseUrl: "https://api.deepseek.com", apiKey: "unused", maxTokens: 4096, contextWindow: 1000000 };
const price = pricingFor(model);
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-adaptive-")); t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir; }
function run() { return { id:randomUUID(), endDate:"2026-10-25", days:windowDays("2026-10-25"), state:"running", startedAt:new Date().toISOString(), updatedAt:new Date().toISOString(), config:defaults, background:"business",backgroundHash:"x",rulesHash:"rules",candidates:[],coverage:[],leads:[],checkpoints:[],metrics:{modelCalls:0,search:0,fetch:0,inputTokens:0,outputTokens:0},potentialUsed:false,errors:[] }; }
function fixture(date = "2026-10-23") {
  const e = {
    id: randomUUID(),
    kind: "web",
    locator: "https://example.com/news",
    title: "Warehouse deployment",
    content:
      "2026-10-23 New warehouse deployment. Customer installed barcode devices. ".repeat(
        10,
      ),
    fetchedAt: new Date().toISOString(),
    readable: true,
    hash: hash("body"),
  };
  const quote = { evidenceId: e.id, quote: "2026-10-23" };
  const a = {
    title: "仓库部署",
    eventKey: "Customer|Wuhan|deployment",
    disclosureDate: date,
    dateEvidence: quote,
    eventDate: "",
    region: "中国",
    companies: ["Customer"],
    scene: "logistics",
    tags: ["条码"],
    relatedScenes: [],
    facts: [
      {
        claim: "部署扫描设备",
        citations: [
          { evidenceId: e.id, quote: "Customer installed barcode devices." },
        ],
      },
    ],
    deployment: "仓库部署",
    competition: { status: "undisclosed", detail: "未披露", citations: [] },
    urovo: { relevance: "仓储识别和移动作业", productClaims: [] },
    brief: { news: "仓库部署条码采集", sales: "了解具体作业流程" },
    detail: {
      analysis: "现场采集需求",
      sales: "询问扫描环境与软件集成条件",
      questions: ["设备要求是什么？"],
      limitations: ["品牌未披露"],
    },
    relatedIds: [],
    status: "active",
  };
  const c = {
    id: randomUUID(),
    action: "new",
    reason: "新事件",
    article: a,
    submittedAt: new Date().toISOString(),
  };
  const v = {
    candidateId: c.id,
    approve: true,
    unresolvedIssues: [],
    scores: {
      relevance: 4,
      commercial: 4,
      evidence: 4,
      importance: 3,
      novelty: 4,
    },
    checks,
    material: true,
    reason: "正文证据与业务相关",
  };
  return { e, c, v };
}

test("reservations bound concurrency, preserve review money and retain missing/canceled usage across restart", async t => {
  const dir = await temp(t); const file = path.join(dir,"budget.json");
  const state = { limitCny: 1, pricing:price,charges:[] };
  const b = new ResearchBudget(state, () => fs.writeFile(file,JSON.stringify(state)));
  const got = await Promise.allSettled(Array.from({length:20},()=>b.reserve("fetch","research",.1)));
  assert.equal(got.filter(r=>r.status==="fulfilled").length,7);
  assert.ok(budgetTotals(state).reservedCny <= .75);
  const id = got.find(r=>r.status==="fulfilled").value;
  await b.usage(id,{input:0,output:0,cacheRead:0,cacheWrite:0});
  const recovered = JSON.parse(await fs.readFile(file,"utf8"));
  assert.ok(budgetTotals(recovered).reservedCny > .69);
  const restarted = new ResearchBudget(recovered,async()=>{});
  await assert.rejects(restarted.reserve("model","research",.1),BudgetError);
  await restarted.reserve("model","review",.2);
  assert.ok(budgetTotals(recovered).availableCny < .11);
});
test("exact cache accounting, reasoning not double-counted, output cap, duplicate settlement and fail-closed prices", async () => {
  const state={limitCny:3,pricing:price,charges:[]};const b=new ResearchBudget(state,async()=>{});
  const p=await b.model({messages:[{role:"user",content:"销售"}]},"research",1000);
  await b.usage(p.id,{input:100,cacheRead:900,cacheWrite:20,output:50,reasoning:40});
  assert.equal(budgetTotals(state).spentCny,(120*2+900*.04+50*8)/1e6);
  assert.equal(budgetTotals(state).cacheHitTokens,900);
  await b.usage(p.id,{input:9999,output:999});
  assert.equal(budgetTotals(state).outputTokens,50);
  const q=await b.model({messages:[{role:"user",content:"x"}],max_completion_tokens:100000},"discovery",100000);
  assert.ok(q.payload.max_completion_tokens<100000);
  assert.ok(budgetTotals(state).discoveryCny<=.6);
  await assert.rejects(b.model({messages:[{content:"x".repeat(10000000)}]},"research",200),BudgetError);
  assert.throws(()=>pricingFor({...model,modelId:"unknown"}),/价格配置/);
  assert.throws(()=>pricingFor({...model,baseUrl:"https://proxy.example"}),/价格配置/);
  assert.throws(()=>pricingFor(model,{...price,input:0}),/无效/);
});
test("aggregate validation ceiling survives independent runners, retries and restarts", async t => {
  const dir=await temp(t);const group={file:path.join(dir,"total.json"),limitCny:.9};
  const create=()=>new ResearchBudget({limitCny:3,pricing:price,charges:[]},async()=>{},group);
  const a=create(),b=create();
  const results=await Promise.allSettled([a.reserve("model","research",.5),b.reserve("model","research",.5)]);
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
  await assert.rejects(create().reserve("model","research",.5),/总预算/);
  assert.equal(Object.values(JSON.parse(await fs.readFile(group.file,"utf8")).charges).reduce((a,b)=>a+b,0),.5);
});
test("cross-run evidence, rejected cooldown, changed sources/rules, TTL and historical import", async t => {
  const store=new ResearchStore(await temp(t));await store.init();
  const r=run();registerLeads(r,[{url:"https://example.com/a",title:"RFID",summary:"Pilot",date:"2026-10-23"}],"retail");
  const l=r.leads[0];l.classification="irrelevant";l.state="deferred";l.attemptedAt=new Date().toISOString();
  const e={id:randomUUID(),kind:"web",locator:l.url,title:l.title,content:"2026-10-23 Actual readable body. ".repeat(20),fetchedAt:new Date().toISOString(),hash:"hash",readable:true};
  await store.saveRun(r);await store.evidence(r.id,e);
  const ledger=new ResearchLedger(store);await ledger.init();
  const next=run();ledger.hydrate(next,"rules");assert.equal(next.leads[0].cooldown,true);
  assert.equal((await ledger.cached(l.url,next.leads[0])).id,e.id);
  assert.equal(await ledger.cached(l.url,next.leads[0],Date.now()+86400001),undefined);
  registerLeads(next,[{url:l.url,title:"RFID",summary:"Scale deployment",date:"2026-10-23"}],"retail");
  ledger.refresh(next.leads[0],"rules");
  assert.equal(next.leads[0].state,"unread");assert.equal(next.leads[0].cooldown,false);
  await ledger.sync(next,"rules");
  assert.equal(await ledger.cached(l.url,next.leads[0]),undefined,"changed snippet must not revive old evidence after sync");
  const changed=run();ledger.hydrate(changed,"new rules");assert.equal(changed.leads[0].cooldown,false);
  const expired=run();ledger.hydrate(expired,"rules",Date.now()+8*86400000);assert.equal(expired.leads[0].cooldown,false);
  assert.equal(next.reuse.fullSweepDue,true,"unknown search history cannot claim coverage");
});
test("adaptive batches keep evidence gates, fresh workers, early exit and cross-run reuse",async t=>{
  const dir=await temp(t);let workers=0;let discovered=0;const f=fixture();
  const engine={ready(){},
    async discover(ctx){discovered++;registerLeads(ctx.run,[{url:f.e.locator,title:"Warehouse",summary:"Deployment",date:"2026-10-23"}],"logistics");ctx.ledger.refresh(ctx.run.leads[0],ctx.run.rulesHash);},
    async worker(ctx){workers++;return {async step(prompt){assert.equal(ctx.batchLeadIds.length,1);assert.ok(!prompt.includes(f.e.content));ctx.evidence.set(f.e.id,f.e);ctx.run.leads[0].evidenceId=f.e.id;ctx.run.leads[0].state="submitted";ctx.run.candidates.push({...f.c,id:randomUUID()});},async close(){}};},
    async review(ctx,ids){return {verdicts:ids.map(id=>({...f.v,candidateId:id})),nextDirections:[],summary:"verified"};}};
  const s=new ResearchService({dataDir:dir,resourcesDir,engine:()=>engine});await s.init();
  await s.start("2026-10-25");await s.wait();
  const first=(await s.store.runs())[0];assert.equal(first.state,"completed");assert.equal(first.phase,"done");assert.equal(workers,1);assert.equal(first.checkpoints[0].changes.length,1);assert.ok(Date.parse(first.finishedAt)-Date.parse(first.startedAt)<1000);
  await s.start("2026-10-25");await s.wait();assert.equal(workers,1,"unchanged accepted lead must not trigger deep research");assert.equal(discovered,2);assert.equal((await s.store.items()).length,1);
  await s.close();
});
test("two empty batches stop without losing unprocessed leads, no forced five-minute spend",async t=>{
  let workers=0;const s=new ResearchService({dataDir:await temp(t),resourcesDir,engine:()=>({ready(){},async discover(ctx){registerLeads(ctx.run,Array.from({length:9},(_,i)=>({url:`https://example.com/${i}`,title:`deployment${i}`,summary:"RFID",date:"2026-10-23"})),"retail");},async worker(ctx){workers++;assert.equal(ctx.batchLeadIds.length,3);return {async step(){},async close(){}};},async review(){throw Error("no candidates");}})});
  await s.init();await s.start("2026-10-25");await s.wait();const r=(await s.store.runs())[0];assert.equal(workers,2);assert.match(r.stopReason,/连续两批/);assert.equal(r.leads.filter(l=>l.state==="unread").length,3);assert.equal(r.checkpoints.length,2);await s.close();
});
test("discovery exhaustion transitions to reviewable batches and no-evidence candidates cannot publish",async t=>{
  const f=fixture();const engine={ready(){},pricing:()=>price,async discover(ctx){registerLeads(ctx.run,[{url:f.e.locator,title:"Deployment",date:"2026-10-23"}],"logistics");throw new BudgetError("发现阶段预算已到");},async worker(ctx){return {async step(){ctx.run.candidates.push(f.c);},async close(){}};},async review(){return {verdicts:[f.v],nextDirections:[],summary:"claimed approval"};}};
  const s=new ResearchService({dataDir:await temp(t),resourcesDir,engine:()=>engine});await s.init();await s.start("2026-10-25");await s.wait();assert.equal((await s.store.items()).length,0);const r=(await s.store.runs())[0];assert.match(r.candidates[0].outcome,/未入库/);assert.equal(runSummary(r).budget.limitCny,3);assert.ok(!("charges" in runSummary(r).budget));await s.close();
});

test("real SDK transport reserves before HTTP, settles streaming usage, keeps System stable and does not retry HTTP 503",async t=>{
  const {createServer}=await import("node:http");const {once}=await import("node:events");const {createResearchEngine}=await import("../dist/research/agent.js");
  const dir=await temp(t);const store=new ResearchStore(dir);await store.init();const r=run();r.phase="discovery";r.instructions={"discovery.md":"FROZEN DISCOVERY SNAPSHOT. Use only the provided tools."};await store.saveRun(r);
  const state={limitCny:3,pricing:price,charges:[]};const budget=new ResearchBudget(state,async()=>{});const payloads=[];let failed=false;
  const server=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;const p=JSON.parse(text);payloads.push(p);assert.ok(state.charges.some(c=>c.actual===undefined),"no request before durable reservation");
    if(failed){res.writeHead(503);res.end("unavailable");return;}
    res.writeHead(200,{"content-type":"text/event-stream"});
    for(const chunk of [{choices:[{index:0,delta:{role:"assistant",content:"done"},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1000,completion_tokens:50,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200}}])res.write(`data: ${JSON.stringify({id:"test",model:"fixture",...chunk})}\n\n`);
    res.end("data: [DONE]\n\n");});
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const engine=createResearchEngine({dataDir:dir,resourcesDir,model:()=>({...model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}),web:()=>({apiKey:"unused"})});
  const ctx={run:r,store,budget,evidence:new Map(),signal:new AbortController().signal,boundary:()=>true,wrapping:()=>false,save:()=>store.saveRun(r)};
  const w=await engine.worker(ctx);try {await w.step("first");await w.step("second: budget and phase changed");const systems=payloads.map(p=>p.messages.filter(m=>m.role==="system"));assert.deepEqual(systems[0],systems[1]);assert.ok(JSON.stringify(systems[0]).includes("FROZEN DISCOVERY SNAPSHOT"));assert.ok(!("instructions" in runSummary(r)));assert.equal(budgetTotals(state).cacheHitTokens,1600);assert.equal(budgetTotals(state).cacheMissTokens,400);assert.equal(budgetTotals(state).outputTokens,100);
    failed=true;await assert.rejects(w.step("fail"));assert.equal(payloads.length,3,"provider retry must be disabled");assert.ok(budgetTotals(state).reservedCny>0,"uncertain failed model request remains reserved");
  }finally{await w.close();}
});

test("unavailable URLs cool down for one day, changed summaries reopen, older windows do not lose new results",async t=>{
  const store=new ResearchStore(await temp(t));await store.init();const ledger=new ResearchLedger(store);await ledger.init();
  const r=run();registerLeads(r,[{url:"https://example.com/missing",title:"Retail",summary:"Unchanged",date:"2026-10-01"}],"retail");r.leads[0].state="unavailable";r.leads[0].attemptedAt=new Date().toISOString();await ledger.sync(r,"rules");
  const next=run();ledger.hydrate(next,"rules");assert.equal(next.leads.length,0,"outside-window ledger need not fill the context");
  registerLeads(next,[{url:r.leads[0].url,title:"Retail",summary:"Unchanged",date:"2026-10-01"}],"retail");ledger.refresh(next.leads[0],"rules");assert.equal(next.leads[0].cooldown,true,"global URL history must apply even when not hydrated");
  registerLeads(next,[{url:r.leads[0].url,title:"Retail",summary:"New details",date:"2026-10-23"}],"retail");ledger.refresh(next.leads[0],"rules");assert.equal(next.leads[0].state,"unread");
  const again=run();registerLeads(again,[{url:r.leads[0].url,title:"Retail",summary:"Unchanged",date:"2026-10-01"}],"retail");ledger.refresh(again.leads[0],"rules",Date.now()+86400001);assert.ok(!again.leads[0].cooldown);
});
test("coverage expires per scenario, unknown directions stay due, seven-day backfill is manual-run only",async t=>{
  const store=new ResearchStore(await temp(t));await store.init();const ledger=new ResearchLedger(store);await ledger.init();const r=run();
  r.coverage=Object.keys((await import("../dist/research/domain.js")).scenes).map(scene=>({scene,from:r.days[0],to:r.endDate,query:"public keywords",at:new Date().toISOString(),resultCount:0}));await ledger.sync(r,"rules");
  const next=run();ledger.hydrate(next,"rules");assert.equal(next.reuse.fullSweepDue,false);assert.deepEqual(next.reuse.dueScenes,[]);
  ledger.hydrate(next,"rules",Date.now()+7*86400000+100);assert.equal(next.reuse.dueScenes.length,7);
  next.endDate="2026-10-26";next.days=windowDays(next.endDate);ledger.hydrate(next,"rules");assert.equal(next.reuse.fullSweepDue,false,"one new day must not force an expensive fourteen-day sweep");assert.ok(next.reuse.gaps.every(g=>g.days.includes("2026-10-26")));
});

test("unexpected usage overruns persist actual group cost and block subsequent sessions",async t=>{
  const dir=await temp(t);const aggregate={file:path.join(dir,"group.json"),limitCny:9};const state={limitCny:3,pricing:price,charges:[]};const b=new ResearchBudget(state,async()=>{},aggregate);
  const id=await b.reserve("model","research",.01);await assert.rejects(b.settle(id,.02),/超出保守预留/);assert.equal(state.overrun,true);assert.equal(b.available("review"),0);
  const other=new ResearchBudget({limitCny:3,pricing:price,charges:[]},async()=>{},aggregate);await assert.rejects(other.reserve("model","research",.01),/超出预留/);const ledger=JSON.parse(await fs.readFile(aggregate.file,"utf8"));assert.equal(ledger.charges[id],.02);
});

test("batch selection may choose a later competitor instead of URL arrival order",async t=>{
  const dir=await temp(t);let selections=0;let chosen=[];const s=new ResearchService({dataDir:dir,resourcesDir,engine:()=>({ready(){},async discover(ctx){registerLeads(ctx.run,Array.from({length:5},(_,i)=>({url:`https://example.com/${i}`,title:i===4?"New direct competitor handheld":"Generic news",summary:"metadata",date:"2026-10-23"})),"retail");},async select(ctx,ids){selections++;return [ids.at(-1)];},async worker(ctx){chosen.push(ctx.run.leads.find(l=>l.id===ctx.batchLeadIds[0]).title);return{async step(){},async close(){}};},async review(){throw Error("no candidates");}})});
  await s.init();await s.start("2026-10-25");await s.wait();assert.equal(selections,2);assert.equal(chosen[0],"New direct competitor handheld");assert.equal(chosen.length,2);await s.close();
});
test("discovery budget exhaustion before any search cannot be reported as no news",async t=>{
  const s=new ResearchService({dataDir:await temp(t),resourcesDir,engine:()=>({ready(){},async discover(){throw new BudgetError("预算不足");},async worker(){throw Error("should not run");},async review(){throw Error("should not run");}})});await s.init();await s.start("2026-10-25");await s.wait();const r=(await s.store.runs())[0];assert.match(r.stopReason,/仍有方向未检索/);assert.equal(r.metrics.search,0);await s.close();
});

test("a fixable but rejected factual story receives one evidence-only repair and a fresh independent review",async t=>{
  const dir=await temp(t);const f=fixture();let workers=0,reviews=0;
  const s=new ResearchService({dataDir:dir,resourcesDir,engine:()=>({ready(){},async discover(ctx){registerLeads(ctx.run,[{url:f.e.locator,title:"Warehouse",date:"2026-10-23"}],"logistics");},async worker(ctx){workers++;return{async step(){ctx.evidence.set(f.e.id,f.e);if(ctx.repairCandidateIds){assert.equal(ctx.repairCandidateIds[0],f.c.id);ctx.run.candidates.push({...structuredClone(f.c),id:randomUUID(),outcome:undefined,repairOf:f.c.id,reason:"Removed unsupported flourish"});}else{ctx.run.candidates.push(f.c);ctx.run.leads[0].evidenceId=f.e.id;ctx.run.leads[0].state="submitted";}},async close(){}};},async review(ctx,ids){reviews++;return{verdicts:ids.map(id=>({...f.v,candidateId:id,approve:reviews>1,checks:{...checks,consistent:reviews>1},unresolvedIssues:reviews>1?[]:["Delete unsupported leading claim"]})),nextDirections:[],summary:"independent"};}})});
  await s.init();await s.start("2026-10-25");await s.wait();assert.equal(workers,2);assert.equal(reviews,2);assert.equal((await s.store.items()).length,1);const r=(await s.store.runs())[0];assert.match(r.candidates[0].outcome,/未入库/);assert.equal(r.candidates[1].outcome,"已入库");assert.equal(r.candidates[1].repairOf,f.c.id);await s.close();
});

test("saving a transient cooldown in another run cannot forget the source failure timestamp",async t=>{
  const store=new ResearchStore(await temp(t));await store.init();const ledger=new ResearchLedger(store);await ledger.init();const r=run();registerLeads(r,[{url:"https://example.com/blocked",title:"Deployment",summary:"metadata",date:"2026-10-23"}],"retail");r.leads[0].state="unavailable";r.leads[0].attemptedAt=new Date().toISOString();await ledger.sync(r,"rules");
  const second=run();ledger.hydrate(second,"rules");assert.equal(second.leads[0].state,"deferred");await ledger.sync(second,"rules");
  const third=run();ledger.hydrate(third,"rules");assert.equal(third.leads[0].cooldown,true);ledger.hydrate(third,"rules",Date.now()+86400001);assert.equal(third.leads[0].cooldown,false);
});

test("two consecutive invalid candidate tool calls stop the batch before another paid request",async t=>{
  const {createServer}=await import("node:http");const {once}=await import("node:events");const {createResearchEngine}=await import("../dist/research/agent.js");const dir=await temp(t);const store=new ResearchStore(dir);await store.init();const r=run();r.phase="research";await store.saveRun(r);let calls=0;
  const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{"content-type":"text/event-stream"});res.write(`data: ${JSON.stringify({id:"fixture",model:"fixture",choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:`bad-${calls}`,type:"function",function:{name:"submit_candidate",arguments:JSON.stringify({action:"new",reason:"bad",article:{unexpected:"field"}})}}]},finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:"fixture",model:"fixture",choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})}\n\n`);res.end("data: [DONE]\n\n");});server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const engine=createResearchEngine({dataDir:dir,resourcesDir,model:()=>({...model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}),web:()=>({apiKey:"unused"})});const ctx={run:r,store,evidence:new Map(),signal:new AbortController().signal,boundary:()=>false,wrapping:()=>false,save:()=>store.saveRun(r)};const worker=await engine.worker(ctx);try{await assert.rejects(worker.step("submit validated candidate"),/候选提交连续两次无效/);assert.equal(calls,2);assert.equal(r.candidates.length,0);}finally{await worker.close();}
});

test("a productive batch hitting its transcript reservation limit can continue with a fresh affordable batch",async t=>{
  const f=fixture();let workers=0;const s=new ResearchService({dataDir:await temp(t),resourcesDir,engine:()=>({ready(){},pricing:()=>price,async discover(ctx){registerLeads(ctx.run,Array.from({length:6},(_,i)=>({url:`https://example.com/${i}`,title:`deployment${i}`,date:"2026-10-23"})),"retail");},async worker(ctx){workers++;return{async step(){if(workers===1){ctx.evidence.set(f.e.id,f.e);ctx.run.candidates.push(f.c);throw new BudgetError("剩余额度不足以安全发起模型请求，保留待处理线索");}},async close(){}};},async review(ctx,ids){return{verdicts:ids.map(id=>({...f.v,candidateId:id})),nextDirections:[],summary:"verified"};}})});await s.init();await s.start("2026-10-25");await s.wait();assert.equal(workers,2);assert.equal((await s.store.items()).length,1);await s.close();
});

test("cross-run date uncertainty survives restart and cannot be washed away by another approval",async t=>{
  const dir=await temp(t);const store=new ResearchStore(dir);await store.init();const ledger=new ResearchLedger(store);await ledger.init();const f=fixture();f.e.hash=hash(f.e.content);await ledger.capture(f.e);await ledger.disputeDate(f.e,"rules","This year versus next-year timeline conflicts; original disclosure year unclear");
  const restart=new ResearchLedger(store);await restart.init();assert.ok(restart.unresolvedDate(f.e,"rules"));assert.ok(restart.priorOutcomes([f.e.locator])[0].dateDispute);
  assert.equal(restart.unresolvedDate({...f.e,hash:hash("new primary publication evidence")},"rules"),undefined);assert.equal(restart.unresolvedDate(f.e,"revised rules"),undefined);
  let calls=0;const service=new ResearchService({dataDir:dir,resourcesDir,engine:()=>({ready(){},async discover(ctx){calls++;registerLeads(ctx.run,[{url:f.e.locator,title:"Warehouse",summary:"news",date:"2026-10-23"}],"logistics");await ctx.ledger.capture(f.e);await ctx.ledger.disputeDate(f.e,ctx.run.rulesHash,"Publication year unresolved in prior review");},async worker(ctx){return{async step(){ctx.evidence.set(f.e.id,f.e);ctx.run.candidates.push({...f.c,id:randomUUID(),outcome:undefined});},async close(){}};},async review(ctx,ids){return{verdicts:ids.map(id=>({...f.v,checks:{...checks},candidateId:id})),nextDirections:[],summary:"incorrectly ignored prior date issue"};}})});await service.init();await service.start("2026-10-25");await service.wait();assert.equal((await service.store.items()).length,0);assert.match((await service.store.runs())[0].candidates[0].outcome,/跨次日期疑点/);await service.close();
});

test("switching dateEvidence to another already-rejected source does not resolve a publication-year dispute",async t=>{
 const f=fixture();f.e.hash=hash(f.e.content);const other={...f.e,id:randomUUID(),locator:"https://example.com/reprint"};let round=0;
 const service=new ResearchService({dataDir:await temp(t),resourcesDir,engine:()=>({ready(){},async discover(ctx){round++;registerLeads(ctx.run,[{url:f.e.locator,title:"Warehouse",summary:"news",date:"2026-10-23"}],"logistics");},async worker(ctx){return{async step(){ctx.evidence.set(f.e.id,f.e);ctx.evidence.set(other.id,other);await ctx.ledger.capture(f.e);await ctx.ledger.capture(other);const c=structuredClone(f.c);c.id=randomUUID();c.article.facts[0].citations.push({evidenceId:other.id,quote:"Customer installed barcode devices."});if(round>1)c.article.dateEvidence.evidenceId=other.id;ctx.run.candidates.push(c);ctx.run.leads[0].state="submitted";ctx.run.leads[0].evidenceId=f.e.id;},async close(){}};},async review(ctx,ids){return{verdicts:ids.map(id=>({...f.v,candidateId:id,approve:round>1,checks:{...checks,dateVerified:round>1},reason:round>1?"approved without resolving year":"publication year unresolved across original and reprint"})),nextDirections:[],summary:"date review"};}})});
 await service.init();await service.start("2026-10-25");await service.wait();await service.start("2026-10-25");await service.wait();assert.equal((await service.store.items()).length,0);assert.ok((await service.store.runs()).some(r=>r.candidates.some(c=>c.outcome?.includes("跨次日期疑点"))));await service.close();
});

test("obsolete minimum/checkpoint environment settings cannot keep adaptive production research running",async()=>{
 const {config}=await import("../dist/research/domain.js");const value=config({RESEARCH_INITIAL_MS:"-1",RESEARCH_CHECKPOINT_MS:"invalid",RESEARCH_BUDGET_CNY:"2",RESEARCH_MAX_MS:"30000",RESEARCH_WRAP_MS:"10000",RESEARCH_REVIEW_MS:"5000"});assert.equal(value.initialMs,defaults.initialMs);assert.equal(value.checkpointMs,defaults.checkpointMs);assert.equal(value.budgetCny,2);
});

test("v1 ledgers re-import historical date rejections when upgrading to the dispute-aware ledger",async t=>{
 const dir=await temp(t);const store=new ResearchStore(dir);await store.init();const r=run(),f=fixture();r.state="completed";r.candidates=[f.c];r.checkpoints=[{review:{verdicts:[{...f.v,approve:false,checks:{...checks,dateVerified:false},reason:"historical ambiguous disclosure year"}]}}];await store.saveRun(r);await store.evidence(r.id,f.e);await fs.mkdir(path.join(store.root,"ledger"),{recursive:true});await fs.writeFile(path.join(store.root,"ledger/state.json"),JSON.stringify({version:1,entries:{},coverage:[],imported:[r.id]}));const ledger=new ResearchLedger(store);await ledger.init();assert.ok(ledger.unresolvedDate(f.e,r.rulesHash));assert.equal(JSON.parse(await fs.readFile(path.join(store.root,"ledger/state.json"),"utf8")).version,2);
});
