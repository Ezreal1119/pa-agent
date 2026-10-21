import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import lockfile from 'proper-lockfile';
import { atomic, readJson, safePath, hash, SyncError, emptyUsage, type Usage } from '../knowledge-sync/core.js';
import { checkBase, missingConfig, EXTENSIONS, MAX_BYTES, RESERVE_BYTES, type LibraryConfig } from './config.js';
import { CATEGORIES, type Metadata, type Classification, type Classifier } from './classifier.js';
import { ImportError, jsonRequest, request, retry, transient, deadline } from './http.js';
import { verify } from './verify.js';

export type LibraryItem = {
  key:string; change:'added'|'updated'; name:string; documentType:string; displayPath:string;
  url?:string; size?:number; status:string; reason?:string; error?:string; attempts:number;
  stage?:string; category?:string; classificationCached?:boolean; model?:string; usage:Usage; hash?:string; bytes?:number; target?:string;
};
export type LibraryRun = {id:string;created:string;finished?:string;status:string;sourceReport?:string;sourceCompletedAt?:string;sourceBase:string;model?:string;items:LibraryItem[];counts:Record<string,number>;usage:Usage;error?:string};
type Pending = {hash:string;target:string;stage:string;completion:string;run:string};
type SourceState = {delivered:Record<string,{target:string;time:string}>;pending?:Pending};
type State = {version:1;sources:Record<string,SourceState>;completed:Record<string,{status:string;hash?:string;target?:string}>;classifications:Record<string,Classification>};
type Options = {dataDir:string;config:LibraryConfig;classifier:()=>Classifier;modelConfigured:()=>boolean;modelId?:()=>string;redact?:(error:unknown)=>string;transport?:{json:typeof jsonRequest;request:typeof request};verify?:typeof verify;disk?:(bytes:number)=>Promise<void>};
const now=()=>new Date().toISOString();
const active=(s:string)=>s==='running' || s==='stopping';
const hashPattern=/^[a-f0-9]{64}$/;
const runPattern=/^[a-f0-9-]{36}$/;
const pendingStatuses=['pending','classifying','downloading','validating','publishing'];
function addUsage(to:Usage,delta:Usage){to.input+=delta.input;to.output+=delta.output;to.requests+=delta.requests;to.recorded+=delta.recorded;}

export class LibraryImportService {
  readonly root:string;readonly inbox:string;
  private running?:{id:string;controller:AbortController;task:Promise<void>};
  private starting?:Promise<LibraryRun>;
  private closing=false;
  private recoveryError?:string;
  constructor(private options:Options){this.root=path.join(options.dataDir,'logs','library_sync');this.inbox=path.join(options.dataDir,'urovo-product-expert','newly_added');}
  redact(error:unknown){let text=this.options.redact?.(error) ?? (error instanceof Error?error.message:String(error));if(this.options.config.password)text=text.split(this.options.config.password).join('[REDACTED]');return text.slice(0,2000);}
  private async lock(){
    await safePath(this.root);await fs.mkdir(this.root,{recursive:true,mode:0o700});await safePath(this.root,'runner.lock');
    return lockfile.lock(path.join(this.root,'runner'),{realpath:false,stale:60000,update:10000,retries:0,onCompromised:e=>this.running?.controller.abort(e)}).catch(e=>{if(e.code==='ELOCKED')throw new SyncError('A library import is already running.',409);throw e;});
  }
  private validName(name:unknown):name is string{return typeof name==='string' && !!name && Buffer.byteLength(name)<=240 && name===path.basename(name) && !name.startsWith('.') && !/[\\/\x00-\x1f\x7f]/.test(name) && EXTENSIONS.has(path.extname(name).toLowerCase());}
  private async state():Promise<State>{
    const s=await readJson<State>(path.join(this.root,'state.json'),{version:1,sources:{},completed:{},classifications:{}});
    const record=(x:unknown):x is Record<string,any>=>!!x && typeof x==='object' && !Array.isArray(x);
    if(s.version!==1 || !record(s.sources) || !record(s.completed) || !record(s.classifications))throw new Error('Invalid library state. Restore a trusted state.json; it will not be reset automatically.');
    for(const [key,e] of Object.entries(s.sources)){
      if(!hashPattern.test(key) || !record(e) || !record(e.delivered))throw new Error('Invalid library source state.');
      for(const [digest,d] of Object.entries(e.delivered))if(!hashPattern.test(digest) || !record(d) || !this.validName(d.target) || typeof d.time!=='string')throw new Error('Invalid library delivery state.');
      const p=e.pending;if(p && (!record(p) || !hashPattern.test(p.hash) || !hashPattern.test(p.completion) || !runPattern.test(p.run) || !/^[a-f0-9-]{36}\.part$/.test(p.stage) || !this.validName(p.target)))throw new Error('Invalid pending library publication.');
    }
    for(const [key,e] of Object.entries(s.completed))if(!hashPattern.test(key) || !record(e) || typeof e.status!=='string' || e.hash && !hashPattern.test(e.hash) || e.target && !this.validName(e.target))throw new Error('Invalid library completion state.');
    for(const [key,c] of Object.entries(s.classifications))if(!hashPattern.test(key) || !record(c) || !CATEGORIES.includes(c.category) || typeof c.reason!=='string' || c.reason.length>2000 || typeof c.model!=='string')throw new Error('Invalid library classification cache.');
    return s;
  }
  private async saveState(state:State){await atomic(path.join(this.root,'state.json'),JSON.stringify(state,null,2)+'\n');}
  private async save(run:LibraryRun){
    run.counts={};for(const item of run.items)run.counts[item.status]=(run.counts[item.status]||0)+1;
    await atomic(path.join(this.root,`${run.id}.json`),JSON.stringify(run,null,2)+'\n');
    const {items,...summary}=run;await atomic(path.join(this.root,`${run.id}.summary.json`),JSON.stringify(summary)+'\n');
  }
  private async event(run:LibraryRun,type:string,item?:LibraryItem){await fs.appendFile(await safePath(this.root,`${run.id}.jsonl`),JSON.stringify({time:now(),type,status:run.status,sourceReport:run.sourceReport,...(item?{item}:{})})+'\n',{mode:0o600});}
  async get(id:string):Promise<LibraryRun>{if(!runPattern.test(id))throw new SyncError('Library import report not found.',404);const r=await readJson<LibraryRun|undefined>(path.join(this.root,`${id}.json`),undefined);if(!r)throw new SyncError('Library import report not found.',404);return r;}
  async list(){
    const names=await fs.readdir(await safePath(this.root)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const candidates=await Promise.all(names.filter(n=>/^[a-f0-9-]{36}\.summary\.json$/.test(n)).map(async name=>({name,mtime:(await fs.lstat(await safePath(this.root,name))).mtimeMs})));
    candidates.sort((a,b)=>b.mtime-a.mtime);
    return Promise.all(candidates.slice(0,100).map(c=>readJson<Omit<LibraryRun,'items'>>(path.join(this.root,c.name),null!)));
  }
  async status(){
    const missing=missingConfig(this.options.config);if(!this.options.modelConfigured())missing.push('API_KEY / BASE_URL / MODEL_ID');
    let configurationError:string|undefined;if(this.options.config.baseUrl)try{checkBase(this.options.config);}catch(e){configurationError=this.redact(e);}
    let reports=await this.list();
    // An external CLI can crash while Web stays up. Recover after its heartbeat expires,
    // rather than leaving the page's Run now button disabled by a stale running report.
    if(!this.running && !this.starting && reports.some(r=>active(r.status))){
      const release=await this.lock().catch(e=>{if(e instanceof SyncError && e.status===409)return;throw e;});
      if(release)try{await this.recover();this.recoveryError=undefined;reports=await this.list();}catch(e){this.recoveryError=this.redact(e);}finally{await release();}
    }
    return {configured:!missing.length && !configurationError,missing,configurationError,recoveryError:this.recoveryError,running:this.running?.id || reports.find(r=>active(r.status))?.id,reports,maxFileBytes:MAX_BYTES,schedule:'External timer: Monday 06:00 Asia/Shanghai (not enabled by this page)'};
  }
  private async digest(file:string){await safePath(path.dirname(file),path.basename(file));const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
  private async syncDir(dir:string){const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}
  private async disk(bytes:number){if(this.options.disk)return this.options.disk(bytes);const s=await fs.statfs(this.root);if(s.bavail*s.bsize < RESERVE_BYTES+bytes)throw Object.assign(new ImportError('Insufficient disk space. Keep at least 256 MiB free in addition to the download.',true),{code:'ENOSPC'});}
  /** Exclusive linking publishes complete bytes; immediately remove our private link before normal consumers read. */
  private async publish(state:State,source:SourceState,recovering=false){
    const p=source.pending!;await safePath(this.root,'work');await safePath(this.inbox);
    const stage=path.join(this.root,'work',p.stage);let target=path.join(this.inbox,p.target);
    const s=await fs.lstat(stage).catch(e=>{if(e.code==='ENOENT')return;throw e;});
    let t=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return;throw e;});
    if(s && (!s.isFile() || s.isSymbolicLink()) || t && (!t.isFile() || t.isSymbolicLink()))throw new Error('Unsafe pending publication path.');
    if(s && t && s.ino===t.ino && s.dev===t.dev && s.nlink===2){
      // Remove only our proven private hardlink; safePath may then hash the public file.
      await fs.unlink(stage);
      if(await this.digest(target)!==p.hash)throw new Error('Pending published file changed. Manual recovery required.');
    } else if(t && await this.digest(target)===p.hash){
      if(s)await fs.unlink(await safePath(this.root,`work/${p.stage}`));
    } else {
      if(recovering)throw new Error('Pending delivery cannot be proven complete. Preserve state/work files for manual recovery; no redelivery was attempted.');
      if(!s || await this.digest(stage)!==p.hash)throw new Error('Staged delivery hash mismatch.');
      while(true){
        if(t){
          const ext=path.extname(p.target);const base=path.basename(p.target,ext).replace(/__library_.*/,'');
          p.target=`${base.slice(0,55)}__library_${p.hash.slice(0,12)}_${randomUUID().slice(0,8)}${ext}`;await this.saveState(state);target=path.join(this.inbox,p.target);
        }
        try{await fs.link(stage,target);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await safePath(this.inbox,p.target);t=await fs.lstat(target);}
      }
      await fs.unlink(stage);
      await this.syncDir(this.inbox);
    }
    source.delivered[p.hash]={target:p.target,time:now()};state.completed[p.completion]={status:'downloaded',hash:p.hash,target:p.target};
    const saved={...p};delete source.pending;
    try{await this.saveState(state);}catch(e){source.pending=saved;throw e;}
    await fs.rm(stage,{force:true});await this.syncDir(path.join(this.root,'work'));
    return p.target;
  }
  private async recover(){
    const state=await this.state();await safePath(this.inbox);await fs.mkdir(this.inbox,{recursive:true,mode:0o700});
    await fs.mkdir(await safePath(this.root,'work'),{recursive:true,mode:0o700});
    const recovered:Pending[]=[];
    for(const source of Object.values(state.sources))if(source.pending){const pending={...source.pending};await this.publish(state,source,true);recovered.push(pending);}
    // A prior process may already have written a failed/finished report after an
    // interrupted commit. Reflect a now-proven delivery in that original report too.
    for(const pending of recovered){
      const run=await this.get(pending.run);
      const item=run.items.find(item=>run.sourceReport && this.completion(run.sourceBase,run.sourceReport,item)===pending.completion);
      if(item){Object.assign(item,state.completed[pending.completion]);item.reason='Recovered committed delivery.';delete item.error;await this.save(run);await this.event(run,'publication_recovered',item);}
    }
    for(const name of await fs.readdir(this.root))if(/^[a-f0-9-]{36}\.json$/.test(name)){
      const run=await this.get(name.slice(0,-5));if(active(run.status)){
        run.status='interrupted';run.finished=now();run.error='Process interrupted. Run again to retry incomplete files of the latest upstream report.';
        for(const item of run.items)if(pendingStatuses.includes(item.status)){const done=run.sourceReport && state.completed[this.completion(run.sourceBase,run.sourceReport,item)];if(done){Object.assign(item,done);item.reason='Recovered committed delivery.';}else{item.status='interrupted';item.error=run.error;}}
        await this.save(run);await this.event(run,'interrupted');
      }
    }
    // Only recognized orphan staging files; never clean a pending publication.
    for(const name of await fs.readdir(path.join(this.root,'work')))if(/^[a-f0-9-]{36}\.part$/.test(name)){
      const file=path.join(this.root,'work',name);const staged=await fs.lstat(file);
      if(staged.isFile() && staged.nlink===2){
        let proven=false;
        for(const source of Object.values(state.sources))for(const [digest,delivery] of Object.entries(source.delivered)){
          const target=path.join(this.inbox,delivery.target);const t=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return;throw e;});
          if(t?.isFile() && !t.isSymbolicLink() && t.dev===staged.dev && t.ino===staged.ino){await fs.unlink(file);if(await this.digest(target)!==digest)throw new Error('Recovered delivery changed before cleanup.');proven=true;break;}
        }
        if(!proven)throw new Error('Unrecognized staging hardlink; manual recovery required.');
      }else{await safePath(this.root,`work/${name}`);await fs.rm(file,{force:true});}
    }
  }
  async init(){const release=await this.lock().catch(e=>{if(e instanceof SyncError && e.status===409)return;throw e;});if(!release)return;try{await this.recover();this.recoveryError=undefined;}catch(e){this.recoveryError=this.redact(e);}finally{await release();}}
  start():Promise<LibraryRun>{if(this.closing || this.starting || this.running)return Promise.reject(new SyncError('A library import is running or shutting down.',409));this.starting=this.begin();void this.starting.finally(()=>{this.starting=undefined;}).catch(()=>{});return this.starting;}
  private async begin():Promise<LibraryRun>{
    const missing=missingConfig(this.options.config);if(missing.length || !this.options.modelConfigured())throw new SyncError(`Configure ${missing.concat(this.options.modelConfigured()?[]:['API_KEY / BASE_URL / MODEL_ID']).join(', ')} in .env, then restart.`,409);
    const base=checkBase(this.options.config);let release:(()=>Promise<void>)|undefined=await this.lock();
    try{
      await this.recover();this.recoveryError=undefined;if(this.closing)throw new SyncError('Library importer is shutting down.',409);
      const classify=this.options.classifier(); // one model/effort snapshot for the entire run
      const run:LibraryRun={id:randomUUID(),created:now(),status:'running',sourceBase:base,model:this.options.modelId?.(),items:[],counts:{},usage:emptyUsage()};
      await this.save(run);await this.event(run,'started');
      const controller=new AbortController(),unlock=release;release=undefined;
      const watch=setInterval(()=>{void fs.lstat(path.join(this.root,`${run.id}.stop`)).then(()=>controller.abort(new Error('Stopped by administrator.'))).catch(e=>{if(e.code!=='ENOENT')controller.abort(e);});},1000);
      const task=Promise.resolve().then(()=>this.execute(run,controller.signal,classify)).catch(async e=>{
        run.status=controller.signal.aborted?'stopped':'failed';run.error=this.redact(e);run.finished=now();for(const item of run.items)if(pendingStatuses.includes(item.status)){item.status=run.status;item.error=run.error;}await this.save(run);await this.event(run,'failed');
      }).finally(async()=>{clearInterval(watch);try{await fs.rm(path.join(this.root,`${run.id}.stop`),{force:true});}finally{try{await unlock();}finally{this.running=undefined;}}});
      this.running={id:run.id,controller,task};void task.catch(()=>{});if(this.closing)controller.abort(new Error('Service shutting down.'));return structuredClone(run);
    }finally{if(release)await release();}
  }
  private completion(base:string,report:string,item:LibraryItem){return hash(JSON.stringify([base,report,item.key,item.name,item.documentType,item.displayPath,item.url,item.size]));}
  private async upstream(run:LibraryRun,signal:AbortSignal){
    const get=(route:string,auth=true)=>retry(()=>deadline(signal,60000,timed=>(this.options.transport?.json ?? jsonRequest)(`${run.sourceBase}${route}`,auth?this.options.config.password:undefined,timed)),signal);
    const index=await get('/api/sync-reports');
    if(!Array.isArray(index.reports) || index.reports.length>10000)throw new ImportError('Invalid upstream reports list.');
    const complete=index.reports.filter((r:any)=>r && typeof r.runId==='string' && /^[0-9a-z-]{1,100}$/i.test(r.runId) && typeof r.completedAt==='string' && Number.isFinite(Date.parse(r.completedAt)) && (!r.status || ['completed','complete','success'].includes(r.status)));
    complete.sort((a:any,b:any)=>Date.parse(b.completedAt)-Date.parse(a.completedAt));
    const latest=complete[0];if(!latest){run.status='completed';run.error='No complete upstream report is available.';return;}
    run.sourceReport=latest.runId;run.sourceCompletedAt=latest.completedAt;await this.save(run);
    const detail=await get(`/api/sync-reports?runId=${encodeURIComponent(latest.runId)}`);const audit=detail.audit;
    if(audit?.runId!==latest.runId || audit.completedAt!==latest.completedAt || !Array.isArray(audit.changes?.added) || !Array.isArray(audit.changes?.updated))throw new ImportError('Latest report detail is incomplete or does not match the selected report.');
    const list=await get('/api/files',false);
    if(!Array.isArray(list.files) || list.files.length>100000)throw new ImportError('Invalid upstream file list.');
    const files=new Map<string,any>();for(const f of list.files){if(typeof f?.key!=='string')throw new ImportError('Invalid upstream file key.');if(files.has(f.key))throw new ImportError('Duplicate key in current upstream file list.');files.set(f.key,f);}
    const seen=new Set<string>();
    for(const change of ['added','updated'] as const)for(const delta of audit.changes[change]){
      if(typeof delta?.key!=='string' || !delta.key || delta.key.length>4096)throw new ImportError('Invalid report file key.');if(seen.has(delta.key))continue;seen.add(delta.key);if(seen.size>10000)throw new ImportError('Report exceeds 10000 changed files.');
      const f=files.get(delta.key);
      const item:LibraryItem={key:delta.key,change,name:String(f?.name ?? delta.name ?? '').slice(0,1024),documentType:String(f?.documentType ?? delta.documentType ?? '').slice(0,2000),displayPath:String(f?.displayPath ?? [f?.product ?? delta.product,f?.documentType ?? delta.documentType,f?.name ?? delta.name].filter(Boolean).join(' / ')).slice(0,8000),url:typeof f?.url==='string'?f.url:undefined,size:typeof f?.size==='number'?f.size:undefined,status:'pending',attempts:0,usage:emptyUsage()};
      if(!f){item.status='skipped';item.reason='No longer present in the current upstream file list.';}
      else if(!this.validName(item.name)){item.status='skipped';item.reason='Only safe PDF, PPTX, XLSX and DOCX filenames are accepted (legacy formats excluded).';}
      else if(item.size!==undefined && (!Number.isSafeInteger(item.size) || item.size<0 || item.size>MAX_BYTES)){item.status='skipped';item.reason='Reported file size is invalid or exceeds 100 MiB.';}
      else if(!item.url || item.url.length>8192){item.status='failed';item.error='Missing or excessive download URL in current metadata.';}
      run.items.push(item);
    }
    await this.save(run);await this.event(run,'selected_latest_report');
  }
  private async download(item:LibraryItem,stage:string,signal:AbortSignal){
    await this.disk(item.size ?? MAX_BYTES);
    const response=await (this.options.transport?.request ?? request)(item.url!,signal);
    const length=response.headers['content-length'];const expected=length===undefined?undefined:Number(length);
    try{
      if(expected!==undefined && (!/^\d+$/.test(String(length)) || !Number.isSafeInteger(expected) || expected<=0 || expected>MAX_BYTES))throw new ImportError('Invalid or excessive Content-Length.');
      const h=createHash('sha256');let bytes=0,checked=0;
      await pipeline(response,new Transform({transform:(chunk,_,cb)=>{
        bytes+=chunk.length;if(bytes>MAX_BYTES){cb(new ImportError('Download exceeds 100 MiB.'));return;}h.update(chunk);
        if(bytes-checked>=4*1048576){checked=bytes;void this.disk(4*1048576).then(()=>cb(null,chunk),cb);}else cb(null,chunk);
      }}),createWriteStream(stage,{flags:'wx',mode:0o600,flush:true}),{signal});
      if(!bytes || expected!==undefined && expected!==bytes || item.size!==undefined && item.size!==bytes)throw new ImportError('Incomplete download or size changed since the file list.');
      item.bytes=bytes;item.hash=h.digest('hex');
    }finally{response.destroy();}
  }
  private async execute(run:LibraryRun,signal:AbortSignal,classify:Classifier){
    await this.upstream(run,signal);const state=await this.state();let stopBatch=false;
    for(const item of run.items){
      if(item.status!=='pending'){await this.event(run,'file_finished',item);continue;}
      if(signal.aborted || stopBatch){item.status=signal.aborted?'stopped':'not_attempted';item.reason='Not attempted after cancellation or a batch-level failure.';await this.save(run);await this.event(run,'file_finished',item);continue;}
      const identity=hash(JSON.stringify([run.sourceBase,item.key]));const source=state.sources[identity] ?? {delivered:{}};const completion=this.completion(run.sourceBase,run.sourceReport!,item);
      const done=state.completed[completion];if(done){item.status='already_completed';item.target=done.target;item.hash=done.hash;item.reason='This entry in the latest report was already completed; no new download.';await this.save(run);await this.event(run,'file_finished',item);continue;}
      const metadata:Metadata={name:item.name,documentType:item.documentType,displayPath:item.displayPath};const cacheKey=hash(JSON.stringify(metadata));
      const stageName=`${randomUUID()}.part`;const stage=await safePath(this.root,`work/${stageName}`);
      try{
        item.status='classifying';item.model=run.model;await this.save(run);
        let classification=state.classifications[cacheKey];
        if(classification)item.classificationCached=true;
        else{
          classification=await retry(()=>deadline(signal,120000,timed=>classify(metadata,timed,async usage=>{addUsage(item.usage,usage);addUsage(run.usage,usage);await this.save(run);})),signal);
          state.classifications[cacheKey]=classification;await this.saveState(state);
        }
        item.category=classification.category;item.reason=classification.reason;item.model=classification.model;
        if(['outside','uncertain'].includes(classification.category)){item.status=classification.category==='uncertain'?'needs_review':'skipped';state.completed[completion]={status:item.status};await this.saveState(state);}
        else{
          item.status='downloading';await this.save(run);
          await retry(async attempt=>{item.attempts=attempt;await this.save(run);await fs.rm(stage,{force:true});await deadline(signal,600000,timed=>this.download(item,stage,timed));},signal);
          item.status='validating';await this.save(run);await (this.options.verify ?? verify)(stage,path.extname(item.name).toLowerCase(),signal);signal.throwIfAborted();
          if(source.delivered[item.hash!]){item.status='unchanged';item.target=source.delivered[item.hash!]!.target;state.completed[completion]={status:item.status,hash:item.hash,target:item.target};await this.saveState(state);}
          else{
            item.status='publishing';await this.save(run);await this.disk(0);
            source.pending={hash:item.hash!,target:item.name,stage:stageName,completion,run:run.id};state.sources[identity]=source;await this.saveState(state);
            item.target=await this.publish(state,source);item.status='downloaded';
          }
        }
      }catch(e){
        const failedStage=item.status;item.stage=failedStage;item.status=signal.aborted?'stopped':'failed';item.error=this.redact(e);
        stopBatch=!!source.pending || e instanceof ImportError && e.fatal || ['ENOSPC','EACCES','EPERM','EROFS'].includes((e as NodeJS.ErrnoException).code || '') || failedStage==='downloading' && transient(e);
        if(stopBatch)run.error=item.error;
      }finally{if(!source.pending)await fs.rm(stage,{force:true});}
      await this.save(run);await this.event(run,'file_finished',item);
    }
    run.status=signal.aborted?'stopped':run.items.some(i=>i.status==='failed' || i.status==='not_attempted')?'completed_with_errors':'completed';run.finished=now();await this.save(run);await this.event(run,'finished');
  }
  async stop(id:string){const run=await this.get(id);if(active(run.status)){if(this.running?.id===id)this.running.controller.abort(new Error('Stopped by administrator.'));else await atomic(path.join(this.root,`${id}.stop`),'stop\n');}return run;}
  async wait(){await this.starting?.catch(()=>{});await this.running?.task;}
  async close(){this.closing=true;this.running?.controller.abort(new Error('Service shutting down.'));await this.starting?.catch(()=>{});this.running?.controller.abort(new Error('Service shutting down.'));await this.running?.task;}
}
