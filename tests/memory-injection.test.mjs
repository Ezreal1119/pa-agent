import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { MemoryInjectionService } from "../dist/memory-injection/service.js";
import { parseMemoryEntries } from "../dist/agent/extra-memory.js";
import { mainMemoryFile, extraMemoryFile } from "../dist/agent/memory-paths.js";
import { knowledgeLock } from "../dist/knowledge-sync/core.js";
import { createWebServer } from "../dist/web/server.js";

const entry = (id, content) => `## Memory ${id}\n\n- Kind: fact\n- Created-By-Email: original@example.com\n- Created: 2026-01-01T00:00:00+08:00\n- Updated: 2026-01-01T00:00:00+08:00\n\n### Content\n\n### ${content}\n\n`;
const proposal = operations => ({summary: "管理员记忆预览", questions: [], operations});
const addition = content => ({action: "add", content: `### ${content}`, reason: "管理员提供的新事实"});
async function wait(service, id, expected) {
  for (let i = 0; i < 200; i++) {
    const job = await service.get(id);
    if (!['planning', 'committing'].includes(job.status)) {
      if (expected) assert.equal(job.status, expected, job.error);
      return job;
    }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("Memory operation timed out");
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-injection-"));
  const dataDir = path.join(root, ".data");
  const main = mainMemoryFile(dataDir), extra = extraMemoryFile(dataDir);
  await fs.mkdir(path.dirname(main), {recursive: true});
  const before = `# Skill Memories\n\n${entry('mem_a', 'Alpha')}${entry('mem_b', 'Beta')}${entry('mem_c', 'Unrelated raw text')}`;
  await fs.writeFile(main, before);
  await fs.writeFile(extra, "EXTRA FILE MUST STAY UNCHANGED");
  let response = proposal([addition("New fact")]);
  let handler;
  const options = {dataDir, modelId: () => "fixture", redact: error => error.message, planner: () => input => handler ? handler(input) : Promise.resolve(response)};
  let service = new MemoryInjectionService(options);
  await service.init();
  t.after(async () => { await service.close(); await fs.rm(root, {recursive: true, force: true}); });
  return {root, dataDir, main, extra, before, get service() {return service;}, set response(value) {response = value;}, set handler(value) {handler = value;}, async restart() {await service.close(); service = new MemoryInjectionService(options); await service.init();}};
}

test("main-memory batch preview is read-only; confirmation preserves metadata/unrelated bytes, backs up and never writes extra memory", async t => {
  const f = await fixture(t);
  f.response = proposal([{action: "update", id: "mem_a", content: "### Corrected Alpha", reason: "更正"}, {action: "delete", id: "mem_b", reason: "删除旧条目"}, addition("New fact")]);
  const job = await f.service.preview("更正Alpha，删除Beta，并记录New fact");
  const ready = await wait(f.service, job.id, "ready");
  assert.equal(await fs.readFile(f.main, "utf8"), f.before);
  assert.deepEqual(ready.changes.map(c => c.action), ['update', 'delete', 'add']);
  assert.match(ready.changes[0].after, /Created-By-Email: original@example.com/);
  assert.match(ready.changes[0].after, /Created: 2026-01-01T00:00:00\+08:00/);
  assert.match(ready.changes[2].after, /unknown@email.com/);
  assert.equal(ready.next, undefined);
  await f.service.confirm(job.id);
  const committed = await wait(f.service, job.id, "committed");
  const after = await fs.readFile(f.main, "utf8");
  assert.ok(after.includes(entry('mem_c', 'Unrelated raw text')));
  assert.ok(!after.includes("mem_b"));
  assert.equal(parseMemoryEntries(after).length, 3);
  assert.equal(await fs.readFile(committed.backup, "utf8"), f.before);
  assert.equal(await fs.readFile(f.extra, "utf8"), "EXTRA FILE MUST STAY UNCHANGED");
  assert.equal((await f.service.confirm(job.id)).status, "committed");
  assert.equal(await fs.readFile(f.main, "utf8"), after);
  await f.restart();
  assert.equal((await f.service.get(job.id)).status, "committed");
});

test("ambiguous, malformed, duplicated-target and path-directed plans cannot be confirmed or change files", async t => {
  const f = await fixture(t);
  f.response = {summary: "无法定位", questions: ["要删除哪一条？"], operations: []};
  const job = await f.service.preview("删除之前的那条");
  assert.equal((await wait(f.service, job.id)).status, "needs_clarification");
  await assert.rejects(f.service.confirm(job.id), /ready preview/);
  for (const operations of [
    [{action: "delete", id: "mem_unknown", reason: "bad"}],
    [{action: "delete", id: "mem_a", reason: "first"}, {action: "delete", id: "mem_a", reason: "twice"}],
    [{...addition("Attack"), path: f.extra}],
    [{...addition("Attack"), id: "mem_assigned_by_model"}],
    [{action: "update", id: "mem_a", reason: "bad body", content: "## Memory mem_hijack"}],
  ]) {
    f.response = proposal(operations);
    const bad = await f.service.preview("管理员请求");
    await wait(f.service, bad.id, "failed");
    assert.equal(await fs.readFile(f.main, "utf8"), f.before);
  }
});

test("stale/expired previews reject publication and a write waits for active knowledge readers", async t => {
  const f = await fixture(t);
  const first = await f.service.preview("添加事实"); await wait(f.service, first.id, "ready");
  await fs.writeFile(f.main, f.before + "\n");
  await f.service.confirm(first.id); await wait(f.service, first.id, "conflict");
  assert.equal(await fs.readFile(f.main, "utf8"), f.before + "\n");
  const expired = await f.service.preview("添加事实"); await wait(f.service, expired.id, "ready");
  const file = path.join(f.dataDir, "memory-injection", `${expired.id}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")); record.expires = 0; await fs.writeFile(file, JSON.stringify(record));
  await assert.rejects(f.service.confirm(expired.id), /expired/);
  const next = await f.service.preview("添加事实"); await wait(f.service, next.id, "ready");
  const release = await knowledgeLock(path.join(f.dataDir, "urovo-product-expert")).read();
  try {
    await f.service.confirm(next.id);
    assert.equal((await f.service.get(next.id)).status, "committing");
    assert.equal(await fs.readFile(f.main, "utf8"), f.before + "\n");
  } finally {release();}
  await wait(f.service, next.id, "committed");
});

test("restart recovers a published confirmation receipt and interrupted planning without repeating writes", async t => {
  const f = await fixture(t);
  const first = await f.service.preview("添加事实"); await wait(f.service, first.id, "ready");
  await f.service.close();
  const file = path.join(f.dataDir, "memory-injection", `${first.id}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")); record.status = "committing";
  await fs.writeFile(file, JSON.stringify(record)); await fs.writeFile(f.main, record.next);
  await f.restart();
  assert.equal((await f.service.get(first.id)).status, "committed");
  const raw = await fs.readFile(f.main, "utf8");
  await f.service.confirm(first.id);
  assert.equal(await fs.readFile(f.main, "utf8"), raw);
  record.status = "planning"; await fs.writeFile(file, JSON.stringify(record));
  await f.restart();
  assert.equal((await f.service.get(first.id)).status, "failed");
});

test("linked/malformed main memory and backup directories fail closed; shutdown cancels pending previews", async t => {
  const f = await fixture(t);
  await fs.rm(f.main); await fs.symlink(f.extra, f.main);
  await assert.rejects(f.service.preview("添加事实"), /Linked/);
  await fs.rm(f.main); await fs.writeFile(f.main, "malformed original");
  await assert.rejects(f.service.preview("添加事实"), /format/);
  await fs.writeFile(f.main, f.before);
  const job = await f.service.preview("添加事实"); await wait(f.service, job.id, "ready");
  await fs.symlink(path.dirname(f.main), path.join(f.dataDir, "maintenance-backups"));
  await f.service.confirm(job.id); await wait(f.service, job.id, "failed");
  assert.equal(await fs.readFile(f.main, "utf8"), f.before);
  await fs.rm(path.join(f.dataDir, "maintenance-backups"));
  f.handler = ({signal}) => new Promise((resolve, reject) => {signal.addEventListener('abort', () => reject(new Error('Preview cancelled')), {once:true});});
  const pending = await f.service.preview("等待");
  await assert.rejects(f.service.preview("重复点击"), /already running/);
  await f.service.close();
  assert.equal((await f.service.get(pending.id)).status, "failed");
  assert.equal(await fs.readFile(f.extra, "utf8"), "EXTRA FILE MUST STAY UNCHANGED");
});

test("administrator HTTP and real Pi model isolate main-memory preview/confirmation from Cookie-less, CSRF and machine clients", {timeout: 30000}, async t => {
  let app, model;
  t.after(async () => {await app?.close();model?.closeAllConnections();if(model)await new Promise(r=>model.close(r));});
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dataDir, "urovo-product-expert"));
  await fs.writeFile(path.join(f.dataDir, "urovo-product-expert/SKILL.md"), "PRIVATE SKILL SHOULD NOT ENTER THE PREVIEW AGENT");
  const payloads = [];
  model = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    assert.equal(req.headers.authorization, 'Bearer fixture-model-key');
    const body = JSON.parse(input); payloads.push(body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.tools.map(t => t.function.name), ['preview_main_memory']);
    const hasResult = body.messages.at(-1).role === 'tool';
    const delta = hasResult ? {content: 'Preview ready'} : {tool_calls: [{index: 0, id: 'preview_1', type:'function', function:{name:'preview_main_memory', arguments: JSON.stringify(proposal([addition('ADMIN APPROVED FACT')]))}}]};
    res.writeHead(200, {'content-type':'text/event-stream'});
    for (const [value, end] of [[{role:'assistant'},null],[delta,null],[{},hasResult?'stop':'tool_calls']]) res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:value,finish_reason:end}],...(end?{usage:{prompt_tokens:44,completion_tokens:12}}:{})})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  app = await createWebServer({cwd:f.root,dataDir:f.dataDir,resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'secret'},bridgeToken:'bridge-test-key-01234567890123456789',mcp:{apiKey:'mcp-test-key'},model:{apiKey:'fixture-model-key',modelId:'deepseek-flash',baseUrl:`http://127.0.0.1:${model.address().port}/v1`}});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const token=(await(await fetch(base+'/api/auth/status')).json()).token;
  for (const key of ['bridge-test-key-01234567890123456789','mcp-test-key']) assert.equal((await fetch(base+'/api/memory-injection/previews',{method:'POST',headers:{'x-local-token':token,Authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({prompt:'attack'})})).status,401);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'x-local-token':token,'content-type':'application/json'},body:JSON.stringify({account:'admin',password:'secret'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(route,method='GET',body,extra={})=>fetch(base+route,{method,headers:{Cookie:cookie,'x-local-token':token,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const home=await(await request('/')).text(); assert.ok(home.indexOf('Memory Injection')<home.indexOf('Synchronize'));
  assert.equal((await request('/memory-injection.js')).status,200);
  assert.equal((await request('/memory-injection.css')).status,200);
  assert.equal((await request('/api/memory-injection/previews','POST',{prompt:'fact'},{'x-local-token':''})).status,403);
  assert.equal((await request('/api/memory-injection/previews','POST',{prompt:'fact'},{Origin:'https://evil.invalid'})).status,403);
  assert.equal(payloads.length,0);
  assert.equal((await request('/api/memory-injection/previews','POST',{prompt:'fact',path:f.extra})).status,400);
  let res=await request('/api/memory-injection/previews','POST',{prompt:'请记住这条事实'});assert.equal(res.status,202);const created=await res.json();
  let job;
  for(let i=0;i<200;i++){job=await(await request(`/api/memory-injection/previews/${created.id}`)).json();if(job.status!=='planning')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'ready',job.error);assert.ok(job.usage.input>0);
  assert.ok(payloads.every(p=>p.reasoning_effort==='low'));
  assert.ok(!JSON.stringify(payloads).includes('EXTRA FILE MUST STAY UNCHANGED'));
  assert.ok(!JSON.stringify(payloads).includes('PRIVATE SKILL SHOULD NOT ENTER'));
  assert.equal(await fs.readFile(f.main,'utf8'),f.before);
  assert.equal((await request(`/api/memory-injection/previews/${job.id}/confirm`,'POST',{content:'arbitrary override'})).status,400);
  res=await request(`/api/memory-injection/previews/${job.id}/confirm`,'POST',{});assert.equal(res.status,202);
  for(let i=0;i<200;i++){job=await(await request(`/api/memory-injection/previews/${job.id}`)).json();if(job.status!=='committing')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'committed',job.error);
  assert.match(await fs.readFile(f.main,'utf8'),/ADMIN APPROVED FACT/);
  assert.equal(await fs.readFile(f.extra,'utf8'),'EXTRA FILE MUST STAY UNCHANGED');
});
