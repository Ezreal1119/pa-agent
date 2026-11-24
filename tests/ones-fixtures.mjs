import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/server';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {z} from 'zod';
import {createAgentRuntime} from '../dist/agent/runtime.js';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {writeMemoryFixture} from './memory-fixtures.mjs';

export const delegation={task:'查找该型号最近发布的软件及修改点',background:'客户在追问之前讨论的 SQ29M',confirmedFacts:['型号 SQ29M'],corrections:['发布记录指提测单进入已发布，不是独立邮件'],constraints:['仅查询，不修改'],unresolvedQuestions:[]};
export function streamReply(res,{text='ANSWER',tool,tools=tool?[tool]:[],input=100,output=7}={}){
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const delta=tools.length?{tool_calls:tools.map(({name,args},index)=>({index,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{content:text};
 for(const [d,end] of [[{role:'assistant'},null],[delta,null],[{},tools.length?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:d,finish_reason:end}],...(end?{usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output,prompt_tokens_details:{cached_tokens:30}}}:{})})}\n\n`);
 res.end('data: [DONE]\n\n');
}
export const system=b=>b.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
export const isSummary=b=>system(b).includes('context summarization assistant');
export const isChild=b=>system(b).includes('你是 ONES 售后业务查询专家');
const contentText=c=>typeof c==='string'?c:(c??[]).map(p=>p.text??'').join('');
export const lastUser=b=>{const m=b.messages.findLast(m=>m.role==='user');return m?{...m,content:contentText(m.content)}:undefined;};
export const currentTools=b=>{const names=new Map(b.messages.flatMap(m=>(m.tool_calls??[]).map(t=>[t.id,t.function.name])));return b.messages.slice(b.messages.findLastIndex(m=>m.role==='user')+1).filter(m=>m.role==='tool').map(m=>({...m,name:m.name??names.get(m.tool_call_id),content:contentText(m.content)}));};
export function defaultModel(body,res){
 if(isSummary(body))return streamReply(res,{text:'ONES SUMMARY: 保留 SQ29M，已发布提测单和用户纠正。'});
 if(isChild(body)){
  const task=JSON.parse(lastUser(body).content);const calls=currentTools(body);
  if(!calls.length)return streamReply(res,{tool:{name:'get_issue_details',args:{issueID:`issue-${task.originalQuestion}`}}});
  const id=`issue-${task.originalQuestion}`;
  return streamReply(res,{tool:{name:'finish_ones_task',args:{status:'completed',answer:`查询完成 ${task.originalQuestion}`,sources:[{id,title:'SQ29M 已发布提测单',url:`https://ones.example/issues/${encodeURIComponent(id)}`}],unknowns:[],questions:[]}}});
 }
 if(lastUser(body).content.startsWith('prime'))return streamReply(res,{text:'primed'});
 if(!currentTools(body).some(t=>t.name==='ask_ones_agent'))return streamReply(res,{tool:{name:'ask_ones_agent',args:delegation}});
 return streamReply(res,{text:'主 Agent 已整合 ONES 查询结果。'});
}
export async function until(fn,ms=7000){const stop=Date.now()+ms;while(Date.now()<stop){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Condition did not complete');}
export async function onesFixture(t,{ones={},web=false,extra={}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ones-agent-'));const dataDir=path.join(root,'data');
 await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'BUSINESS_PRIVATE_KNOWLEDGE');await writeMemoryFixture(dataDir,'urovo-product-expert','BUSINESS_PRIVATE_MEMORY');
 let modelHandler=defaultModel,toolHandler,authStatus=200,toolStatus=200;const requests=[],mcpRequests=[],toolCalls=[];
 const localMcp=createServer(async(req,res)=>{
  mcpRequests.push({method:req.method,token:req.headers['x-ones-mcp-token'],authorization:req.headers.authorization});
  if(authStatus!==200||req.headers['x-ones-mcp-token']!=='ONES_FIXTURE_SECRET'){res.writeHead(authStatus===200?401:authStatus,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid_token',secret:'ONES_FIXTURE_SECRET'}));return;}
  const server=new McpServer({name:'ONES fixture',version:'1.0.0'});
  const callback=name=>async args=>{
   toolCalls.push({name,args});
   if(toolHandler)return await toolHandler(name,args);
   return {content:[{type:'text',text:JSON.stringify({id:args.issueID,title:'SQ29M 已发布提测单',url:`https://ones.example/issues/${encodeURIComponent(args.issueID)}`,status:'已发布'})}]};
  };
  server.registerTool('get_issue_details',{description:'Read issue details',inputSchema:z.object({issueID:z.string()})},callback('get_issue_details'));
  server.registerTool('who_am_i',{description:'Read identity',inputSchema:z.object({})},async()=>({content:[{type:'text',text:'identity'}]}));
  server.registerTool('update_issue',{description:'Forbidden write tool',inputSchema:z.object({})},async()=>{throw new Error('Write tool must never execute');});
  const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{await server.connect(transport);await transport.handleRequest(req,res);}catch(e){if(!res.headersSent){res.writeHead(toolStatus===200?500:toolStatus);res.end('fixture error');}}finally{await server.close();}
 });
 localMcp.listen(0,'127.0.0.1');await once(localMcp,'listening');
 const model=createServer(async(req,res)=>{let data='';for await(const p of req)data+=p;const b=JSON.parse(data);requests.push(b);try{await modelHandler(b,res);}catch(e){res.destroy(e);}});
 model.listen(0,'127.0.0.1');await once(model,'listening');
 const options={cwd:root,dataDir,resourcesDir:path.resolve('resources'),model:{apiKey:'MODEL_FIXTURE_SECRET',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,modelId:'fixture',contextWindow:500000,maxTokens:10000},fileTools:{enabled:false},ones:{enabled:true,url:`http://127.0.0.1:${localMcp.address().port}/mcp`,token:'ONES_FIXTURE_SECRET',settings:ones},...extra};
 let runtime;const parents=[];
 const start=async()=>{runtime=await createAgentRuntime(options);};
 if(!web)await start();
 const childManager=async id=>{const dir=path.join(dataDir,'agents/ones/parents',id,'sessions');const files=await SessionManager.list(root,dir);return files[0]&&SessionManager.open(files[0].path,dir,root);};
 t.after(async()=>{await runtime?.close();parents.forEach(s=>s.dispose());model.closeAllConnections();localMcp.closeAllConnections();await Promise.all([new Promise(r=>model.close(r)),new Promise(r=>localMcp.close(r))]);await fs.rm(root,{recursive:true,force:true});});
 return{root,dataDir,options,requests,mcpRequests,toolCalls,get runtime(){return runtime;},setModel:f=>modelHandler=f,setTools:f=>toolHandler=f,setAuth:n=>authStatus=n,childManager,
  async create(prime=true){const s=await runtime.createSession();parents.push(s);if(prime)await s.prompt('prime parent');return s;},
  async restart(){await runtime.close();parents.forEach(s=>s.dispose());parents.length=0;await start();},
 };
}
