import fs from 'node:fs';
import path from 'node:path';
import {atomicJson} from './store.js';
import {ImageAssessmentChecker, ASSESSMENT_VERSION, ASSESSMENT_SCORE_VERSION, type ImagePolicy, type AssessmentCalibration, type ImageAssessmentResult} from './image-assessment.js';
import {createImageScorer,scoringContext,scorerForContext,scoreWithContext,type ImageScorer,type ScoringContext,type ScoredImage} from './image-scorer.js';
import {validateCkdLibrary, type LibraryValidationReport} from './library-validation.js';
import {runSummaries} from './library-summaries.js';
import {runSyncTranslations, readSyncBaseline, saveSyncBaseline, recoverSyncCheckpoint} from './library-sync-translation.js';
import {fileHash, safePath, sha, targets} from './library-source.js';
import type {LibraryJob, MaintenanceContext} from './library-job-types.js';
import type {ImageAnalysisFailure} from './image-analysis-failure.js';
import {yieldLibraryTurn} from './library-yield.js';
import {scanRawLibrary, snapshotsEqual, summaryImplementationHash, summarySourceSignature} from './library-sync-snapshot.js';
export type SyncStage='validate'|'translate'|'images'|'summaries';
export interface SyncProgress {
 stage:SyncStage; attempt:number; outcome?:LibraryJob['status']; deletions?:{path:string;kind:'file'|'directory'}[]; validation?:LibraryValidationReport;
 stages:Partial<Record<SyncStage,{total:number;completed:number;status:'running'|'completed'|'failed'|'interrupted'|'cancelled'}>>;
 imageContext?:ScoringContext;
 images?:{path:string;imageHash:string;result?:ScoredImage;fallback?:ImageAnalysisFailure;error?:string}[];
 checkpoint?:import('./library-sync-translation.js').SyncCheckpoint;
 attempts?:{counts:LibraryJob['counts'];status:LibraryJob['status'];warnings?:string[]}[];
 fastReusedSummaries?:number;
}
export function stageContext(parent:MaintenanceContext,stage:SyncStage):MaintenanceContext{
 const prefix=`${stage}:`,job={...parent.job,input:{},items:parent.job.items.filter(i=>i.key.startsWith(prefix)).map(i=>({...i,key:i.key.slice(prefix.length)})),total:0,completed:0} as LibraryJob;
 let noWriteSinceSave=0,lastNoWriteSave=Date.now();
 const progress=()=>{parent.job.currentItem=job.currentItem?prefix+job.currentItem:undefined;parent.job.sync!.stages[stage]={total:Math.max(job.total,job.items.length),completed:job.items.length,status:'running'};parent.job.total=Object.values(parent.job.sync!.stages).reduce((n,v)=>n+v!.total,0);};
 const save=()=>{progress();parent.save();noWriteSinceSave=0;lastNoWriteSave=Date.now();};
 const batch=()=>{noWriteSinceSave++;if(noWriteSinceSave>=50||Date.now()-lastNoWriteSave>=2000)save();};
 return {...parent,job,save,record:item=>{
  if(job.items.some(i=>i.key===item.key))return;
  job.items.push(item);progress();
  if(item.status==='reused'||item.status==='planned'||item.status==='skipped'){
   parent.job.items.push({...item,key:prefix+item.key});parent.job.counts[item.status]++;parent.job.completed++;delete parent.job.currentItem;
   batch();
  }else {parent.record({...item,key:prefix+item.key});noWriteSinceSave=0;lastNoWriteSave=Date.now();}
 },warning:message=>{if(parent.job.warnings.includes(message))return;parent.job.warnings.push(message);batch();},commit:(key,sources,writes)=>parent.commit(prefix+key,sources,writes)};
}
export async function runLibrarySync(context:MaintenanceContext,dataDir:string,provided?:ImageScorer){
 const {job}=context, previous=job.sync;
 job.sync={stage:'validate',attempt:(previous?.attempt??0)+1,stages:{},deletions:previous?.deletions??[],imageContext:previous?.imageContext??job.imageContext,checkpoint:previous?.checkpoint,attempts:[...(previous?.attempts??[]),...(previous?[{counts:{...job.counts},status:previous.outcome??'interrupted',warnings:[...job.warnings]}]:[])]};
 if(previous)job.warnings=[];
 job.items=[];job.completed=0;job.total=0;job.counts={updated:0,reused:0,skipped:0,planned:0,conflict:0,error:0};context.save();
 const baseline=readSyncBaseline(context,dataDir);recoverSyncCheckpoint(context,dataDir,baseline);
 const stage=async(name:SyncStage,work:(scoped:MaintenanceContext)=>Promise<void>)=>{
  context.signal.throwIfAborted();job.sync!.stage=name;context.save();const scoped=stageContext(context,name);await work(scoped);
  job.sync!.stages[name]!.status=job.items.some(i=>i.key.startsWith(name+':')&&(i.status==='error'||i.status==='conflict'))?'failed':'completed';context.save();
 };
 await stage('validate',async scoped=>{
  scoped.job.total=1;scoped.save();const validation=await validateCkdLibrary(context.root,{},true);context.signal.throwIfAborted();job.sync!.validation=validation;
  scoped.record({key:'syntax',status:validation.valid?'reused':'error',message:validation.valid?`${validation.scannedFiles} files checked`:`${validation.errorCount} syntax/read errors; Library was not modified`});
 });
 if(!job.sync.validation!.valid)return;
 let checker=provided??createImageScorer(dataDir);
 if(!job.sync.imageContext)job.sync.imageContext=scoringContext(checker);
 checker=scorerForContext(checker,job.sync.imageContext);
 context.save();
 await stage('translate',scoped=>runSyncTranslations(scoped,context,dataDir,baseline));
 // Never build derived content against a partly failed bilingual update.
 if(job.counts.error||job.counts.conflict){context.warning('Translation has errors; image and summary stages were not started. Fix and resume.');return;}
 const rawSnapshot=await scanRawLibrary(context.root,context.signal);
 let imageIndex:Record<string,{imageHash:string;score:number|null;reminder:boolean;analysisSucceeded?:false;error?:string}>={};
 await stage('images',async scoped=>{
  const groups=new Map<string,string[]>();for(const [relative,hash] of rawSnapshot){if(!/\.(png|jpe?g)$/iu.test(relative))continue;groups.set(hash,[...(groups.get(hash)??[]),relative]);}
  scoped.job.total=groups.size;scoped.save();job.sync!.images=[];
  for(const [hash,paths] of groups){await yieldLibraryTurn(context.signal);scoped.job.currentItem=paths[0];
   if(job.input.dryRun){scoped.record({key:hash,status:'planned',message:`Score ${paths.join(', ')}`});continue;}
   try{const bytes=fs.readFileSync(safePath(context.root,paths[0]!));if(sha(bytes)!==hash)throw new Error('Image changed during sync');const snapshot=job.sync!.imageContext!,outcome=await scoreWithContext(checker,bytes,context.signal,snapshot,true);
    if(outcome.fallback){for(const p of paths){imageIndex[p]={imageHash:hash,score:0,reminder:true,analysisSucceeded:false,error:outcome.error};job.sync!.images.push({path:p,imageHash:hash,fallback:outcome.fallback,error:outcome.error});}scoped.record({key:hash,status:'error',message:`${paths.join('；')}：0 fallback — ${outcome.error}`});continue;}
    const result=outcome.result!;
    if('evaluationStatus' in result&&result.evaluationStatus==='partial_failed'){
     const message=result.dimensionErrors.map(e=>`${e.label}：${e.error}`).join('；');
     for(const p of paths){imageIndex[p]={imageHash:hash,score:result.score,reminder:true,analysisSucceeded:false,error:message};job.sync!.images.push({path:p,imageHash:hash,result,error:message});}
     scoped.record({key:hash,status:'error',message:`${paths.join('；')}：计算异常，必须复核 — ${message}`});continue;
    }
    for(const p of paths){imageIndex[p]={imageHash:hash,score:result.score,reminder:result.reminder};job.sync!.images.push({path:p,imageHash:hash,result});}
    scoped.record({key:hash,status:result.cached?'reused':'updated',message:`${paths.length} file(s), ${result.score??'unscored'}${result.reminder?' — review required':''}`});
   }catch(error){context.signal.throwIfAborted();const message=error instanceof Error?error.message:String(error);for(const p of paths)job.sync!.images.push({path:p,imageHash:hash,error:message});scoped.record({key:hash,status:'error',message:`${paths.join('；')}：${message}`});}
  }
 });
 await stage('summaries',async scoped=>{
  const warn=scoped.warning;scoped.warning=message=>{const hash=/image ([a-f0-9]{64})/u.exec(message)?.[1];const paths=hash?[...rawSnapshot].filter(([,value])=>value===hash).map(([name])=>name):[];warn(paths.length?`${paths.join('；')}：${message}`:message);};
  scoped.job.input={dryRun:job.input.dryRun};
  // Remove only formerly tracked generated files that no longer have a raw Process.
  const selectedTargets=targets(context.root,{});
  const allowed=new Set(selectedTargets.flatMap(t=>[t.output,...(t.project?[t.project]:[])].flatMap(dir=>['summary.json','overview.json'].map(n=>path.relative(context.root,path.join(dir,n))))));
  for(const [relative,hash] of Object.entries(baseline.artifacts)){
   if(allowed.has(relative))continue;const current=fileHash(safePath(context.root,relative));if(current===null){delete baseline.artifacts[relative];continue;}
   if(current!==hash){context.warning(`Orphan summary externally edited; retained: ${relative}`);continue;}
   if(job.input.dryRun){scoped.record({key:`orphan:${relative}`,status:'planned',message:'Remove obsolete generated summary'});continue;}
   const rawDirectory=path.dirname(relative.replace('/CN_derived/','/CN_process/').replace('/derived/','/processes/'));
   scoped.commit(`orphan:${relative}`,{[rawDirectory]:fileHash(safePath(context.root,rawDirectory))},[{relative,data:null,before:hash}]);delete baseline.artifacts[relative];saveSyncBaseline(context,dataDir,baseline);scoped.record({key:`orphan:${relative}`,status:'updated',message:'Removed obsolete generated summary'});
  }
  const originalCommit=scoped.commit;scoped.commit=(key,sources,writes)=>{
   // A crash after the transaction but before baseline persistence is recoverable.
   job.sync!.checkpoint={artifacts:Object.fromEntries(writes.map(w=>[w.relative,w.data===null?null:sha(w.data)]))};context.save();originalCommit(key,sources,writes);recoverSyncCheckpoint(context,dataDir,baseline);
  };
  const sourceSignatures=new Map<string,string>(),fastReuseKeys=new Set<string>();
  if(!job.input.dryRun){
   const implementation=summaryImplementationHash();
   for(const target of selectedTargets){
    await yieldLibraryTurn(context.signal);
    try{
     const signature=summarySourceSignature(context.root,target,rawSnapshot,implementation);
     sourceSignatures.set(target.key,signature);
     const previous=baseline.summaries?.[target.key];
     if(previous?.source!==signature)continue;
     const summary=fileHash(safePath(context.root,path.relative(context.root,path.join(target.output,'summary.json'))));
     const overview=fileHash(safePath(context.root,path.relative(context.root,path.join(target.output,'overview.json'))));
     if(summary!==null&&overview!==null&&summary===previous.summary&&overview===previous.overview)fastReuseKeys.add(target.key);
    }catch{/* The regular summary path records malformed targets individually. */}
   }
  }
  job.sync!.fastReusedSummaries=fastReuseKeys.size;
  await runSummaries(scoped,fastReuseKeys);
  if(!job.input.dryRun){
   // A direct file upload during the run must not turn a stale snapshot into a new baseline.
   const finalSnapshot=await scanRawLibrary(context.root,context.signal);
   if(!snapshotsEqual(rawSnapshot,finalSnapshot))throw new Error('Library sources changed during sync; run it again after editing stops.');
   atomicJson(path.join(dataDir,'ckd/library-cache',sha(fs.realpathSync(context.root)),'image-index.json'),{jobId:job.id,updatedAt:new Date().toISOString(),...job.sync!.imageContext,images:imageIndex});
   for(const target of selectedTargets.filter(item=>fastReuseKeys.has(item.key))){
    const previous=baseline.summaries![target.key]!;
    if(fileHash(path.join(target.output,'summary.json'))!==previous.summary||fileHash(path.join(target.output,'overview.json'))!==previous.overview)
     throw new Error(`Summary output changed during sync: ${target.key}`);
   }
   for(const relative of allowed){const hash=fileHash(safePath(context.root,relative));if(hash!==null&&(baseline.artifacts[relative]===undefined||baseline.artifacts[relative]===hash))baseline.artifacts[relative]=hash;}
   if(!scoped.job.items.some(item=>item.status==='error'||item.status==='conflict')&&sourceSignatures.size===selectedTargets.length){
    baseline.summaries=Object.fromEntries(selectedTargets.map(target=>{
     const summary=fileHash(path.join(target.output,'summary.json'));
     const overview=fileHash(path.join(target.output,'overview.json'));
     if(summary===null||overview===null)throw new Error(`Summary output missing after sync: ${target.key}`);
     return [target.key,{source:sourceSignatures.get(target.key)!,summary,overview}];
    }));
   }
   saveSyncBaseline(context,dataDir,baseline);
  }
 });
}
