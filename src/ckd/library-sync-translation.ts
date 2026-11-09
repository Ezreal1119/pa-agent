import fs from 'node:fs';
import path from 'node:path';
import {atomicJson} from './store.js';
import {translatedFile,translationRegistryKey,verifyTranslatedFileQuality} from './library-translation.js';
import {directories,fileHash,readObject,safePath,sha,sopTypes,walk,type Language} from './library-source.js';
import type {MaintenanceContext,ManagedTranslation} from './library-job-types.js';
import {yieldLibraryTurn} from './library-yield.js';
interface Pair {en:string;cn:string;kind:'file'|'directory'}
interface Entry extends Pair {enHash:string|null;cnHash:string|null;generated?:'en'|'cn'}
export interface SummarySignature {source:string;summary:string;overview:string}
export interface SyncBaseline {schemaVersion:1;libraryPath:string;initialized:boolean;pairs:Record<string,Entry>;artifacts:Record<string,string>;summaries?:Record<string,SummarySignature>}
export interface SyncCheckpoint {key?:string;entry?:Entry;artifacts?:Record<string,string|null>}
const baselineFile=(context:MaintenanceContext,dataDir:string)=>path.join(dataDir,'ckd/library-cache',translationRegistryKey(context.root),'sync-baseline.json');
export function readSyncBaseline(context:MaintenanceContext,dataDir:string):SyncBaseline{
 const stored=readObject(baselineFile(context,dataDir));if(stored){if(stored.schemaVersion!==1||stored.libraryPath!==context.root||!stored.pairs||!stored.artifacts)throw new Error('Invalid Library sync baseline');return stored as SyncBaseline;}
 // Existing summaries are generated assets, tracked by exact Hash before any cleanup.
 const artifacts=Object.fromEntries(walk(context.root).filter(f=>['summary.json','overview.json'].includes(path.basename(f))).map(f=>[path.relative(context.root,f),fileHash(f)!]));
 return {schemaVersion:1,libraryPath:context.root,initialized:false,pairs:{},artifacts};
}
export function saveSyncBaseline(context:MaintenanceContext,dataDir:string,baseline:SyncBaseline){if(!context.job.input.dryRun)atomicJson(baselineFile(context,dataDir),baseline);}
function presence(context:MaintenanceContext,relative:string,kind:Pair['kind']){const file=safePath(context.root,relative),hash=fileHash(file);if(hash===null)return null;const stat=fs.lstatSync(file);if(stat.isDirectory()!==(kind==='directory'))throw new Error(`File/directory identity changed: ${relative}`);return kind==='directory'?'directory':hash;}
export function recoverSyncCheckpoint(context:MaintenanceContext,dataDir:string,baseline:SyncBaseline){
 const checkpoint=context.job.sync?.checkpoint;if(!checkpoint)return;
 if(checkpoint.entry&&checkpoint.key){const e=checkpoint.entry;if(presence(context,e.en,e.kind)===e.enHash&&presence(context,e.cn,e.kind)===e.cnHash)baseline.pairs[checkpoint.key]=e;else context.warning(`Sync checkpoint differs from current files; changes will be re-evaluated: ${e.en}`);}
 if(checkpoint.artifacts)for(const [relative,hash] of Object.entries(checkpoint.artifacts)){if(fileHash(safePath(context.root,relative))===hash){if(hash===null)delete baseline.artifacts[relative];else baseline.artifacts[relative]=hash;}else context.warning(`Summary checkpoint externally changed: ${relative}`);}
 saveSyncBaseline(context,dataDir,baseline);delete context.job.sync!.checkpoint;context.save();
}
function inventory(context:MaintenanceContext){
 const entries=new Map<string,Pair>();
 const roots=sopTypes.flatMap(type=>[{en:`processes_lib/${type}`,cn:`processes_lib/${type}/CN_process`},...directories(safePath(context.root,'product_lib')).map(project=>({en:`product_lib/${project}/${type}/processes`,cn:`product_lib/${project}/${type}/CN_process`}))]);
 const supported=(name:string)=>name.toLowerCase()==='metadata'||(/\.(txt|jsonl|json|png|jpe?g)$/iu.test(name)&&!['summary.json','overview.json'].includes(name.toLowerCase()));
 for(const root of roots){const ids=new Set([...directories(safePath(context.root,root.en)),...directories(safePath(context.root,root.cn))]);
  for(const id of ids)for(const language of ['en','cn'] as const){const base=`${root[language]}/${id}`,absolute=safePath(context.root,base);if(!fs.existsSync(absolute))continue;
   const visit=(dir:string,suffix:string)=>{const en=path.join(root.en,id,suffix),cn=path.join(root.cn,id,suffix);entries.set(en,{en,cn,kind:'directory'});
    for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(item.name.startsWith('.'))continue;if(item.isSymbolicLink())throw new Error(`Library symlink is not allowed: ${path.relative(context.root,path.join(dir,item.name))}`);const next=path.join(suffix,item.name);if(item.isDirectory())visit(path.join(dir,item.name),next);else if(item.isFile()&&supported(item.name)){const en=path.join(root.en,id,next);entries.set(en,{en,cn:path.join(root.cn,id,next),kind:'file'});}}
   };visit(absolute,'');
  }
 }
 return entries;
}
function knownEntry(context:MaintenanceContext,pair:Pair):Entry|undefined{
 if(pair.kind==='file'){
  const en=context.translations[pair.en],cn=context.translations[pair.cn];
  if(en?.source===pair.cn)return {...pair,enHash:en.targetHash,cnHash:en.sourceHash,generated:'en'};
  if(cn?.source===pair.en)return {...pair,enHash:cn.sourceHash,cnHash:cn.targetHash,generated:'cn'};
 }else{
  for(const language of ['cn','en'] as const){const folder=safePath(context.root,pair[language]);if(!fs.existsSync(folder))continue;const files=walk(folder).filter(f=>!['summary.json','overview.json'].includes(path.basename(f)));if(files.length&&files.every(f=>{const rel=path.relative(context.root,f),r=context.translations[rel];return r&&r.targetHash===fileHash(f);}))return {...pair,enHash:presence(context,pair.en,pair.kind),cnHash:presence(context,pair.cn,pair.kind),generated:language};}
 }
}
function managedQualityIssue(context:MaintenanceContext,current:Entry,previous?:Entry):string|null{
 if(current.kind!=='file'||!previous?.generated||current.enHash!==previous.enHash||current.cnHash!==previous.cnHash)return null;
 const targetSide=previous.generated,sourceSide=targetSide==='en'?'cn':'en';
 const source=current[sourceSide],target=current[targetSide],record=context.translations[target];
 if(!record||record.source!==source||record.sourceHash!==current[`${sourceSide}Hash`]||record.targetHash!==current[`${targetSide}Hash`])return null;
 try{verifyTranslatedFileQuality(safePath(context.root,source),safePath(context.root,target),targetSide==='en'?'English':'中文');return null;}
 catch(error){return error instanceof Error?error.message:String(error);}
}
export async function runSyncTranslations(scoped:MaintenanceContext,parent:MaintenanceContext,dataDir:string,baseline:SyncBaseline){
 const entries=inventory(parent);for(const [key,entry] of Object.entries(baseline.pairs))if(!entries.has(key))entries.set(key,entry);
 // Snapshot every pre-operation value so creating directories cannot hide a deletion.
 const snapshot=new Map([...entries].map(([key,pair])=>[key,{...pair,enHash:presence(parent,pair.en,pair.kind),cnHash:presence(parent,pair.cn,pair.kind)} as Entry]));
 const work=[...snapshot].sort(([,a],[,b])=>a.kind!==b.kind?(a.kind==='file'?1:-1):a.en.length-b.en.length);
 scoped.job.total=work.length;scoped.save();
 const deletedDirectories:typeof work=[];
 const checkpoint=(key:string,entry:Entry)=>{if(presence(parent,entry.en,entry.kind)!==entry.enHash||presence(parent,entry.cn,entry.kind)!==entry.cnHash)throw new Error(`Files changed while synchronizing: ${entry.en}`);if(parent.job.input.dryRun)return;parent.job.sync!.checkpoint={key,entry};parent.save();recoverSyncCheckpoint(parent,dataDir,baseline);};
 const perform=async(key:string,current:Entry,removeDirectory=false)=>{
  parent.signal.throwIfAborted();scoped.job.currentItem=key;scoped.save();
  try{
   const previous=baseline.pairs[key]??knownEntry(parent,current);
   const enChanged=previous?current.enHash!==previous.enHash:current.enHash!==null;
   const cnChanged=previous?current.cnHash!==previous.cnHash:current.cnHash!==null;
   const qualityIssue=managedQualityIssue(parent,current,previous);
   const finish=(entry:Entry,status:'reused'|'skipped'|'planned'|'updated',message?:string)=>{checkpoint(key,entry);scoped.record({key,status,message});};
   if(previous&&!enChanged&&!cnChanged&&!qualityIssue){finish({...current,generated:previous.generated},'reused');return;}
   if(!previous&&!baseline.initialized&&current.enHash!==null&&current.cnHash!==null){finish({...current,generated:knownEntry(parent,current)?.generated},'skipped','Initial independent bilingual content retained; Hash baseline established');return;}
   if(current.enHash===null&&current.cnHash===null){finish(current,'reused','Both sides absent');return;}
   // Existing baselines make deletions different from missing counterparts.
   const sourceSide: 'en'|'cn'=qualityIssue&&previous?.generated?(previous.generated==='en'?'cn':'en'):cnChanged?'cn':enChanged?'en':current.cnHash!==null?'cn':'en';
   const targetSide:'en'|'cn'=sourceSide==='cn'?'en':'cn',source=current[sourceSide],target=current[targetSide],sourceHash=current[`${sourceSide}Hash`],targetHash=current[`${targetSide}Hash`];
   if(enChanged&&cnChanged&&current.cnHash!==null)parent.warning(`Both languages changed; Chinese wins: ${current.cn} -> ${current.en}`);
   if(sourceHash===null){
    const record=parent.translations[target],owned=previous?.generated===targetSide&&(current.kind==='directory'||!!record&&record.source===source&&record.targetHash===targetHash);
    if(!owned){finish({...current,generated:previous?.generated},'skipped',`Source deleted; independent/edited counterpart retained: ${target}`);parent.warning(`Deleted source, independent/edited counterpart retained: ${source} -> ${target}`);return;}
    if(current.kind==='directory'&&!removeDirectory){deletedDirectories.push([key,current]);return;}
    if(parent.job.input.dryRun){scoped.record({key,status:'planned',message:`Delete generated counterpart: ${target}`});return;}
    if(current.kind==='directory'){
     for(const name of ['summary.json','overview.json']){const relative=path.join(target,name),hash=fileHash(safePath(parent.root,relative));if(hash!==null&&baseline.artifacts[relative]===hash){scoped.commit(`removed-summary:${relative}`,{[source]:null},[{relative,data:null,before:hash}]);delete baseline.artifacts[relative];}}
     if(fs.readdirSync(safePath(parent.root,target)).length){finish({...current,generated:previous?.generated},'skipped',`Nonempty directory retained: ${target}`);return;}
    }
    const entry={...current,[`${targetSide}Hash`]:null,generated:undefined};parent.job.sync!.checkpoint={key,entry};parent.save();
    scoped.commit(key,{[source]:null},[{relative:target,data:null,directory:current.kind==='directory',before:fileHash(safePath(parent.root,target))}]);recoverSyncCheckpoint(parent,dataDir,baseline);scoped.record({key,status:'updated',message:`Deleted generated counterpart: ${target}`});return;
   }
   if(current.kind==='directory'){
    if(targetHash!==null){finish({...current,generated:previous?.generated},'reused');return;}
    const entry={...current,[`${targetSide}Hash`]:'directory',generated:targetSide};
    if(parent.job.input.dryRun){scoped.record({key,status:'planned',message:`Create directory: ${target}`});return;}
    parent.job.sync!.checkpoint={key,entry};parent.save();scoped.commit(key,{[source]:fileHash(safePath(parent.root,source))},[{relative:target,data:Buffer.alloc(0),directory:true,before:null}]);recoverSyncCheckpoint(parent,dataDir,baseline);scoped.record({key,status:'updated',message:'Empty/override directory retained'});return;
   }
   // On first adoption, do not merge images into a pre-existing independent photo override.
   const photo=/[\\/](?:photos|operation_photos|previous_station_check_photos)[\\/]/iu.test(target);
   const targetParent=path.dirname(target),preParent=[...snapshot.values()].find(e=>e.kind==='directory'&&e[targetSide]===targetParent);
   // An empty target photo directory is a placeholder, not an independent override.
   const targetHasFiles=(()=>{try{return fs.readdirSync(safePath(parent.root,targetParent)).length>0;}catch{return false;}})();
   if(!previous&&!baseline.initialized&&photo&&targetHasFiles&&preParent?.[`${targetSide}Hash`]!==null&&preParent!==undefined&&!knownEntry(parent,preParent)?.generated){finish(current,'skipped','Initial independent photo directory retained');return;}
   if(parent.job.input.dryRun){scoped.record({key,status:'planned',message:`${sourceSide==='cn'?'中文 → English':'English → 中文'}: ${target}${qualityIssue?' (quality recheck)':''}`});return;}
   const result=await translatedFile(parent,safePath(parent.root,source),targetSide==='cn'?'中文':'English');
   const translation:ManagedTranslation={source,target,sourceHash,targetHash:sha(result.data),language:(targetSide==='cn'?'中文':'English') as Language,model:result.model};
   const entry={...current,[`${targetSide}Hash`]:translation.targetHash,generated:targetSide};parent.job.sync!.checkpoint={key,entry};parent.save();
   scoped.commit(key,{[source]:sourceHash},[{relative:target,data:result.data,before:targetHash,translation}]);recoverSyncCheckpoint(parent,dataDir,baseline);scoped.record({key,status:'updated',message:`${sourceSide==='cn'?'中文 → English':'English → 中文'}${enChanged&&cnChanged?' (Chinese priority)':''}${qualityIssue?' (quality recheck)':''}`});
  }catch(error){parent.signal.throwIfAborted();if(parent.job.pending)throw error;delete parent.job.sync!.checkpoint;parent.save();scoped.record({key,status:'error',message:error instanceof Error?error.message:String(error)});}
 };
 for(const [key,entry] of work){
  await yieldLibraryTurn(parent.signal);
  const previous=baseline.pairs[key];
  // Snapshot hashes already prove an unchanged pair. Its durable baseline needs no checkpoint.
  if(previous&&entry.enHash===previous.enHash&&entry.cnHash===previous.cnHash&&!managedQualityIssue(parent,entry,previous)){scoped.record({key,status:'reused'});continue;}
  await perform(key,entry);
 }
 for(const [key,entry] of deletedDirectories.sort(([,a],[,b])=>b.en.length-a.en.length)){await yieldLibraryTurn(parent.signal);await perform(key,entry,true);}
 if(!parent.job.input.dryRun){baseline.initialized=true;saveSyncBaseline(parent,dataDir,baseline);}
}
