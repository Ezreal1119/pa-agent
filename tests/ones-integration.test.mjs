import {writeMemory, recallFixtureReply, memoryRequest} from "./memory-recall-fixture.mjs";
import {memoryFixturePath} from './memory-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createWebServer} from '../dist/web/server.js';
import {AgentApi} from '../integrations/wecom-bridge/api.mjs';
import {onesFixture,defaultModel,streamReply,isChild,currentTools,lastUser,system,until} from './ones-fixtures.mjs';

async function fixture(t,settings={},extra={}){
 const cleanup=[];const f=await onesFixture({after:fn=>cleanup.push(fn)},{web:true,ones:settings,extra});
 const key='API_FIXTURE_SECRET_12345678901234567890',bridgeToken='BRIDGE_FIXTURE_SECRET_12345678901234567890';
 const options={...f.options,admin:{account:'test',password:'test-password'},maxConcurrentRuns:1,bridgeToken,httpApi:{enabled:true,apiKey:key,waitMs:0},mcp:{enabled:true,apiKey:key,waitMs:0}};
 let app,base,headers;const clients=[];
 async function start(){
  app=await createWebServer(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;
  const status=await(await fetch(base+'/api/auth/status')).json();const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':status.token},body:JSON.stringify(options.admin)});assert.equal(response.status,200);headers={'Content-Type':'application/json','X-Local-Token':status.token,Cookie:response.headers.get('set-cookie').split(';')[0]};
 }
 t.after(async()=>{for(const c of clients)await c.close();await app?.close();for(const fn of cleanup)await fn();});await start();
 const admin=async(route,method='GET',body)=>fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const api=()=>new AgentApi(base,bridgeToken,30000);
 async function apiResult(id){let r;await until(async()=>{const response=await fetch(base+`/api/v1/tasks/${id}`,{headers:{Authorization:`Bearer ${key}`}});r=await response.json();return !['queued','running'].includes(r.status);});return r;}
 async function mcpClient(){const c=new Client({name:'fixture',version:'1.0.0'});await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));clients.push(c);return c;}
 return {...f,key,admin,api,apiResult,mcpClient,get app(){return app;},get base(){return base;},async restart(){for(const c of clients.splice(0))await c.close();await app.close();await start();}};
}
const parseSse=text=>text.split('\n\n').flatMap(frame=>{const event=frame.split('\n').find(s=>s.startsWith('event: '))?.slice(7),data=frame.split('\n').find(s=>s.startsWith('data: '))?.slice(6);return event&&data?[{event,data:JSON.parse(data)}]:[]});

test('Windows Tools starts from the Sub-Agents switch and diagnoses from its own read-only workspace', async t => {
 const f = await fixture(t);
 const switchRoute = '/api/sub-agents/windows-tools';
 const catalog = async () => (await (await f.admin('/api/sub-agents')).json()).agents.find(entry => entry.id === 'windows-tools');
 assert.match((await catalog()).unavailable, /upload/i);
 assert.equal((await f.admin(switchRoute, 'PUT', {enabled:true})).status, 409);

 const workspace = path.join(f.dataDir, 'windows-tools/workspace');
 await fs.mkdir(path.join(workspace, 'PCTool'), {recursive:true});
 await fs.mkdir(path.join(workspace, 'SNTool'));
 await fs.writeFile(path.join(workspace, 'PCTool/README.md'), 'Snapshot\nWINDOWS_FIXTURE_MESSAGE\nNext line\n');
 await fs.writeFile(path.join(workspace, 'SNTool/README.md'), 'SNTool snapshot\n');
 await fs.writeFile(path.join(workspace, 'PCTool/.private'), 'WINDOWS_FIXTURE_HIDDEN');
 await fs.writeFile(path.join(f.root, 'outside.txt'), 'WINDOWS_FIXTURE_OUTSIDE');
 await fs.symlink(path.join(f.root, 'outside.txt'), path.join(workspace, 'PCTool/link.txt'));
 await f.restart();
 assert.equal((await catalog()).enabled, false);
 assert.equal((await catalog()).supervisorTool.name, 'ask_windows_tools_agent');
 assert.equal((await f.admin(switchRoute, 'PUT', {enabled:true})).status, 200);

 const issue = 'Explain the PCTool fixture error';
 const delegation = {task: issue, background:'A Windows utility error', confirmedFacts:[], corrections:[], constraints:[], unresolvedQuestions:[]};
 const source = {path:'PCTool/README.md', startLine:2, endLine:2};
 const diagnostic = {status:'completed', answer:'The fixture reaches the documented failure branch.', sources:[source], unknowns:[], questions:[]};
 const replyWithTool = (res, name, args) => streamReply(res, {tool:{name, args}});
 const mainResults = [];
 const childResults = [];
 f.setModel((body, res) => {
  const results = currentTools(body);
  if (system(body).includes('你是 Windows Tools Agent')) {
   childResults.push(body);
   const next = [
    ['grep', {path:'PCTool', pattern:'WINDOWS_FIXTURE', glob:'*', literal:true}],
    ['read', {path:'PCTool/link.txt'}],
    ['read', {path:'PCTool/README.md', offset:2, limit:1}],
    ['finish_windows_tools_task', {...diagnostic, sources:[{...source, endLine:3}]}],
    ['finish_windows_tools_task', diagnostic],
   ][results.length];
   return next ? replyWithTool(res, ...next) : streamReply(res);
  }
  mainResults.push(body);
  const next = [
   ['read', {path:path.join(workspace, source.path)}],
   ['grep', {path:f.dataDir, pattern:'WINDOWS_FIXTURE_MESSAG[E]', literal:false}],
   ['ask_windows_tools_agent', delegation],
  ][results.length];
  return next ? replyWithTool(res, ...next) : streamReply(res, {text:diagnostic.answer});
 });
 const api = f.api();
 const {id} = await api.json('/sessions','POST',{});
 const done = await api.run(id, issue, [], () => {}, undefined, {botId:'bot', userId:'customer', chatType:'single', at:Date.now()});
 assert.equal(done.failed, false);
 assert.equal(done.run.windowsToolsTasks[0].status, 'completed');
 assert.equal(done.run.agentUsage.windowsTools.requests, childResults.length);
 assert.equal(done.run.usage.requests, childResults.length + mainResults.length);
 assert.deepEqual(childResults[0].tools.map(tool => tool.function.name).sort(), ['find','finish_windows_tools_task','grep','ls','read']);
 assert.equal(JSON.parse(lastUser(childResults[0]).content).question, issue);
 assert.doesNotMatch(system(childResults[0]), /BUSINESS_PRIVATE_MEMORY|BUSINESS_PRIVATE_KNOWLEDGE/);
 const finalChildTools = currentTools(childResults.at(-1));
 assert.match(finalChildTools[0].content, /PCTool\/README\.md:2:WINDOWS_FIXTURE_MESSAGE/);
 assert.doesNotMatch(finalChildTools[0].content, /WINDOWS_FIXTURE_HIDDEN|WINDOWS_FIXTURE_OUTSIDE/);
 assert.match(finalChildTools[1].content, /Linked paths are unavailable/);
 assert.match(finalChildTools[2].content, /2: WINDOWS_FIXTURE_MESSAGE/);
 assert.match(finalChildTools[3].content, /line ranges returned by read/);
 const finalMainTools = currentTools(mainResults.at(-1));
 assert.match(finalMainTools[0].content, /reserved for its specialist/);
 assert.doesNotMatch(finalMainTools[1].content, /WINDOWS_FIXTURE_MESSAGE/);
 assert.deepEqual(JSON.parse(finalMainTools[2].content).sources, [source]);
 assert.match((await api.json(`/sessions/${id}/runs/${done.run.id}/detail`)).answer, /Windows Tools 排障/);
 await f.restart();
 assert.equal((await catalog()).enabled, true);
 assert.equal((await f.admin(switchRoute, 'PUT', {enabled:false})).status, 200);
 const preview = await f.admin('/api/prompt/preview','POST', {instructions:[], mode:'standard'});
 assert.equal(preview.status, 200);
 assert.doesNotMatch(await preview.text(), /ask_windows_tools_agent/);
});

test('Windows Tools searches a delegated WeCom log by ID and cannot read other attachments', async t => {
 const f = await fixture(t, {}, {fileTools:{enabled:true, tools:['pdf_read']}});
 const workspace = path.join(f.dataDir, 'windows-tools/workspace');
 for (const name of ['PCTool', 'SNTool']) {
  await fs.mkdir(path.join(workspace, name), {recursive:true});
  await fs.writeFile(path.join(workspace, name, 'README.md'), 'Snapshot\n');
 }
 await f.restart();
 assert.equal((await f.admin('/api/sub-agents/windows-tools', 'PUT', {enabled:true})).status, 200);
 const api = f.api();
 const {id} = await api.json('/sessions', 'POST', {});
 const other = (await api.json('/sessions', 'POST', {})).id;
 const filename = 'PCTool.log';
 const log = Buffer.from('ordinary status message\r\n'.repeat(1240) + 'PCTOOL_FIXTURE_ERROR at startup\r\nending\r\n');
 const selected = await api.upload(id, filename, log);
 const unselected = await api.upload(id, filename, Buffer.from('UNSELECTED_FIXTURE_DATA\n'));
 const unbound = await api.upload(id, filename, Buffer.from('UNBOUND_FIXTURE_DATA\n'));
 const foreign = await api.upload(other, filename, Buffer.from('FOREIGN_FIXTURE_DATA\n'));
 const issue = 'What error is in this PCTool log?';
 const delegation = {task:issue, background:'', confirmedFacts:[], corrections:[], constraints:[], unresolvedQuestions:[]};
 const alias = `attachment:${selected.id}`;
 const evidence = {path:alias, startLine:1241, endLine:1241};
 let childFirst, childFinal, mainFirst, mainFinal;
 const tool = (res, name, args) => streamReply(res, {tool:{name,args}});
 f.setModel((body, res) => {
  const results = currentTools(body);
  if (system(body).includes('你是 Windows Tools Agent')) {
   if (!results.length) {
    childFirst = body;
    return tool(res, 'grep', {path:alias, pattern:'PCTOOL_FIXTURE_ERROR', literal:true, limit:2});
   }
   if (results.length === 1) return tool(res, 'read', {path:`attachment:${unselected.id}`, limit:2});
   if (results.length === 2) return tool(res, 'read', {path:alias, offset:1241, limit:1});
   childFinal = body;
   return tool(res, 'finish_windows_tools_task', {status:'completed', answer:'PCTool.log records a startup error.', sources:[evidence], unknowns:[], questions:[]});
  }
  if (!results.length) {
   mainFirst = body;
   const denied = lastUser(body).content.includes('previous') ? unbound.id : foreign.id;
   return tool(res, 'ask_windows_tools_agent', {...delegation, attachment_ids:[denied]});
  }
  if (results.length === 1) return tool(res, 'ask_windows_tools_agent', {...delegation, attachment_ids:[selected.id]});
  mainFinal = body;
  return streamReply(res, {text:'Startup error found.'});
 });
 const sender = {botId:'bot', userId:'customer', chatType:'single', at:Date.now()};
 for (const [question, ids] of [[issue, [selected.id, unselected.id]], ['Recheck the previous log', []]]) {
  const result = await api.run(id, question, ids, () => {}, undefined, sender);
  assert.equal(result.failed, false);
  assert.equal(result.run.windowsToolsTasks.length, 1);
  assert.equal(result.run.windowsToolsTasks[0].status, 'completed');
  assert.ok(JSON.stringify(mainFirst.messages).includes(selected.id));
  assert.ok(!JSON.stringify(mainFirst.messages).includes('PCTOOL_FIXTURE_ERROR'));
  assert.ok(mainFirst.tools.find(t => t.function.name === 'ask_windows_tools_agent').function.parameters.properties.attachment_ids);
  assert.deepEqual(JSON.parse(lastUser(childFirst).content).attachments, [{path:alias, name:filename, bytes:log.length}]);
  assert.ok(!JSON.stringify(childFirst.messages).includes(selected.path));
  const childReads = currentTools(childFinal);
  assert.match(childReads[0].content, /1241:PCTOOL_FIXTURE_ERROR at startup/);
  assert.match(childReads[1].content, /not delegated for the current task/);
  assert.match(childReads[2].content, /1241: PCTOOL_FIXTURE_ERROR at startup/);
  assert.doesNotMatch(JSON.stringify(childFinal.messages), /UNSELECTED_FIXTURE_DATA|UNBOUND_FIXTURE_DATA|FOREIGN_FIXTURE_DATA/);
  const parentResults = currentTools(mainFinal);
  assert.match(parentResults[0].content, /attached to a message in this conversation/);
  assert.deepEqual(JSON.parse(parentResults[1].content).sources, [evidence]);
 }
 assert.deepEqual(await api.download(id, selected), log);
});

test('Supervisor caps a batched call at 50 and Windows Tools reserves its 50th call to submit', async t => {
 const f = await fixture(t);
 const workspace = path.join(f.dataDir, 'windows-tools/workspace');
 for (const name of ['PCTool', 'SNTool']) {
  await fs.mkdir(path.join(workspace, name), {recursive:true});
  await fs.writeFile(path.join(workspace, name, 'README.md'), 'Snapshot evidence\n');
 }
 await f.restart();
 assert.equal((await f.admin('/api/sub-agents/windows-tools', 'PUT', {enabled:true})).status, 200);
 const issue = 'Explain the PCTool fixture error';
 const delegation = {task:issue, background:'', confirmedFacts:[], corrections:[], constraints:[], unresolvedQuestions:[]};
 const read = {name:'read', args:{path:path.join(f.dataDir, 'urovo-product-expert/SKILL.md')}};
 const childRead = {name:'read', args:{path:'PCTool/README.md'}};
 const submission = {name:'finish_windows_tools_task', args:{status:'partial', answer:'The snapshot specifies the affected step.', sources:[{path:'PCTool/README.md', startLine:1, endLine:1}], unknowns:['Firmware revision'], questions:[]}};
 let childFinal, mainFinal, followupFirst;
 f.setModel((body, res) => {
  const results = currentTools(body);
  if (system(body).includes('你是 Windows Tools Agent')) {
   if (results.length < 49) return streamReply(res, {tool:childRead});
   childFinal = body;
   return streamReply(res, {tool:submission});
  }
  if (lastUser(body).content.includes('Follow up')) {
   if (!results.length) { followupFirst = body; return streamReply(res, {tool:read}); }
   return streamReply(res, {text:'Follow-up answer'});
  }
  if (!results.length) return streamReply(res, {tool:{name:'ask_windows_tools_agent', args:delegation}});
  if (results.length === 1) return streamReply(res, {tools:Array.from({length:51}, () => read)});
  mainFinal = body;
  return streamReply(res, {text:'Answer using available results'});
 });
 const api = f.api();
 const {id} = await api.json('/sessions','POST',{});
 const sender = {botId:'bot', userId:'customer', chatType:'single', at:Date.now()};
 const result = await api.run(id, issue, [], () => {}, undefined, sender);
 assert.equal(result.failed, false);
 assert.equal(result.run.windowsToolsTasks[0].status, 'partial');
 assert.equal(result.run.windowsToolsTasks[0].usage.requests, 50);
 assert.equal(result.run.windowsToolsTasks[0].toolCalls, 49);
 assert.deepEqual(childFinal.tools.map(tool => tool.function.name), [submission.name]);
 assert.match(system(childFinal), /Submit a partial result/);
 assert.equal(mainFinal.tools?.length ?? 0, 0);
 assert.match(system(mainFinal), /Answer now using the available results/);
 const reads = currentTools(mainFinal).slice(1);
 assert.equal(reads.filter(result => result.content.includes('BUSINESS_PRIVATE_KNOWLEDGE')).length, 49);
 assert.equal(reads.filter(result => result.content.includes('Tool call limit reached')).length, 2);
 assert.equal((await api.run(id, 'Follow up', [], () => {}, undefined, sender)).failed, false);
 assert.ok(followupFirst.tools.some(tool => tool.function.name === 'read'));
});

test('Sub-Agents lists the read-only ONES profile and persists its switch across requests and restarts', async t => {
 const f = await fixture(t);
 const onRoute = '/api/sub-agents/ones';
 await fs.writeFile(path.join(f.root, '.env'), 'ONES_AGENT_ENABLED=true\n');
 f.options.ones.enabled = undefined;
 await f.restart();
 assert.equal((await fetch(f.base+'/sub-agents', {redirect:'manual'})).headers.get('location'), '/login');
 assert.equal((await fetch(f.base+'/api/sub-agents')).status, 401);
 assert.match(await (await f.admin('/')).text(), /href="\/sub-agents"/);
 assert.match(await (await f.admin('/sub-agents')).text(), /Prompt and tools/);
 const profile = await (await f.admin('/api/sub-agents')).text();
 assert.doesNotMatch(profile, /ONES_FIXTURE_SECRET|MODEL_FIXTURE_SECRET/);
 const [ones] = JSON.parse(profile).agents;
 assert.equal(ones.enabled, false);
 assert.equal(ones.supervisorTool.name, 'ask_ones_agent');
 assert.match(ones.prompt, /你是 ONES 售后业务查询专家/);
 assert.ok(ones.mcpTools.includes('get_issue_details'));
 assert.equal(ones.internalTools[0].name, 'finish_ones_task');
 assert.equal(f.mcpRequests.length, 0);
 assert.equal((await f.admin(onRoute, 'PUT', {enabled:true, prompt:'modified'})).status, 400);

 f.setModel((body, res) => {
  if (body.tools.some(tool => tool.function.name === 'ask_ones_agent') || isChild(body)) return defaultModel(body, res);
  return streamReply(res, {text:'Supervisor answered without ONES.'});
 });
 const session = await (await f.admin('/api/sessions', 'POST', {})).json();
 async function run(text) {
  const response = await f.admin(`/api/sessions/${session.id}/run`, 'POST', {text});
  assert.equal(response.status, 200);
  const done = parseSse(await response.text()).find(frame => frame.event === 'done').data;
  assert.equal(done.failed, false);
  return done.run;
 }
 assert.equal((await run('关闭时查询')).onesTasks?.length ?? 0, 0);
 assert.equal(f.requests[0].tools.some(tool => tool.function.name === 'ask_ones_agent'), false);
 assert.equal((await (await f.admin(onRoute, 'PUT', {enabled:true})).json()).agents[0].enabled, true);
 assert.equal((await run('打开后查询同一个会话')).onesTasks[0].status, 'completed');

 const settings = await (await f.admin('/api/agent-settings')).json();
 assert.equal((await f.admin('/api/agent-settings', 'PUT', settings.settings)).status, 200);
 await f.restart();
 assert.equal((await (await f.admin('/api/sub-agents')).json()).agents[0].enabled, true);
 assert.equal((await run('重启后继续查询')).onesTasks[0].status, 'completed');
 assert.equal((await (await f.admin(onRoute, 'PUT', {enabled:false})).json()).agents[0].enabled, false);
 assert.equal((await run('再次关闭后查询')).onesTasks?.length ?? 0, 0);
 assert.equal(f.requests.at(-1).tools.some(tool => tool.function.name === 'ask_ones_agent'), false);
});

test('Sub-Agents keeps ONES inspectable while its MCP token is missing', async t => {
 const f = await fixture(t, {}, {ones:{token:''}});
 const list = await (await f.admin('/api/sub-agents')).json();
 const [ones] = list.agents;
 assert.equal(ones.enabled, false);
 assert.match(ones.unavailable, /ONES_MCP_TOKEN/);
 assert.ok(ones.prompt);
 assert.equal((await f.admin('/api/sub-agents/ones', 'PUT', {enabled:true})).status, 409);
 assert.equal((await f.admin('/api/sessions','POST',{})).status, 201);
});

test('Web delegates with a single main run slot, reports progress/usage, retains details and deletes child history',async t=>{
 const f=await fixture(t);const s=await(await f.admin('/api/sessions','POST',{})).json();
 const response=await f.admin(`/api/sessions/${s.id}/run`,'POST',{text:'查 SQ29M 发布记录'});assert.equal(response.status,200);
 const events=parseSse(await response.text()),done=events.find(e=>e.event==='done').data;
 assert.equal(done.failed,false);assert.equal(done.run.onesTasks.length,1);assert.equal(done.run.usage.input,400);assert.equal(done.run.usage.output,28);assert.equal(done.run.agentUsage.ones.requests,2);assert.equal(done.run.agentUsage.main.requests,2);
 assert.ok(events.some(e=>e.event==='notice'&&e.data.agent==='ones'&&e.data.text.includes('查询 ONES')));
 assert.ok(!events.some(e=>e.event==='tool_progress'));
 const details=await(await f.admin(`/api/sessions/${s.id}/runs/${done.run.id}/tools`)).json();assert.equal(details.calls.find(c=>c.name==='ask_ones_agent').result.details.onesTask.status,'completed');
 const list=await(await f.admin('/api/sessions')).json();assert.equal(list.sessions.length,1);
 const child=path.join(f.dataDir,'agents/ones/parents',s.id);await fs.stat(child);
 assert.equal((await f.admin(`/api/sessions/${s.id}`,'DELETE')).status,200);await assert.rejects(fs.stat(child),{code:'ENOENT'});
});

test('WeCom uses the same strategy, preserves patrick_detail and respects channel ownership',async t=>{
 const f=await fixture(t),api=f.api();const {id}=await api.json('/sessions','POST',{});const notices=[],steps=[];
 const result=await api.run(id,'企微查询 SQ29M',[],(event,data)=>{if(event==='notice')notices.push(data);if(event==='tool_progress')steps.push(data);},undefined,{botId:'bot',userId:'customer',chatType:'single',at:Date.now()});
 assert.equal(result.failed,false);assert.equal(result.run.onesTasks.length,1);assert.ok(notices.some(n=>n.agent==='ones'));
 assert.deepEqual(steps.map(step=>[step.name,step.state]),[['get_issue_details','running'],['get_issue_details','done']]);
 assert.equal(steps[0].id,steps[1].id);
 assert.deepEqual(Object.keys(steps[0]).sort(),['agent','id','name','state']);
 const route=`/sessions/${id}/runs/${result.run.id}/detail`;
 const detail=await api.json(route);assert.match(detail.answer,/主 Agent 已整合/);assert.match(detail.answer,/ONES 查询/);
 await f.restart();assert.deepEqual(await f.api().json(route),detail);
 const web=await(await f.admin('/api/sessions','POST',{})).json();await assert.rejects(f.api().json(`/sessions/${web.id}`),e=>e.status===403||e.status===404);
});

test('HTTP API and MCP both delegate, persist separate usage and maintain private child sessions after restart',async t=>{
 const f=await fixture(t);
 const response=await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:`Bearer ${f.key}`,'Content-Type':'application/json'},body:JSON.stringify({question:'HTTP 查询 SQ29M'})});assert.equal(response.status,202);
 const submitted=await response.json();const task=await f.apiResult(submitted.task_id);assert.equal(task.status,'completed');assert.equal(task.usage.input_tokens,400);assert.equal(task.agent_usage.ones.requests,2);assert.equal(task.ones_tasks.length,1);
 const c=await f.mcpClient();const asked=(await c.callTool({name:'ask_product_expert',arguments:{question:'MCP 查询 SQ29M'}})).structuredContent;let mcp;
 await until(async()=>{mcp=(await c.callTool({name:'get_task_result',arguments:{task_id:asked.task_id}})).structuredContent;return mcp.status==='completed';});
 assert.equal(mcp.usage.input_tokens,400);assert.equal(mcp.ones_tasks.length,1);assert.notEqual(mcp.conversation_id,task.conversation_id);
 const children=await fs.readdir(path.join(f.dataDir,'agents/ones/parents'));assert.equal(children.length,2);
 await f.restart();const saved=await f.apiResult(task.task_id);assert.deepEqual(saved.agent_usage,task.agent_usage);assert.deepEqual(saved.ones_tasks,task.ones_tasks);
 const follow=await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:`Bearer ${f.key}`,'Content-Type':'application/json'},body:JSON.stringify({question:'继续查刚才的记录',conversation_id:task.conversation_id})});const next=await f.apiResult((await follow.json()).task_id);assert.equal(next.status,'completed');
});

test('stopping a Web question cancels ONES and still records child usage without counting it twice',async t=>{
 const f=await fixture(t),s=await(await f.admin('/api/sessions','POST',{})).json();let waiting=false;
 f.setModel((b,res)=>{if(isChild(b)&&currentTools(b).length){waiting=true;return;}return defaultModel(b,res);});
 const response=await f.admin(`/api/sessions/${s.id}/run`,'POST',{text:'停止测试'});const body=response.text();await until(()=>waiting);
 assert.equal((await f.admin('/api/sub-agents/ones','PUT',{enabled:false})).status,409);
 assert.equal((await (await f.admin('/api/sub-agents')).json()).agents[0].enabled,true);
 assert.equal((await f.admin(`/api/sessions/${s.id}/stop`,'POST',{})).status,200);const events=parseSse(await body);const done=events.find(e=>e.event==='done').data;
 assert.equal(done.run.status,'stopped');assert.equal(done.run.onesTasks.length,1);assert.equal(done.run.onesTasks[0].status,'cancelled');assert.equal(done.run.usage.input,200);assert.equal(done.run.usage.requests,3);
});

test('settings reload closes children and reopens durable context without stale writes',async t=>{
 const f=await fixture(t),api=f.api(),{id}=await api.json('/sessions','POST',{});
 await api.run(id,'first query',[],()=>{});
 const settings=await(await f.admin('/api/agent-settings')).json();const put=await f.admin('/api/agent-settings','PUT',settings.settings);assert.equal(put.status,200);
 const next=await api.run(id,'followup query',[],()=>{});assert.equal(next.failed,false);assert.equal(next.run.onesTasks.length,1);
 const child=f.requests.filter(isChild).at(-1);assert.ok(JSON.stringify(child).includes('first query'));
});

test('startup restores interrupted child usage into the main run even when its completion receipt was never written',async t=>{
 const f=await fixture(t),api=f.api(),{id}=await api.json('/sessions','POST',{});
 const done=await api.run(id,'crash recovery',[],()=>{},undefined,{botId:'bot',userId:'customer',chatType:'single',at:Date.now()});
 const mainDir=path.join(f.dataDir,'sessions');const files=await fs.readdir(mainDir);const mainFile=files.find(n=>n.endsWith('.jsonl')&&(n.includes(id)));
 assert.ok(mainFile);const file=path.join(mainDir,mainFile);const original=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
 const childDir=path.join(f.dataDir,'agents/ones/parents',id,'tasks');const childFile=path.join(childDir,(await fs.readdir(childDir))[0]);const child=JSON.parse(await fs.readFile(childFile,'utf8'));
 assert.equal(child.binding.round,1);const usage=child.result.usage;
 // Emulate a crash after the child model returned usage but before either result
 // was published: the child JSONL has usage checkpoints; main has no receipt.
 child.result.status='running';child.result.usage={input:0,output:0,requests:0,reportedRequests:0};await fs.writeFile(childFile,JSON.stringify(child));
 const entries=original.filter(e=>!(e.type==='custom'&&e.customType==='ones-delegation-v1')).map(e=>{
  if(e.type==='custom'&&e.customType==='web-run-metrics-v1'){
   e.data.status='running';e.data.finishedAt=null;e.data.elapsedMs=null;delete e.data.onesTasks;
   e.data.usage={input:100,output:7,requests:1,reportedRequests:1};
  }return e;
 });
 await fs.writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');const count=f.requests.length;
 await f.restart();const snapshot=await f.api().json(`/sessions/${id}`);const metric=snapshot.runs.find(r=>r.id===done.run.id);
 assert.equal(metric.status,'interrupted');assert.equal(metric.onesTasks.length,1);assert.equal(metric.onesTasks[0].status,'interrupted');assert.deepEqual(metric.onesTasks[0].usage,usage);assert.equal(metric.usage.input,100+usage.input);assert.equal(f.requests.length,count);
 const again=await f.api().json(`/sessions/${id}`);assert.equal(again.runs.find(r=>r.id===done.run.id).usage.input,metric.usage.input);
 const detail=await f.api().json(`/sessions/${id}/runs/${done.run.id}/detail`);assert.match(detail.answer,/ONES 查询/);
});

test('HTTP API cancellation propagates to ONES and preserves stable terminal usage across polling',async t=>{
 const f=await fixture(t);let waiting=false;
 f.setModel((b,res)=>{if(isChild(b)&&currentTools(b).length){waiting=true;return;}return defaultModel(b,res);});
 const response=await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:`Bearer ${f.key}`,'Content-Type':'application/json'},body:JSON.stringify({question:'API stop'})});const submitted=await response.json();await until(()=>waiting);
 const stopped=await fetch(f.base+`/api/v1/tasks/${submitted.task_id}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${f.key}`}});assert.ok([200,202].includes(stopped.status));
 const result=await f.apiResult(submitted.task_id);assert.equal(result.status,'cancelled');assert.equal(result.ones_tasks[0].status,'cancelled');assert.equal(result.usage.input_tokens,200);assert.equal(result.usage.model_requests,3);
 assert.deepEqual((await f.apiResult(submitted.task_id)).usage,result.usage);
});

test('memory recall is available in all four existing chat entry points and billed once', async t => {
 const f = await fixture(t, {}, {ones:{enabled:false}, memoryRecall:{enabled:true}});
 await writeMemory(f.dataDir);
 f.setModel(recallFixtureReply);
 const question="SQ29M R01 支持什么协议？";
 const created = await (await f.admin('/api/sessions','POST',{})).json();
 const web = parseSse(await (await f.admin(`/api/sessions/${created.id}/run`,'POST',{text:question})).text()).find(frame=>frame.event==='done').data;
 assert.equal(web.run.agentUsage.memory.requests,1);
 assert.equal(web.run.usage.requests,3);
 const api = f.api(), {id} = await api.json('/sessions','POST',{});
 const wecom = await api.run(id,question,[],()=>{});
 assert.equal(wecom.run.memoryTasks[0].status,'matched');
 const req = await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:`Bearer ${f.key}`,'Content-Type':'application/json'},body:JSON.stringify({question})});
 const task = await f.apiResult((await req.json()).task_id);
 assert.equal(task.memory_tasks[0].status,'matched');
 assert.equal(task.usage.model_requests,3);
 f.setModel((body,res)=>{
  if(memoryRequest(body)||!currentTools(body).length)return recallFixtureReply(body,res);
  assert.deepEqual(body.tools.find(t=>t.function.name==='memory').function.parameters.properties.action,{const:'get',type:'string'});
  if(currentTools(body).length===1)return streamReply(res,{tool:{name:'memory',args:{action:'get',id:'mem_extra',source:'extra'}}});
  assert.match(currentTools(body).at(-1).content,/仅客户测试版/);
  return streamReply(res,{text:'已核对完整的客户测试版记忆。'});
 });
 const c=await f.mcpClient();
 const asked=(await c.callTool({name:'ask_product_expert',arguments:{question}})).structuredContent;
 let result;
 await until(async()=>{result=(await c.callTool({name:'get_task_result',arguments:{task_id:asked.task_id}})).structuredContent;return result.status==='completed';});
 assert.equal(result.agent_usage.memory.requests,1);
 assert.equal(result.agent_usage.main.requests,3);
 const settings = (await (await f.admin('/api/agent-settings')).json()).settings;
 assert.equal(settings.memoryRecall.enabled,true);
 const disabled = await f.admin('/api/agent-settings','PUT',{...settings,memoryRecall:{enabled:false}});
 assert.equal(disabled.status,200);
 await f.restart();
 assert.equal((await (await f.admin('/api/agent-settings')).json()).settings.memoryRecall.enabled,false);
 const start = f.requests.length;
 f.setModel((body,res)=>streamReply(res,{text:'已根据完整记忆核对。'}));
 const resumed = await f.mcpClient();
 const mcpFollowup = (await resumed.callTool({name:'ask_product_expert',arguments:{question:'MCP follow-up',conversation_id:result.conversation_id}})).structuredContent;
 await until(async()=>{result=(await resumed.callTool({name:'get_task_result',arguments:{task_id:mcpFollowup.task_id}})).structuredContent;return result.status==='completed';});
 assert.equal(result.usage.model_requests,1);
 const httpFollowup = await fetch(f.base+'/api/v1/ask',{method:'POST',headers:{Authorization:`Bearer ${f.key}`,'Content-Type':'application/json'},body:JSON.stringify({question:'HTTP follow-up',conversation_id:task.conversation_id})});
 const finished = await f.apiResult((await httpFollowup.json()).task_id);
 assert.equal(finished.status,'completed');
 assert.equal(finished.usage.model_requests,1);
 const wecomFollowup = await f.api().run(id,'WeCom follow-up',[],()=>{});
 assert.equal(wecomFollowup.failed,false);
 assert.equal(wecomFollowup.run.usage.requests,1);
 const followups = f.requests.slice(start);
 assert.equal(followups.length,3);
 for (const body of followups) {
  assert.match(system(body),/仅支持 M7 协议/);
  assert.match(system(body),/仅客户测试版/);
  assert.ok(!JSON.stringify(body).includes('recall_memory'));
 }
 assert.ok(followups.slice(0,2).every(body=>!body.tools.some(t=>t.function.name==='memory')));
 assert.ok(followups[2].tools.some(t=>t.function.name==='memory'));
});

test('the Settings switch defaults off and restores the original full-memory prompt in a live Web conversation', async t => {
 const f = await fixture(t, {}, {ones:{enabled:false},memoryRecall:{enabled:false}});
 await writeMemory(f.dataDir);
 const settings = (await (await f.admin('/api/agent-settings')).json()).settings;
 assert.deepEqual(settings.memoryRecall,{enabled:false});
 const preview = async () => {
  const response = await f.admin('/api/prompt/preview','POST',{mode:'standard',instructions:[]});
  assert.equal(response.status,200);
  return response.json();
 };
 const {id} = await (await f.admin('/api/sessions','POST',{})).json();
 const run = async text => {
  const response = await f.admin(`/api/sessions/${id}/run`,'POST',{text});
  assert.equal(response.status,200);
  const done = parseSse(await response.text()).find(frame=>frame.event==='done')?.data;
  assert.equal(done?.failed,false);
  return done.run;
 };
 f.setModel((body,res)=>{
  if (memoryRequest(body)) return recallFixtureReply(body,res);
  if (!body.tools.some(t=>t.function.name==='recall_memory')) return streamReply(res,{text:'已查看完整记忆。'});
  if (currentTools(body).length===1) return streamReply(res,{tool:{name:'memory',args:{action:'get',id:'mem_extra',source:'extra'}}});
  return recallFixtureReply(body,res);
 });
 const initialPreview = await preview();
 assert.match(initialPreview.system,/the full extra memory is injected each run/);
 const legacyTool = initialPreview.tools.find(t=>t.name==='memory');
 assert.match(legacyTool.description,/No list\/get/);
 assert.ok(legacyTool.parameters.required.includes('expected_revision'));
 const initial = await run('全文模式的第一轮');
 assert.equal(initial.usage.requests,1);
 const initialRequest = f.requests.at(-1);
 assert.match(system(initialRequest),/仅支持 M7 协议/);
 assert.match(system(initialRequest),/仅客户测试版/);
 assert.ok(!initialRequest.tools.some(t=>t.function.name==='recall_memory'));
 await fs.writeFile(memoryFixturePath(f.dataDir),'Legacy prose memory.');
 const invalid = await f.admin('/api/agent-settings','PUT',{...settings,memoryRecall:{enabled:true}});
 assert.equal(invalid.status,400);
 assert.equal((await (await f.admin('/api/agent-settings')).json()).settings.memoryRecall.enabled,false);
 await writeMemory(f.dataDir);
 const enabled = await f.admin('/api/agent-settings','PUT',{...settings,memoryRecall:{enabled:true}});
 assert.equal(enabled.status,200);
 const {memoryRecall: _memoryRecall,...legacySettings} = settings;
 const legacySave = await f.admin('/api/agent-settings','PUT',legacySettings);
 assert.equal(legacySave.status,200);
 assert.equal((await legacySave.json()).settings.memoryRecall.enabled,true);
 const enabledPreview = await preview();
 assert.ok(enabledPreview.tools.some(t=>t.name==='recall_memory'));
 assert.doesNotMatch(enabledPreview.system,/仅支持 M7 协议|仅客户测试版|the full extra memory is injected each run/);
 const recalled = await run('查一下测试版的限制');
 assert.equal(recalled.agentUsage.memory.requests,1);
 assert.match(currentTools(f.requests.at(-1)).at(-1).content,/仅客户测试版/);
 const disabled = await f.admin('/api/agent-settings','PUT',settings);
 assert.equal(disabled.status,200);
 const restoredPreview = await preview();
 assert.equal(restoredPreview.system,initialPreview.system);
 assert.deepEqual(restoredPreview.tools,initialPreview.tools);
 assert.equal((await run('切回全文模式')).usage.requests,1);
 const restoredRequest = f.requests.at(-1);
 assert.equal(system(restoredRequest),system(initialRequest));
 assert.deepEqual(restoredRequest.tools,initialRequest.tools);
 assert.ok(JSON.stringify(restoredRequest).includes('查一下测试版的限制'));
 assert.ok(!JSON.stringify(restoredRequest).includes('recall_memory'));
 assert.ok(!restoredRequest.messages.some(m=>m.role==='tool'));
 const history = await (await f.admin(`/api/sessions/${id}/runs/${recalled.id}/tools`)).json();
 assert.ok(history.calls.some(c=>c.name==='recall_memory'));
});
