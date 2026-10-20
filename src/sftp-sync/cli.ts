import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { sftpConfig } from './config.js';
import { SftpSyncService } from './service.js';

const cwd=process.cwd();
const env={...await fs.readFile(path.join(cwd,'.env'),'utf8').then(parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;}),...process.env};
const dataDir=path.resolve(cwd,env.AGENT_DATA_DIR||'.data');
const service=new SftpSyncService({dataDir,config:sftpConfig(cwd,dataDir,env)});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void service.close();});
try {
  await service.init();const run=await service.start();
  console.log(`SFTP import ${run.id} started. Reports: ${service.root}`);
  await service.wait();const report=await service.get(run.id);
  for(const item of report.items)console.log(`${item.status}: ${item.path || `JSONL line ${item.line}`}${item.error?` — ${item.error}`:''}`);
  console.log(`${report.status}: ${JSON.stringify(report.counts)}`);
  if(report.status!=='completed')process.exitCode=report.status==='stopped'?130:1;
} catch(e){console.error(service.redact(e));process.exitCode=1;}
finally{await service.close();}
