import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ImageAssessmentChecker, ASSESSMENT_VERSION, ASSESSMENT_SCORE_VERSION, type ImagePolicy, type AssessmentCalibration } from './image-assessment.js';
import {createImageScorer,scoringContext,scorerForContext,checkWithContext,type ImageScorer,type ImageScorerMode,type ScoringPolicy,type ScoringCalibration,type ScoringContext} from './image-scorer.js';
import { inspectImage, MAX_IMAGE_BYTES } from './image-input.js';
import { atomicJson, isInside } from './store.js';
import { acquireDirectoryLock, acquireLibraryLock } from './library-lock.js';
import { walk, sha, safePath } from './library-source.js';
import type { LibraryModel } from './library-model.js';
import {ModelOutputError} from './library-model.js';
import {ImageAnalysisProtocolError,type ImageAnalysisFailure} from './image-analysis-failure.js';

interface ImageItem {
  imageHash: string; paths: string[]; status: 'pending'|'running'|'completed'|'error';
  cached?: boolean; score?: number|null; reminder?: boolean; error?: string; fallback?:ImageAnalysisFailure; startedAt?: string; finishedAt?: string;
}
export interface ImagePrewarmJob {
  id: string; libraryPath: string; status: 'interrupted'|'running'|'completed'|'partial_failed'|'failed'|'cancelled';
  createdAt: string; updatedAt: string; ownerPid?: number; concurrency: number; fileCount: number;
  analysisVersion: string; scoreVersion: string; policy: ScoringPolicy; calibration: ScoringCalibration|null; configHash?:string; implementationHash?:string;
  total: number; completed: number; analyzed: number; reused: number; errors: number; items: ImageItem[]; error?: string;
}
/** Read-only full-Library analysis. Shares the SOP observation cache, not translation/summary maintenance. */
export class ImagePrewarmJobs {
  readonly root: string;
  private readonly checker: ImageScorer;
  constructor(readonly dataDir: string, private readonly options: {model?: LibraryModel; timeoutMs?: number; imageScorer?:ImageScorerMode; pythonPath?:string; onProgress?:(job:ImagePrewarmJob)=>void} = {}) {
    this.root=path.resolve(dataDir,'ckd/image-prewarm');this.checker=createImageScorer(dataDir,options);
  }
  private directory(id:string) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))throw new Error('Invalid prewarm job ID.');
    return path.join(this.root,id);
  }
  private save(job:ImagePrewarmJob) {
    job.updatedAt=new Date().toISOString();job.completed=job.items.filter(i=>['completed','error'].includes(i.status)).length;
    job.analyzed=job.items.filter(i=>i.status==='completed'&&!i.cached).length;job.reused=job.items.filter(i=>i.status==='completed'&&i.cached).length;job.errors=job.items.filter(i=>i.status==='error').length;
    atomicJson(path.join(this.directory(job.id),'state.json'),job);this.options.onProgress?.(job);
  }
  get(id:string):ImagePrewarmJob {
    const job=JSON.parse(fs.readFileSync(path.join(this.directory(id),'state.json'),'utf8')) as ImagePrewarmJob;
    if(job.id!==id||!Array.isArray(job.items))throw new Error('Invalid prewarm state.');
    if(job.status==='running'){let alive=false;try{if(job.ownerPid){process.kill(job.ownerPid,0);alive=true;}}catch{}if(!alive)job.status='interrupted';}
    return job;
  }
  create(library:string,concurrency=3):ImagePrewarmJob {
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Concurrency must be 1–4.');
    const libraryPath=fs.realpathSync(library);
    if(isInside(libraryPath,path.resolve(this.dataDir))||isInside(this.root,libraryPath))throw new Error('Library and prewarm data must be separate.');
    const release=acquireLibraryLock(libraryPath);
    try {
      const groups=new Map<string,string[]>();
      for(const area of ['product_lib','processes_lib'])for(const file of walk(path.join(libraryPath,area))){
        const relative=path.relative(libraryPath,file);
        if(!/\.(png|jpe?g)$/iu.test(file)||relative.split(path.sep).some(p=>['derived','CN_derived'].includes(p)))continue;
        const hash=sha(fs.readFileSync(file));groups.set(hash,[...(groups.get(hash)??[]),relative]);
      }
      const now=new Date().toISOString(),job:ImagePrewarmJob={id:randomUUID(),libraryPath,status:'interrupted',createdAt:now,updatedAt:now,concurrency,fileCount:[...groups.values()].reduce((n,p)=>n+p.length,0),...scoringContext(this.checker),total:groups.size,completed:0,analyzed:0,reused:0,errors:0,items:[...groups].map(([imageHash,paths])=>({imageHash,paths,status:'pending'}))};
      this.save(job);return job;
    }finally{release();}
  }
  cancel(id:string) { const job=this.get(id);if(job.status==='completed'||job.status==='cancelled')return job;fs.writeFileSync(path.join(this.directory(id),'cancel.request'),'cancel\n');if(job.status!=='running'){job.status='cancelled';this.save(job);}return this.get(id); }
  async resume(id:string,signal:AbortSignal=new AbortController().signal) {
    const job=this.get(id);if(job.status==='completed'||job.status==='cancelled')return job;
    const checker=scorerForContext(this.checker,job);
    const unlock=acquireDirectoryLock(path.join(this.directory(id),'run.lock'));let releaseLibrary:(()=>void)|undefined;
    const controller=new AbortController(),bounded=AbortSignal.any([signal,controller.signal]);
    const cancelled=()=>{if(fs.existsSync(path.join(this.directory(id),'cancel.request')))controller.abort(new Error('Prewarm cancelled.'));};
    const poll=setInterval(cancelled,100);cancelled();
    try {
      releaseLibrary=acquireLibraryLock(job.libraryPath);bounded.throwIfAborted();job.status='running';job.ownerPid=process.pid;delete job.error;
      // Committed successes stay done; retry failed/in-flight items only after explicit resume.
      for(const item of job.items)if(item.status!=='completed'){item.status='pending';delete item.error;delete item.fallback;}
      this.save(job);let cursor=0;
      const verify=(item:ImageItem)=>{for(const relative of item.paths){const file=safePath(job.libraryPath,relative);if(!fs.existsSync(file)||!fs.statSync(file).isFile()||sha(fs.readFileSync(file))!==item.imageHash)throw new Error(`Image changed or removed: ${relative}`);}};
      const worker=async()=>{
        while(cursor<job.items.length){bounded.throwIfAborted();const item=job.items[cursor++]!;
          if(item.status==='completed'){
            try{verify(item);}catch(error){item.status='error';item.error=error instanceof Error?error.message:String(error);this.save(job);}continue;
          }
          item.status='running';item.startedAt=new Date().toISOString();this.save(job);
          try {
            verify(item);const bytes=fs.readFileSync(safePath(job.libraryPath,item.paths[0]!));if(bytes.length>MAX_IMAGE_BYTES)throw new Error('Image exceeds 10 MiB.');inspectImage(bytes);
            const result=await checkWithContext(checker,bytes,bounded,job);bounded.throwIfAborted();verify(item);
            atomicJson(path.join(this.directory(id),'items',item.imageHash+'.json'),{paths:item.paths,result});
            item.cached=result.cached;item.score=result.score;item.reminder=result.reminder;item.status='completed';
            if('evaluationStatus' in result&&result.evaluationStatus==='partial_failed'){item.status='error';item.error=result.dimensionErrors.map(e=>`${e.label}：${e.error}`).join('；');}
          }catch(error){if(bounded.aborted){item.status='pending';throw error;}item.status='error';item.error=error instanceof Error?error.message:String(error);
            if(checker instanceof ImageAssessmentChecker&&(error instanceof ImageAnalysisProtocolError||error instanceof ModelOutputError)){verify(item);item.fallback=checker.recordFailure(fs.readFileSync(safePath(job.libraryPath,item.paths[0]!)),error);atomicJson(path.join(this.directory(id),'items',item.imageHash+'.json'),{paths:item.paths,fallback:item.fallback,error:item.error});}
          }
          finally{item.finishedAt=new Date().toISOString();this.save(job);}
        }
      };
      const workers=await Promise.allSettled(Array.from({length:job.concurrency},worker));bounded.throwIfAborted();const failure=workers.find(w=>w.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
      job.status=job.errors?'partial_failed':'completed';
    }catch(error){job.status=controller.signal.aborted?'cancelled':signal.aborted?'interrupted':'failed';job.error=error instanceof Error?error.message:String(error);}
    finally{clearInterval(poll);delete job.ownerPid;this.save(job);releaseLibrary?.();unlock();}
    return job;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{'data-dir':{type:'string'},library:{type:'string'},concurrency:{type:'string'},resume:{type:'string'},status:{type:'string'},cancel:{type:'string'}}});
  const dataDir=path.resolve(values['data-dir']??process.env.CKD_DATA_DIR??'.data');
  let last='';const jobs=new ImagePrewarmJobs(dataDir,{onProgress:j=>{const active=j.items.filter(i=>i.status==='running').map(i=>i.paths[0]);const message=JSON.stringify({id:j.id,status:j.status,completed:j.completed,total:j.total,analyzed:j.analyzed,reused:j.reused,errors:j.errors,active});if(message!==last){console.error(message);last=message;}}});
  if(values.status)console.log(JSON.stringify(jobs.get(values.status),null,2));
  else if(values.cancel)console.log(JSON.stringify(jobs.cancel(values.cancel),null,2));
  else {
    const controller=new AbortController();for(const event of ['SIGINT','SIGTERM'] as const)process.once(event,()=>controller.abort(new Error('Prewarm interrupted; resume explicitly.')));
    const run=async()=>{const job=values.resume?jobs.get(values.resume):jobs.create(values.library??process.env.CKD_LIBRARY??path.join(dataDir,'ckd/library/ckd-library-v2'),Number(values.concurrency??3));console.log(JSON.stringify({jobId:job.id,stateFile:path.join(jobs.root,job.id,'state.json')}));const result=await jobs.resume(job.id,controller.signal);console.log(JSON.stringify({jobId:job.id,status:result.status,completed:result.completed,total:result.total,analyzed:result.analyzed,reused:result.reused,errors:result.errors}));if(result.status!=='completed')process.exitCode=1;};
    run().catch(error=>{console.error(error.message);process.exitCode=1;});
  }
}
