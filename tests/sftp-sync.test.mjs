import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { SftpSyncService } from '../dist/sftp-sync/service.js';
import { sftpConfig,parsePaths } from '../dist/sftp-sync/config.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t, entries=['/os/修改记录.xlsx'], connector) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sftp-import-')),dataDir=path.join(root,'.data');
  await fs.mkdir(dataDir,{recursive:true});
  const pathsFile=path.join(dataDir,'list.jsonl');
  await fs.writeFile(pathsFile,entries.map(path=>JSON.stringify({path})).join('\n'));
  const config={...sftpConfig(root,dataDir,{}),host:'fixture-host',username:'fixture-user',password:'fixture-password-SECRET',fingerprint:'SHA256:'+'A'.repeat(43),pathsFile,reserveBytes:0,attempts:2,fileTimeoutMs:3000};
  let bytes=Buffer.from('fixture xlsx data'),calls=0;
  const service=new SftpSyncService({dataDir,config,connector:connector||(async()=>({stat:async()=>({size:bytes.length,mtime:123,isFile:()=>true}),read:()=>{calls++;return Readable.from([bytes]);},close(){}}))});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
  await service.init();
  const run=async()=>{const job=await service.start();await service.wait();return service.get(job.id);};
  return {root,dataDir,config,service,run,setBytes:b=>{bytes=b;},get calls(){return calls;}};
}
test('SFTP path-only JSONL validates traversal, reserved names, malformed lines and deduplicates without leaking invalid JSON',()=>{
  const entries=parsePaths('\uFEFF'+['{"path":"/os/产品.xlsx"}','{"path":"/os/产品.xlsx"}','{"path":"/../etc/passwd"}','{"path":"/os/a.txt","id":"x"}','{"password":"do-not-echo"}','oops','{"path":"/SKILL.md"}','{"path":"/README.md"}','{"path":"/os/file.exe"}'].join('\n'));
  assert.equal(entries.length,8);assert.equal(entries.filter(e=>!e.error).length,1);
  assert(!JSON.stringify(entries).includes('do-not-echo'));
});
test('SFTP streams complete files, keeps hash after Sync removes original, delivers changed contents without overwrite, and keeps private reports', {timeout:15000},async t=>{
  const f=await fixture(t);
  let report=await f.run();assert.equal(report.status,'completed');assert.equal(report.items[0].status,'downloaded');
  const target=path.join(f.service.inbox,report.items[0].target);
  assert.equal((await fs.readFile(target)).toString(),'fixture xlsx data');
  assert.equal(report.items[0].hash,sha(await fs.readFile(target)));
  report=await f.run();assert.equal(report.items[0].status,'unchanged');assert.equal(f.calls,2);
  await fs.unlink(target);report=await f.run();assert.equal(report.items[0].status,'unchanged');assert.deepEqual(await fs.readdir(f.service.inbox),[]);
  f.setBytes(Buffer.from('new file'));report=await f.run();assert.equal(report.items[0].status,'downloaded');
  const original=path.join(f.service.inbox,report.items[0].target);
  f.setBytes(Buffer.from('third version'));report=await f.run();assert.equal(report.items[0].status,'downloaded');assert.notEqual(report.items[0].target,path.basename(original));
  assert.equal((await fs.readFile(original)).toString(),'new file');
  assert.deepEqual(await fs.readdir(path.join(f.service.root,'work')),[]);
  assert.equal((await fs.stat(path.join(f.service.root,report.id+'.json'))).mode & 0o777,0o600);
  const saved=(await Promise.all((await fs.readdir(f.service.root)).filter(n=>n.endsWith('.json')).map(n=>fs.readFile(path.join(f.service.root,n),'utf8')))).join('');
  assert(!saved.includes(f.config.password));assert(!JSON.stringify(await f.service.status()).includes(f.config.username));
});
test('SFTP partial failures continue, retries are bounded, remote changes are rejected and password is redacted',async t=>{
  let first=true;
  const f=await fixture(t,['/missing.pdf','/changed.txt','/good.md'],async()=>({
    stat:async p=>{if(p==='/missing.pdf')throw Object.assign(new Error('No such file fixture-password-SECRET'),{code:2});const changed=p==='/changed.txt';const mtime=changed?(first?1:2):1;first=false;return {size:3,mtime,isFile:()=>true};},
    read:()=>Readable.from([Buffer.from('abc')]),close(){},
  }));
  // Ensure every changed file's post-stat is inconsistent, on all retries.
  let check=0;
  f.service.options.connector=async()=>({stat:async p=>{
    if(p==='/missing.pdf')throw Object.assign(new Error('No such file fixture-password-SECRET'),{code:2});
    return {size:3,mtime:p==='/changed.txt'?++check:1,isFile:()=>true};},read:()=>Readable.from([Buffer.from('abc')]),close(){}});
  const report=await f.run();assert.equal(report.status,'completed_with_errors');assert.deepEqual(report.items.map(i=>i.status),['failed','failed','downloaded']);
  assert.deepEqual(report.items.map(i=>i.attempts),[1,2,1]);assert(report.items[0].error.includes('[REDACTED]'));assert(!JSON.stringify(report).includes(f.config.password));
  const state=JSON.parse(await fs.readFile(path.join(f.service.root,'state.json')));assert.equal(Object.keys(state.files).length,1);
  assert.equal((await fs.readdir(f.service.inbox)).length,1);
});
test('SFTP lock rejects parallel CLI/service, stop cancels stream and does not advance hash',async t=>{
  let unblock;const started=new Promise(r=>unblock=r);
  const f=await fixture(t,['/slow.txt'],async(_config,signal)=>({stat:async()=>({size:10,mtime:1,isFile:()=>true}),read:()=>{
    const stream=new Readable({read(){unblock();}});signal.addEventListener('abort',()=>stream.destroy(new Error('cancelled')),{once:true});return stream;},close(){}}));
  const job=await f.service.start();await started;
  const other=new SftpSyncService({dataDir:f.dataDir,config:f.config});await other.init();
  await assert.rejects(()=>other.start(),/already running/);await assert.rejects(()=>f.service.start(),/running/);
  assert.equal((await other.status()).running,job.id);await other.stop(job.id);await f.service.wait();const report=await f.service.get(job.id);assert.equal(report.status,'stopped');assert.equal(report.items[0].status,'stopped');
  assert.deepEqual(await fs.readdir(f.service.inbox),[]);assert.deepEqual(await fs.readdir(path.join(f.service.root,'work')),[]);
  assert.equal(await fs.readFile(path.join(f.service.root,'state.json'),'utf8').catch(e=>e.code),'ENOENT');await other.close();
});
test('SFTP recovery commits verified complete pending publication, marks old runs interrupted and fails closed on changed target',async t=>{
  const f=await fixture(t,['/good.txt']);await fs.mkdir(f.service.inbox,{recursive:true});
  const stage='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.part',target='recovered.txt',bytes=Buffer.from('complete');
  await fs.writeFile(path.join(f.service.root,'work',stage),bytes);
  await fs.link(path.join(f.service.root,'work',stage),path.join(f.service.inbox,target));
  const state={version:1,files:{['a'.repeat(64)]:{pending:{hash:sha(bytes),target,stage}}}};
  await fs.writeFile(path.join(f.service.root,'state.json'),JSON.stringify(state));
  const id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';await fs.writeFile(path.join(f.service.root,id+'.json'),JSON.stringify({id,created:new Date().toISOString(),status:'running',items:[{path:'/old.txt',line:1,status:'downloading',attempts:1}],counts:{}}));
  await f.service.init();assert.equal((await f.service.get(id)).status,'interrupted');
  const saved=JSON.parse(await fs.readFile(path.join(f.service.root,'state.json')));assert.equal(saved.files['a'.repeat(64)].hash,sha(bytes));assert(!saved.files['a'.repeat(64)].pending);
  assert.equal((await fs.stat(path.join(f.service.inbox,target))).nlink,1);
  state.files['a'.repeat(64)].pending={hash:sha(Buffer.from('wrong')),target,stage};await fs.writeFile(path.join(f.service.root,'state.json'),JSON.stringify(state));
  await f.service.init();assert.match((await f.service.status()).recoveryError,/changed/);await assert.rejects(()=>f.service.start(),/changed/);assert.equal((await fs.readFile(path.join(f.service.inbox,target))).toString(),'complete');
});
test('SFTP missing settings, symlink inputs/inbox, oversized file and bad state never deliver',async t=>{
  const f=await fixture(t,['/large.pdf'],async()=>({stat:async()=>({size:101*1048576,mtime:1,isFile:()=>true}),read:()=>{throw Error('must not read');},close(){}}));
  let report=await f.run();assert.equal(report.items[0].status,'failed');assert.equal(report.items[0].attempts,1);
  await fs.unlink(f.config.pathsFile);await fs.writeFile(path.join(f.root,'real.jsonl'),'{"path":"/a.txt"}');await fs.symlink(path.join(f.root,'real.jsonl'),f.config.pathsFile);
  await assert.rejects(()=>f.service.start(),/Linked paths/);
  await fs.unlink(f.config.pathsFile);await fs.writeFile(f.config.pathsFile,'{"path":"/a.txt"}');
  await fs.rm(f.service.inbox,{recursive:true});await fs.symlink(f.root,f.service.inbox);
  report=await f.run();assert.equal(report.status,'failed');assert.match(report.error,/Linked paths/);
  const missing=new SftpSyncService({dataDir:f.dataDir,config:{...f.config,password:''}});await assert.rejects(()=>missing.start(),/SFTP_PASSWORD/);
});

test('real SSH/SFTP transport pins host before password, supports explicit legacy KEX, and streams read-only protocol',async t=>{
  const {Server,utils}=(await import('ssh2')).default;const {generateKeyPairSync}=await import('node:crypto');const {once}=await import('node:events');
  const {connect,hostFingerprint}=await import('../dist/sftp-sync/client.js');
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const publicKey=utils.parseKey(privateKey).getPublicSSH(),content=Buffer.from('real sftp bytes'),connections=new Set();let auths=0;
  const server=new Server({hostKeys:[privateKey],algorithms:{kex:['diffie-hellman-group14-sha1']}},client=>{
    connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));
    client.on('authentication',ctx=>{auths++;if(ctx.method==='password' && ctx.username==='test-user' && ctx.password==='test-password')ctx.accept();else ctx.reject(['password']);});
    client.on('ready',()=>client.on('session',accept=>accept().on('sftp',accept=>{
      const s=accept();s.on('FSTAT',(id)=>s.attrs(id,{mode:0o100644,uid:0,gid:0,size:content.length,atime:1,mtime:1}));s.on('STAT',(id)=>s.attrs(id,{mode:0o100644,uid:0,gid:0,size:content.length,atime:1,mtime:1}));s.on('LSTAT',(id,p)=>p==='/a.txt'?s.attrs(id,{mode:0o100644,uid:0,gid:0,size:content.length,atime:1,mtime:1}):s.status(id,2));
      s.on('OPEN',(id,p,flags)=>{assert.equal(flags,utils.sftp.OPEN_MODE.READ);if(p==='/a.txt')s.handle(id,Buffer.from('h'));else s.status(id,2);});
      s.on('READ',(id,_handle,offset,length)=>offset>=content.length?s.status(id,1):s.data(id,content.subarray(offset,offset+length)));
      s.on('CLOSE',id=>s.status(id,0));
    })));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const c of connections)c.end();await new Promise(r=>server.close(r));});
  const config={...sftpConfig(process.cwd(),process.cwd(),{}),host:'127.0.0.1',port:server.address().port,username:'test-user',password:'test-password',fingerprint:hostFingerprint(publicKey),timeoutMs:2000};
  await assert.rejects(()=>connect(config,AbortSignal.timeout(3000)),/key exchange/);assert.equal(auths,0);
  config.legacyKex=true;
  await assert.rejects(()=>connect({...config,fingerprint:'SHA256:'+'A'.repeat(43)},AbortSignal.timeout(3000)),/fingerprint/);assert.equal(auths,0);
  const client=await connect(config,AbortSignal.timeout(3000));
  try {assert.equal((await client.stat('/a.txt')).size,content.length);const chunks=[],stream=client.read('/a.txt'),closed=once(stream,'close');for await(const c of stream)chunks.push(c);await closed;assert.deepEqual(Buffer.concat(chunks),content);}
  finally {client.close();}
  assert(auths>=1);
});

test('SFTP transient network failure retries successfully; disk exhaustion stops remaining paths without hashes',async t=>{
  let attempts=0,reads=0;
  const f=await fixture(t,['/one.txt','/two.txt'],async()=>{
    if(++attempts===1)throw Object.assign(new Error('temporary network reset'),{code:'ECONNRESET'});
    return {stat:async()=>({size:3,mtime:1,isFile:()=>true}),read:()=>{reads++;return Readable.from([Buffer.from('abc')]);},close(){}};
  });
  let report=await f.run();assert.equal(report.status,'completed');assert.equal(report.items[0].attempts,2);assert.equal(reads,2);assert(!report.items[0].error);
  const before=await fs.readFile(path.join(f.service.root,'state.json'),'utf8');
  f.config.reserveBytes=Number.MAX_SAFE_INTEGER;
  report=await f.run();assert.deepEqual(report.items.map(i=>i.status),['failed','not_attempted']);assert.equal(reads,2);assert.match(report.items[0].error,/disk space/);
  assert.equal(await fs.readFile(path.join(f.service.root,'state.json'),'utf8'),before);
});

test('SFTP outage stops the batch after bounded connection retries and malformed JSONL lines are retained in its report',async t=>{
 let connections=0;
 const f=await fixture(t,['/one.txt','/two.txt'],async()=>{connections++;throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'});});
 const original=await fs.readFile(f.config.pathsFile,'utf8');await fs.writeFile(f.config.pathsFile,'{"path":"/a.txt","extra":"not accepted"}\n'+original);
 const report=await f.run();assert.equal(report.status,'completed_with_errors');assert.equal(connections,2);
 assert.deepEqual(report.items.map(i=>i.status),['failed','failed','not_attempted']);
 assert.deepEqual(report.items.map(i=>i.attempts),[0,2,0]);assert.equal(report.items[0].line,1);assert.match(report.items[0].error,/only/);
 assert.match(report.items[2].error,/connection/);assert.deepEqual(await fs.readdir(f.service.inbox),[]);
});

test('SFTP shutdown racing task creation never opens a new network connection',async t=>{
 let calls=0;const f=await fixture(t,['/file.txt'],async()=>{calls++;throw Error('network must remain closed');});
 const starting=f.service.start(),closing=f.service.close();
 const [result]=await Promise.allSettled([starting,closing]);
 assert.equal(result.status,'rejected');assert.match(result.reason.message,/shutting down/);assert.equal(calls,0);
 assert.equal((await f.service.status()).running,undefined);
});

test('SFTP child process stays alive until a quiet transfer times out, records failure, then exits without a leaked timer',async t=>{
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const {pathToFileURL}=await import('node:url');
  const f=await fixture(t,['/quiet.txt']);
  const script=`
    import {Readable} from 'node:stream';
    import {SftpSyncService} from ${JSON.stringify(pathToFileURL(path.resolve('dist/sftp-sync/service.js')).href)};
    const config=JSON.parse(process.argv[2]);
    const service=new SftpSyncService({dataDir:process.argv[1],config,connector:async(_config,signal)=>({
      stat:async()=>({size:10,mtime:1,isFile:()=>true}),
      read:()=>{
        const stream=new Readable({read(){}});
        const abort=()=>stream.destroy(new Error('Transfer deadline reached.'));
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
        return stream;
      },
      close(){}
    })});
    try {
      await service.init();
      const run=await service.start();
      await service.wait();
      const report=await service.get(run.id);
      console.log(JSON.stringify({status:report.status,itemStatus:report.items[0].status,attempts:report.items[0].attempts}));
    } finally {await service.close();}
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,f.dataDir,JSON.stringify({...f.config,fileTimeoutMs:250,attempts:1})],{timeout:15000});
  assert.deepEqual(JSON.parse(stdout.trim()),{status:'completed_with_errors',itemStatus:'failed',attempts:1});
  assert.equal((await f.service.status()).reports[0].status,'completed_with_errors');
  assert.deepEqual(await fs.readdir(f.service.inbox),[]);
  assert.deepEqual(await fs.readdir(path.join(f.service.root,'work')),[]);
  assert.equal(await fs.readFile(path.join(f.service.root,'state.json'),'utf8').catch(e=>e.code),'ENOENT');
});
