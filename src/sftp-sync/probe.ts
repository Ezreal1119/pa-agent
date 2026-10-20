import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'ssh2';
import { sftpConfig } from './config.js';
import { hostFingerprint } from './client.js';
const cwd=process.cwd();
const env={...await fs.readFile(path.join(cwd,'.env'),'utf8').then(parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;}),...process.env};
const config=sftpConfig(cwd,path.resolve(cwd,env.AGENT_DATA_DIR||'.data'),env);
if(!config.host)throw new Error('Set SFTP_HOST in .env first.');
let observed=false;
const client=new Client();
client.on('error',e=>{if(!observed){console.error(e.message);process.exitCode=1;}});
client.connect({host:config.host,port:config.port,username:config.username||'host-key-probe',readyTimeout:config.timeoutMs,
  ...(config.legacyKex?{algorithms:{kex:{append:['diffie-hellman-group14-sha1'],prepend:[],remove:[]}}}:{}),
  hostVerifier:(key:Buffer)=>{observed=true;console.log(`SFTP_HOST_FINGERPRINT=${hostFingerprint(key)}`);console.log('Observed key only. Verify it with the server administrator before trusting it. No password was sent.');return false;}});
