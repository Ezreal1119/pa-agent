import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { atomic, readJson, safePath, hash, SyncError } from '../knowledge-sync/core.js';
import { connect, type RemoteClient } from './client.js';
import { missingConfig, parsePaths, type SftpConfig } from './config.js';
import { SftpPathsEditor, checkPaths } from './paths-editor.js';

type EntryState = { hash?: string; target?: string; updated?: string; pending?: { hash: string; target: string; stage: string } };
type State = { version: 1; files: Record<string, EntryState> };
export type ImportItem = { path: string; line: number; status: string; attempts: number; bytes?: number; hash?: string; target?: string; error?: string };
export type ImportRun = { id: string; created: string; finished?: string; status: string; items: ImportItem[]; error?: string; counts: Record<string, number> };
type Options = {dataDir: string; config: SftpConfig; connector?: typeof connect};
const active = (status:string) => ['running','stopping'].includes(status);
const now = () => new Date().toISOString();

export class SftpSyncService {
  readonly root: string;
  readonly inbox: string;
  private config: SftpConfig;
  private stateFile: string;
  private editor: SftpPathsEditor;
  private running?: {id:string; controller:AbortController; task:Promise<void>};
  private starting = false;
  private closing = false;
  private recoveryError?: string;
  constructor(private options: Options) {
    this.config = options.config;
    this.root = path.join(options.dataDir,'logs','sftp_sync');
    this.inbox = path.join(options.dataDir,'urovo-product-expert','newly_added');
    this.stateFile = path.join(this.root,'state.json');
    this.editor = new SftpPathsEditor(this.config.pathsFile, this.root);
  }
  readPaths() { return this.editor.read(); }
  checkPaths(text: unknown) { return checkPaths(text); }
  async savePaths(text: unknown, revision: unknown) {
    const release = await this.lock();
    try { return await this.editor.save(text, revision); }
    finally { await release(); }
  }
  redact(error: unknown) {
    let message = error instanceof Error ? error.message : String(error);
    if (this.config.password) message = message.split(this.config.password).join('[REDACTED]');
    return message.replace(/(password|authorization)\s*[:=]\s*\S+/gi,'$1=[REDACTED]').slice(0,1500);
  }
  private async lock() {
    await safePath(this.root); await fs.mkdir(this.root,{recursive:true,mode:0o700});
    const target = path.join(this.root,'runner');
    await safePath(this.root,'runner.lock');
    return lockfile.lock(target,{realpath:false,stale:60000,update:10000,retries:0,onCompromised: error => this.running?.controller.abort(error)}).catch(error => {
      if (error.code === 'ELOCKED') throw new SyncError('An SFTP import is already running. Try again after it finishes.',409);
      throw error;
    });
  }
  async init() {
    const release = await this.lock().catch(e => {if(e instanceof SyncError && e.status===409) return undefined; throw e;});
    if (!release) return;
    try { await this.recover(); this.recoveryError=undefined; } catch(e) { this.recoveryError=this.redact(e); } finally { await release(); }
  }
  private async paths() {
    const file = await safePath(path.dirname(this.config.pathsFile),path.basename(this.config.pathsFile));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4 * 1048576) throw new SyncError('SFTP_PATHS_FILE must be a regular JSONL file up to 4 MiB.');
    const bytes = await fs.readFile(file);
    let text: string;
    try {text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw new SyncError('The SFTP JSONL list must use UTF-8.');}
    return parsePaths(text);
  }
  async status() {
    const missing = missingConfig(this.config);
    let paths = 0, invalid = 0, listError: string | undefined;
    try {const entries=await this.paths(); paths=entries.filter(e=>!e.error).length;invalid=entries.length-paths;}
    catch(e) {listError=this.redact(e);}
    // Never return connection credentials or a config object to the browser.
    const reports=await this.list();
    return {configured:!missing.length,missing,listError,recoveryError:this.recoveryError,paths,invalid,pathsFile:this.config.pathsFile,maxFileBytes:this.config.maxBytes,running:this.running?.id || reports.find(r=>active(r.status))?.id,reports};
  }
  async list() {
    await safePath(this.root);
    const names = await fs.readdir(this.root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const candidates = await Promise.all(names.filter(n=>/^[a-f0-9-]{36}\.summary\.json$/.test(n)).map(async name=>({name,mtime:(await fs.lstat(await safePath(this.root,name))).mtimeMs})));
    candidates.sort((a,b)=>b.mtime-a.mtime);
    return Promise.all(candidates.slice(0,100).map(({name})=>readJson<Omit<ImportRun,'items'>>(path.join(this.root,name),null!)));
  }

  async get(id: string): Promise<ImportRun> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SyncError('Import report not found.',404);
    const run=await readJson<ImportRun|undefined>(path.join(this.root,`${id}.json`),undefined);
    if(!run)throw new SyncError('Import report not found.',404);return run;
  }
  private async save(run: ImportRun) {
    run.counts={};for(const item of run.items)run.counts[item.status]=(run.counts[item.status]||0)+1;
    await atomic(path.join(this.root,`${run.id}.json`),JSON.stringify(run,null,2)+'\n');
    const {items,...summary}=run;
    await atomic(path.join(this.root,`${run.id}.summary.json`),JSON.stringify(summary)+'\n');
  }
  private async event(run:ImportRun, type:string, item?:ImportItem) {
    const file=await safePath(this.root,`${run.id}.jsonl`);
    await fs.appendFile(file,JSON.stringify({time:now(),type,...(item?{item}:{}),status:run.status})+'\n',{mode:0o600});
  }
  private async readState() {
    const state=await readJson<State>(this.stateFile,{version:1,files:{}});
    if(state.version!==1 || !state.files || Array.isArray(state.files))throw new SyncError('Invalid SFTP state; restore state.json from a trusted backup before importing.');
    for(const [key,e] of Object.entries(state.files)) {
      if(!/^[a-f0-9]{64}$/.test(key) || !e || typeof e!=='object' || Array.isArray(e) || e.hash && !/^[a-f0-9]{64}$/.test(e.hash) || e.pending && (!/^[a-f0-9]{64}$/.test(e.pending.hash) || !/^[a-f0-9-]{36}\.part$/.test(e.pending.stage) || !this.validTarget(e.pending.target)))throw new SyncError('Invalid SFTP state entry; refusing to import.');
    }
    return state;
  }
  private validTarget(name:string) {return typeof name==='string' && !!name && name===path.basename(name) && !name.startsWith('.') && !/[\\\x00-\x1f\x7f]/.test(name);}
  private async saveState(state:State) {await atomic(this.stateFile,JSON.stringify(state,null,2)+'\n');}
  private async digest(file:string) {
    await safePath(path.dirname(file),path.basename(file));
    const handle=await fs.open(file,'r');const h=createHash('sha256');
    try {for await (const chunk of handle.createReadStream({autoClose:false}))h.update(chunk);}finally{await handle.close();}
    return h.digest('hex');
  }
  private async syncDir(dir:string) {const handle=await fs.open(dir,'r');try{await handle.sync();}finally{await handle.close();}}
  private async publish(entry:EntryState,state:State) {
    const pending=entry.pending!;
    const stage=path.join(this.root,'work',pending.stage),target=path.join(this.inbox,pending.target);
    // A crash may leave our two known hardlinks. Remove the private staging link
    // only after proving it is the same regular inode as the complete inbox file.
    await safePath(this.inbox);
    await safePath(this.root,'work');
    const [s,t]=await Promise.all([fs.lstat(stage).catch(e=>{if(e.code==='ENOENT')return;throw e;}),fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return;throw e;})]);
    if(s?.isSymbolicLink() || t?.isSymbolicLink() || s && !s.isFile() || t && !t.isFile())throw new SyncError('Unsafe import publication path.');
    if(s && t && s.ino===t.ino && s.dev===t.dev)await fs.unlink(stage);
    else if(t) {
      if(await this.digest(target)===pending.hash)await fs.rm(stage,{force:true});
      else if(!s)throw new SyncError('Pending inbox file changed; publication requires manual review.');
      else if(await this.digest(stage)!==pending.hash)throw new SyncError('Pending delivery cannot be verified. Preserve state and reports for manual recovery.');
      else {
        // Replace an unsynced copy atomically: exclusive hardlink then rename.
        const replacement=`.sftp-${randomUUID()}.part`;
        await fs.link(stage,await safePath(this.inbox,replacement));
        try {await fs.rename(path.join(this.inbox,replacement),target);} finally {await fs.rm(path.join(this.inbox,replacement),{force:true});}
        await fs.unlink(stage);
      }
    } else {
      if(!s || await this.digest(stage)!==pending.hash)throw new SyncError('Pending delivery cannot be verified. Preserve state and reports for manual recovery.');
      await fs.link(stage,target); // atomic, complete file, exclusive
      await fs.unlink(stage);
    }
    await this.syncDir(this.inbox);
    const previous={...entry};
    entry.hash=pending.hash;entry.target=pending.target;entry.updated=now();delete entry.pending;
    try {await this.saveState(state);} catch(e) {
      delete entry.hash;delete entry.target;delete entry.updated;Object.assign(entry,previous);throw e;
    }
    await fs.rm(stage,{force:true});
  }
  private async recover() {
    const state=await this.readState();
    for(const entry of Object.values(state.files))if(entry.pending)await this.publish(entry,state);
    const names=await fs.readdir(this.root);
    for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))) {
      const run=await this.get(name.slice(0,-5));
      if(active(run.status)) {
        run.status='interrupted';run.finished=now();
        for(const item of run.items)if(['pending','downloading'].includes(item.status)){item.status='interrupted';item.error='Service stopped before this item completed. Run the import again; committed hashes remain saved.';}
        await this.save(run);await this.event(run,'interrupted');
      }
    }
    const work=await safePath(this.root,'work');await fs.mkdir(work,{recursive:true,mode:0o700});
    for(const file of await fs.readdir(work))if(/^[a-f0-9-]{36}\.part$/.test(file))await fs.unlink(await safePath(work,file));
    for(const file of await fs.readdir(this.inbox).catch((e:{code?:string})=>{if(e.code==='ENOENT')return [];throw e;}))
      if(/^\.sftp-[a-f0-9-]{36}\.part$/.test(file))await fs.unlink(path.join(this.inbox,file)).catch(()=>{});
  }
  async start():Promise<ImportRun> {
    if(this.closing || this.starting || this.running)throw new SyncError('An SFTP import is running or shutting down.',409);
    this.starting=true;let release:(()=>Promise<void>)|undefined;
    try {
      const missing=missingConfig(this.config);if(missing.length)throw new SyncError(`Configure ${missing.join(', ')} in .env, then restart.`,409);
      if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(this.config.fingerprint))throw new SyncError('SFTP_HOST_FINGERPRINT must be an OpenSSH SHA256 fingerprint.');
      release=await this.lock();await this.recover();this.recoveryError=undefined;
      const entries=await this.paths();
      if(this.closing)throw new SyncError('SFTP importer is shutting down.',409);
      const run:ImportRun={id:randomUUID(),created:now(),status:'running',items:entries.map(e=>({...e,status:e.error?'failed':'pending',attempts:0})),counts:{}};
      await this.save(run);await this.event(run,'started');
      const controller=new AbortController(),unlock=release;release=undefined;
      const stopFile=path.join(this.root,`${run.id}.stop`);
      // An active import must keep the CLI alive even while only unreferenced
      // deadline/lock timers remain (notably on Node 22). Cleared in finally.
      const watch=setInterval(()=>{void fs.lstat(stopFile).then(()=>controller.abort(new Error('Stopped by administrator.'))).catch(e=>{if(e.code!=='ENOENT')controller.abort(e);});},1000);
      const task=Promise.resolve().then(()=>this.execute(run,controller.signal)).catch(async e=>{
        run.status=controller.signal.aborted?'stopped':'failed';run.error=this.redact(e);run.finished=now();
        for(const item of run.items)if(['pending','downloading'].includes(item.status)){item.status=controller.signal.aborted?'stopped':'failed';item.error=run.error;}
        await this.save(run);await this.event(run,'failed');
      }).finally(async()=>{clearInterval(watch);try{await fs.rm(stopFile,{force:true});}finally{try{await unlock();}finally{this.running=undefined;}}});
      this.running={id:run.id,controller,task};
      if(this.closing)controller.abort(new Error('Service shutting down.'));
      // Attach immediately: disk/report failures must not become unhandled rejections.
      void task.catch(()=>{});
      return structuredClone(run);
    } finally {this.starting=false;if(release)await release();}
  }
  private identity(remotePath:string) {return hash(JSON.stringify([this.config.host,this.config.port,this.config.username,remotePath]));}
  private async execute(run:ImportRun,signal:AbortSignal) {
    await safePath(this.inbox);await fs.mkdir(this.inbox,{recursive:true,mode:0o700});
    const state=await this.readState();
    let abortBatch=false;
    for(const item of run.items) {
      if(item.status==='failed')continue;
      if(signal.aborted || abortBatch){item.status=signal.aborted?'stopped':'not_attempted';item.error=signal.aborted?'Stopped before this file started.':'Not attempted after a connection, storage or publication failure; see the failed item.';continue;}
      const key=this.identity(item.path),entry=state.files[key] || {};
      item.status='downloading';await this.save(run);
      for(let attempt=1;attempt<=this.config.attempts;attempt++) {
        item.attempts=attempt;await this.save(run);
        const part=`${randomUUID()}.part`,stage=await safePath(this.root,`work/${part}`);
        let remote:RemoteClient|undefined;
        const timed=AbortSignal.any([signal,AbortSignal.timeout(this.config.fileTimeoutMs)]);
        try {
          remote=await (this.options.connector||connect)(this.config,timed);
          const before=await remote.stat(item.path);
          if(!before.isFile())throw Object.assign(new Error('Remote path is not a regular file.'),{code:'INVALID_FILE'});
          if(!Number.isSafeInteger(before.size) || before.size<0 || before.size>this.config.maxBytes)throw Object.assign(new Error('Remote file exceeds the 100 MB import limit.'),{code:'INVALID_FILE'});
          const disk=await fs.statfs(this.root);
          if(disk.bavail*disk.bsize < this.config.reserveBytes+before.size)throw Object.assign(new Error('Insufficient local disk space; free disk space and retry.'),{code:'ENOSPC'});
          const digest=createHash('sha256');let bytes=0;
          {
            await pipeline(remote.read(item.path),new Transform({transform:(chunk,_,cb)=>{
              bytes+=chunk.length;
              if(bytes>this.config.maxBytes || bytes>before.size){cb(Object.assign(new Error('Remote file grew while downloading or exceeded the limit.'),{code:'REMOTE_CHANGED'}));return;}
              digest.update(chunk);cb(null,chunk);
            }}),createWriteStream(stage,{flags:'wx',mode:0o600,flush:true}),{signal:timed});
          }
          const after=await remote.stat(item.path);
          if(!after.isFile() || before.size!==after.size || before.mtime!==after.mtime || bytes!==before.size)throw Object.assign(new Error('Remote file changed or download was incomplete; no file published.'),{code:'REMOTE_CHANGED'});
          item.bytes=bytes;item.hash=digest.digest('hex');
          if(entry.hash===item.hash){item.status='unchanged';item.target=entry.target;await fs.unlink(stage);break;}
          const name=path.posix.basename(item.path);
          if(!this.validTarget(name))throw new Error('Unsafe local filename.');
          const target=name;
          entry.pending={hash:item.hash,target,stage:part};state.files[key]=entry;
          await this.saveState(state);
          await this.publish(entry,state);
          item.target=target;item.status='downloaded';break;
        } catch(e) {
          if(entry.pending) { // Never retry a possibly committed publication as a new download.
            item.error=`Delivery interrupted: ${this.redact(e)}. State retained for recovery.`;item.status='failed';abortBatch=true;break;
          }
          item.error=this.redact(e);
          const code=(e as NodeJS.ErrnoException).code;
          const permanent=['HOST_KEY_MISMATCH','INVALID_FILE','ENOSPC','EACCES','EPERM','ELOOP','ENAMETOOLONG'].includes(code||'') || ['2','3'].includes(String(code)) || /authentication|fingerprint|permission denied|no matching|host denied|handshake failed/i.test(item.error);
          if(['HOST_KEY_MISMATCH','ENOSPC'].includes(code||'') || /authentication|fingerprint|no matching|host denied|handshake failed/i.test(item.error))abortBatch=true;
          if(signal.aborted){item.status='stopped';break;}
          if(permanent || attempt===this.config.attempts){if(!remote)abortBatch=true;item.status='failed';break;}
          remote?.close();remote=undefined;
          await delay(500*2**(attempt-1),undefined,{signal}).catch(()=>{});
        } finally {
          remote?.close();
          if(!entry.pending)await fs.rm(stage,{force:true});
        }
      }
      if(['downloaded','unchanged'].includes(item.status))delete item.error;
      await this.save(run);await this.event(run,'file_finished',item);
    }
    run.status=signal.aborted?'stopped':run.items.some(i=>['failed','not_attempted'].includes(i.status))?'completed_with_errors':'completed';
    run.finished=now();await this.save(run);await this.event(run,'finished');
  }
  async stop(id:string) {const run=await this.get(id);if(active(run.status)){if(this.running?.id===id)this.running.controller.abort(new Error('Stopped by administrator.'));else await atomic(path.join(this.root,`${id}.stop`),'stop\n');}return run;}
  async wait() {await this.running?.task;}
  async close() {this.closing=true;this.running?.controller.abort(new Error('Service shutting down.'));await this.wait();}
}
