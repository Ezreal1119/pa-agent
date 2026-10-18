import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import {createWebServer} from '../dist/web/server.js';
import {BridgeStore} from '../integrations/wecom-bridge/store.mjs';
import {AgentApi} from '../integrations/wecom-bridge/api.mjs';
import {WecomBridge} from '../integrations/wecom-bridge/bridge.mjs';
import {fixtures} from './file-fixtures.mjs';

function reply(res,tool){
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=tool?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{content:'已完成处理，请查收。'};
 for(const [value,finish] of [[{role:'assistant'},null],[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'mock',model:'mock',object:'chat.completion.chunk',created:1,choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`);
 res.end('data: [DONE]\n\n');
}
test('WeCom transport uses the real Agent/file workers to read PDF DOCX PPTX and return a validated filled Excel', {timeout:120000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-e2e-'));const dataDir=path.join(root,'.data');const source=path.join(root,'fixtures');await fixtures(source);
 await fs.mkdir(path.join(dataDir,'urovo-product-expert'),{recursive:true});await fs.writeFile(path.join(dataDir,'urovo-product-expert/SKILL.md'),'PRODUCT RULE');await fs.writeFile(path.join(dataDir,'urovo-product-expert/MEMORY.md'),'PRODUCT MEMORY');
 const toolResults=[];let assertionsError;
 const model=createServer(async(req,res)=>{
  try{
   let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
   const brief=JSON.stringify(body.messages.filter(m=>m.role==='user'));const filePath=brief.match(/inputs\/[a-f0-9-]+\.(pdf|docx|pptx|xlsx)/)?.[0];assert.ok(filePath);
   const type=path.extname(filePath).slice(1);const last=body.messages.at(-1);
   if(last.role==='tool'){
    const result=JSON.parse(last.content);assert.equal(result.ok,true,JSON.stringify(result));toolResults.push({type,result});
    if(type==='xlsx' && !result.file)return reply(res,{name:'excel_patch_template',args:{sourcePath:filePath,outputPath:'填写结果.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:70000}]}});
    return reply(res);
   }
   reply(res,{name:{pdf:'pdf_read',docx:'docx_read',pptx:'pptx_read',xlsx:'excel_read'}[type],args:type==='xlsx'?{path:filePath,scope:'workbook'}:{path:filePath}});
  }catch(error){assertionsError=error;res.destroy(error);}
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 const token='e2e-wecom-token-'.repeat(4);const app=await createWebServer({cwd:root,dataDir,bridgeToken:token,model:{apiKey:'TEST_ONLY',modelId:'fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`},fileTools:{enabled:true,markitdown:process.env.FILE_TEST_MARKITDOWN||path.resolve('.data/file-runtime/bin/markitdown')}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const store=await new BridgeStore(path.join(dataDir,'wecom')).open();const client={texts:[],files:[],async replyStream(_f,_i,text,done){if(done)this.texts.push(text);},async replyStreamNonBlocking(){},async sendMessage(_t,b){this.texts.push(b.markdown.content);},async uploadMedia(buffer,options){this.files.push({buffer,options});return{media_id:'out'};},async replyMedia(){},async sendMediaMessage(){},disconnect(){}};
 const bridge=new WecomBridge({store,api:new AgentApi(`http://127.0.0.1:${app.server.address().port}`,token),clients:new Map([['bot',client]]),config:{concurrency:1,queueLimit:8,maxFileBytes:30*1024*1024,timeoutMs:90000,token,bots:[{botId:'bot',secret:'test'}]},download:async(media)=>{const name=new URL(media.url).pathname.slice(1);return{name,buffer:await fs.readFile(path.join(source,name))};}});await bridge.start();bridge.authenticated('bot');
 t.after(async()=>{await bridge.close();await app.close();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});});
 for(const type of ['pdf','docx','pptx','xlsx']){
  await bridge.receive('bot',{headers:{req_id:randomUUID()},body:{msgid:randomUUID(),chattype:'single',from:{userid:`user-${type}`},msgtype:'text',text:{content:type==='xlsx'?'读取并填写数量为70000':'读取文件'},quote:{msgtype:'file',file:{url:`https://fixture.invalid/sample.${type}`}}}});
  await bridge.idle(90000);if(assertionsError)throw assertionsError;
 }
 assert.deepEqual(new Set(toolResults.map(item=>item.type)),new Set(['pdf','docx','pptx','xlsx']));assert.equal(client.files.length,1);assert.equal(client.files[0].options.filename,'填写结果.xlsx');
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(client.files[0].buffer);assert.equal(workbook.getWorksheet('Data').getCell('B2').value,70000);assert.equal(workbook.getWorksheet('Data').getCell('C2').formula,'B2*2');assert.equal(workbook.getWorksheet('Data').getCell('A2').font.bold,true);
 const original=new ExcelJS.Workbook();await original.xlsx.readFile(path.join(source,'sample.xlsx'));assert.equal(original.getWorksheet('Data').getCell('B2').value,42);
 assert.ok(client.texts.every(text=>!text.includes('填写结果.xlsx')),'delivery must not depend on the model mentioning a filename');
});
