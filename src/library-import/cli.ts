import { configureUsagePricing } from "../usage/ledger.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { readJson, safePath } from '../knowledge-sync/core.js';
import { isReasoningMode } from '../agent/reasoning.js';
import { libraryConfig } from './config.js';
import { createClassifier } from './classifier.js';
import { LibraryImportService } from './service.js';

const cwd=process.cwd();
const env={...await fs.readFile(path.join(cwd,'.env'),'utf8').then(parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;}),...process.env};
const dataDir=path.resolve(cwd,env.AGENT_DATA_DIR || '.data');
configureUsagePricing(dataDir,env.RESEARCH_PRICING_JSON);
const model={apiKey:env.API_KEY || '',baseUrl:env.BASE_URL || '',modelId:env.MODEL_ID || '',maxTokens:Number(env.MAX_TOKENS || 16384)};
const config=libraryConfig(env);
const service=new LibraryImportService({dataDir,config,modelId:()=>model.modelId,modelConfigured:()=>!!(model.apiKey && model.baseUrl && model.modelId),redact:e=>{
  let message=e instanceof Error?e.message:String(e);for(const secret of [model.apiKey,config.password])if(secret)message=message.split(secret).join('[REDACTED]');return message;
},classifier:()=>createClassifier({...model},effort,undefined,dataDir)});
// Reading preferences does not require a Web process or create a chat/session.
let effort:'off'|'low'|'high'|'max'='low';
for(const sig of ['SIGINT','SIGTERM'] as const)process.once(sig,()=>{void service.close().catch(()=>{});});
try{
  const settings=await readJson<{effort?:unknown}>(await safePath(dataDir,'web-agent-settings.json'),{});
  if(settings.effort!==undefined){if(!isReasoningMode(settings.effort))throw Error('Invalid saved reasoning level.');effort=settings.effort;}
  if(!Number.isSafeInteger(model.maxTokens) || model.maxTokens<1)throw Error('Invalid MAX_TOKENS.');
  await service.init();const run=await service.start();
  console.log(`Library import ${run.id}. Reports: ${service.root}`);
  await service.wait();const report=await service.get(run.id);
  console.log(`Upstream report: ${report.sourceReport || '(none)'}`);
  for(const item of report.items)console.log(`${item.status}: ${JSON.stringify(item.name)}${item.error?` — ${item.error}`:''}`);
  if(report.error)console.error(report.error);
  console.log(`${report.status}: ${JSON.stringify(report.counts)}`);
  if(report.status!=='completed')process.exitCode=report.status==='stopped'?130:1;
}catch(e){console.error(service.redact(e));process.exitCode=1;}
finally{await service.close().catch(e=>{console.error(service.redact(e));process.exitCode=1;});}
