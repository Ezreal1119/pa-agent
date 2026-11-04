import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectImage } from './image-input.js';
import { acquireDirectoryLock } from './library-lock.js';
import { atomicJson } from './store.js';
import { ImageAssessmentChecker } from './image-assessment.js';
import { PixelOperationFocusChecker } from './image-pixel-focus.js';
import type { LibraryModel } from './library-model.js';

export const PIXEL_VERSION = 'pixel-quality-v1.23.0';
export const PIXEL_SCORE_VERSION = 'pixel-numeric-v1.23.0';
export const PIXEL_DIMENSIONS = ['clarity','resolution','composition','completeness','color','damage','exposure'] as const;
export type PixelDimension = typeof PIXEL_DIMENSIONS[number];
export interface PixelPolicy {
  version: string; weights: Record<PixelDimension,number>;
  caps: Record<'key_content_unrecognizable'|'subject_blurrable'|'blank_or_tiny_subject'|'detail_unacceptable',number>;
  alertThreshold:number; goodThreshold:number; offset:number;
}
export interface PixelCurve { slope:number; intercept:number; x_min:number; x_max:number; samples?:number }
export interface PixelCalibration { id:string; mode:'fixed'; sampleCount:number; curves:Partial<Record<PixelDimension,PixelCurve>> }
export interface PixelAnalysis { score:number; method:'real'|'heuristic'|'proxy'|'defect'|'error'; method_label:string; metrics:Record<string,number|boolean|string>; notes:string }
export interface PixelReferenceResult {
  version:string; final_score:number; status:'alert'|'warning'|'good';
  dimension_scores:Record<PixelDimension,number>; calibrated_dimension_scores:Record<PixelDimension,number>;
  curve_detail:Record<string,unknown>; raw_weighted_score:number; weighted_score_before_cap:number;
  calibration_offset:number; triggered_caps:(keyof PixelPolicy['caps'])[]; applied_cap:number|null;
  analysis:Record<PixelDimension,PixelAnalysis>;
}
export interface PixelOptions { model?:LibraryModel; timeoutMs?:number; pythonPath?:string; workerPath?:string }
const resourceRoot=fileURLToPath(new URL('../../resources/image-quality/v1.23.0/',import.meta.url));
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
/** A cooperative root CLI must leave locks/caches readable by the data owner. */
function preserveDataOwner(file:string,directory:string){
  if(process.geteuid?.()!==0)return;
  const owner=fs.statSync(directory);fs.chownSync(file,owner.uid,owner.gid);
}
export const PIXEL_POLICY:PixelPolicy=JSON.parse(fs.readFileSync(path.join(resourceRoot,'config.json'),'utf8'));
const curves=JSON.parse(fs.readFileSync(path.join(resourceRoot,'calibration_curves.json'),'utf8')).curves as PixelCalibration['curves'];
export const PIXEL_CONFIG_HASH=hash(JSON.stringify({policy:PIXEL_POLICY,curves}));
export const PIXEL_IMPLEMENTATION_HASH=hash(['reference_scoring.py','worker.py','config.json','calibration_curves.json','requirements.txt'].map(name=>fs.readFileSync(path.join(resourceRoot,name),'utf8')).join('\0'));
const labels:Record<PixelDimension,string>={clarity:'清晰度',resolution:'分辨率与噪点',composition:'构图与留白',completeness:'内容完整性',color:'色彩',damage:'画面损坏',exposure:'亮度与曝光'};
const capReasons:Record<keyof PixelPolicy['caps'],string>={key_content_unrecognizable:'内容完整性原始分低于30',subject_blurrable:'清晰度原始分在30至60之间',blank_or_tiny_subject:'非文档图留白超过80%，或缺少留白指标时构图低于40',detail_unacceptable:'清晰度或画面损坏原始分低于30'};

export function validatePixelReference(value:unknown):PixelReferenceResult {
  const v=value as PixelReferenceResult;
  const finite=(n:unknown)=>typeof n==='number'&&Number.isFinite(n);
  if(!v||v.version!=='1.23.0'||!finite(v.final_score)||v.final_score<0||v.final_score>100||!['alert','warning','good'].includes(v.status)||!finite(v.raw_weighted_score)||!finite(v.weighted_score_before_cap)||v.calibration_offset!==0||!Array.isArray(v.triggered_caps)||v.triggered_caps.some(k=>!(k in PIXEL_POLICY.caps)))throw new Error('Invalid pixel scoring result.');
  for(const k of PIXEL_DIMENSIONS){
    const a=v.analysis?.[k];
    if(!a||!finite(a.score)||a.score<0||a.score>100||a.score!==v.dimension_scores?.[k]||!finite(v.calibrated_dimension_scores?.[k])||v.calibrated_dimension_scores[k]<0||v.calibrated_dimension_scores[k]>100||!['real','heuristic','proxy','defect','error'].includes(a.method)||typeof a.notes!=='string'||typeof a.method_label!=='string'||!a.metrics||Array.isArray(a.metrics)||Object.values(a.metrics).some(n=>typeof n==='number'&&!finite(n)))throw new Error(`Invalid pixel dimension: ${k}`);
  }
  return v;
}

interface QueueEntry { run:()=>Promise<unknown>; resolve:(v:unknown)=>void; reject:(e:unknown)=>void; signal:AbortSignal; cancel:()=>void }
const queues=new Map<string,{running:boolean;pending:QueueEntry[]}>();
/** One child per canonical data directory, shared by checker instances. */
export function enqueuePixel<T>(key:string,signal:AbortSignal,run:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  let q=queues.get(key);if(!q){q={running:false,pending:[]};queues.set(key,q);}
  const queue=q;
  if(queue.pending.length>=32)return Promise.reject(new Error('图片评分队列已满，请稍后重试。'));
  const pump=()=>{
    if(queue.running)return;
    const next=queue.pending.shift();if(!next){queues.delete(key);return;}
    next.signal.removeEventListener('abort',next.cancel);queue.running=true;
    void next.run().then(next.resolve,next.reject).finally(()=>{queue.running=false;pump();});
  };
  return new Promise<T>((resolve,reject)=>{
    const entry:QueueEntry={run,resolve:v=>resolve(v as T),reject,signal,cancel:()=>{const i=queue.pending.indexOf(entry);if(i>=0){queue.pending.splice(i,1);reject(signal.reason);}}};
    signal.addEventListener('abort',entry.cancel,{once:true});queue.pending.push(entry);pump();
  });
}

export async function withPixelLock<T>(dataDir:string,signal:AbortSignal,run:()=>Promise<T>):Promise<T>{
  const lock=path.resolve(dataDir,'ckd/image-quality/pixel-worker.lock');
  let release:(()=>void)|undefined;
  while(!release){signal.throwIfAborted();try{release=acquireDirectoryLock(lock);}catch(e){if(!/busy/iu.test(String(e)))throw e;await delay(100,undefined,{signal});}}
  try{
    preserveDataOwner(path.join(lock,'owner.json'),path.dirname(lock));
    preserveDataOwner(lock,path.dirname(lock));
    signal.throwIfAborted();return await run();
  }finally{release();}
}

export function executePixelWorker(imagePath:string,signal:AbortSignal,options:PixelOptions={}):Promise<PixelReferenceResult>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(options.pythonPath??process.env.CKD_SCORER_PYTHON??'python3',['-B',options.workerPath??path.join(resourceRoot,'worker.py')],{
      stdio:['pipe','pipe','pipe'],env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',PYTHONDONTWRITEBYTECODE:'1'},
    });
    let out='',err='',failure:Error|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
    const stop=(reason:unknown)=>{failure??=reason instanceof Error?reason:new Error(String(reason));child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),500);};
    const abort=()=>stop(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop(new Error('图片评分超时，需要人工复核。')),options.timeoutMs??120000);
    child.on('error',e=>{failure=e;});child.stdin.on('error',e=>{failure??=e;});
    child.stdout.on('data',(b:Buffer)=>{out+=b.toString();if(out.length>1024*1024)stop(new Error('Pixel worker output exceeds limit.'));});
    child.stderr.on('data',(b:Buffer)=>{err=(err+b.toString()).slice(-16000);});
    child.on('close',code=>{
      clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',abort);
      if(failure){reject(failure);return;}
      if(code!==0){reject(new Error(`图片评分进程失败，需要人工复核。${err.trim()?` ${err.trim().slice(-2000)}`:''}`));return;}
      // Canonical wire representation also makes negative zero identical on
      // fresh results and JSON-cache reads; no numerical score is changed.
      try{resolve(validatePixelReference(JSON.parse(JSON.stringify(JSON.parse(out)))));}catch(e){reject(new Error(`Pixel worker returned invalid JSON: ${e instanceof Error?e.message:String(e)}`));}
    });
    child.stdin.end(JSON.stringify({imagePath}));if(signal.aborted)abort();
  });
}

export class PixelImageChecker {
  readonly root:string;
  readonly ruleVersion=PIXEL_VERSION;
  readonly scoreVersion=PIXEL_SCORE_VERSION;
  private legacyInstance?:ImageAssessmentChecker;
  constructor(readonly dataDir:string,private readonly options:PixelOptions={}){this.root=path.resolve(dataDir,'ckd/image-quality',PIXEL_VERSION);fs.mkdirSync(this.root,{recursive:true});}
  legacy(){return this.legacyInstance??=new ImageAssessmentChecker(this.dataDir,{model:this.options.model,timeoutMs:this.options.timeoutMs});}
  policy():PixelPolicy{return structuredClone(PIXEL_POLICY);}
  calibration():PixelCalibration{return {id:PIXEL_CONFIG_HASH,mode:'fixed',sampleCount:10,curves:structuredClone(curves)};}
  async checkWithFallback(bytes:Buffer,signal:AbortSignal=new AbortController().signal,calibration:PixelCalibration|null=this.calibration(),policy:PixelPolicy=this.policy(),_retry=false){return {result:await this.check(bytes,signal,calibration,policy)};}
  async check(bytes:Buffer,signal:AbortSignal=new AbortController().signal,calibration:PixelCalibration|null=this.calibration(),policy:PixelPolicy=this.policy()){
    signal.throwIfAborted();const info=inspectImage(bytes),imageHash=hash(bytes),file=path.join(this.root,`${imageHash}.json`);
    if(JSON.stringify(policy)!==JSON.stringify(PIXEL_POLICY)||!calibration||calibration.id!==PIXEL_CONFIG_HASH||JSON.stringify(calibration.curves)!==JSON.stringify(curves))throw new Error('V1.23.0 固定配置快照不匹配，不能套用旧校准或自定义参数。');
    const adapt=(reference:PixelReferenceResult,cached:boolean)=>{
      const dimensionErrors=PIXEL_DIMENSIONS.filter(k=>reference.analysis[k].method==='error').map(k=>({dimension:k,label:labels[k],error:String(reference.analysis[k].metrics.error??'计算失败')}));
      const reminder=reference.status==='alert'||dimensionErrors.length>0;
      const uncapped=Math.max(0,Math.min(100,Object.entries(reference.calibrated_dimension_scores).reduce((sum,[key,value])=>sum+value/100*policy.weights[key as PixelDimension],0)/97*100+policy.offset));
      const components=PIXEL_DIMENSIONS.map(k=>({key:k,label:labels[k],score:reference.calibrated_dimension_scores[k],maximum:100,rawScore:reference.dimension_scores[k],weight:policy.weights[k],method:reference.analysis[k].method,methodLabel:reference.analysis[k].method_label,metrics:reference.analysis[k].metrics,normalized:reference.calibrated_dimension_scores[k]/100,weightedContribution:reference.calibrated_dimension_scores[k]*policy.weights[k]/97,comment:`原始 ${reference.dimension_scores[k]}；校准后 ${reference.calibrated_dimension_scores[k]}；权重 ${policy.weights[k]}/97。${reference.analysis[k].notes}${reference.analysis[k].method==='error'?'；计算失败，需要人工复核':''}`}));
      return {
        ...info,imageHash,ruleVersion:PIXEL_VERSION,scoreVersion:PIXEL_SCORE_VERSION,algorithmVersion:'1.23.0',implementationHash:PIXEL_IMPLEMENTATION_HASH,configHash:PIXEL_CONFIG_HASH,
        cached,model:'pixel-cv',score:reference.final_score,baseScore:reference.raw_weighted_score,calibratedScore:reference.weighted_score_before_cap,alertThreshold:policy.alertThreshold,goodThreshold:policy.goodThreshold,
        scoringStatus:reference.status,analysisSucceeded:dimensionErrors.length===0,evaluationStatus:dimensionErrors.length?'partial_failed' as const:'completed' as const,dimensionErrors,
        status:dimensionErrors.length?'needs_review' as const:reference.status==='alert'?'quality_warning' as const:'normal' as const,
        grade:dimensionErrors.length?'计算异常，需复核':({alert:'不通过',warning:'警告',good:'良好'}[reference.status]),reminder,
        calibrationId:calibration.id,calibrationStatus:'fixed',calibrationOffset:reference.calibration_offset,calibrationSampleCount:10,calibrationExperimental:false,
        policy:structuredClone(policy),components,referenceResult:reference,
        appliedCaps:reference.triggered_caps.map(key=>({key,maximum:policy.caps[key],reason:capReasons[key],limited:uncapped>policy.caps[key]})),
        reason:`V1.23.0 像素评分 ${reference.final_score}/100，${{alert:'不通过',warning:'警告',good:'良好'}[reference.status]}。${dimensionErrors.length?'存在计算失败，必须人工复核；总分不能替代异常提示。':''}`,
        recommendations:dimensionErrors.length?['存在维度计算异常，请查看错误并人工复核。']:reference.status==='alert'?['请结合原图和分项指标复核图片质量。']:[],
      };
    };
    const read=()=>{try{const v=JSON.parse(fs.readFileSync(file,'utf8'));if(v.imageHash!==imageHash||v.implementationHash!==PIXEL_IMPLEMENTATION_HASH||v.configHash!==PIXEL_CONFIG_HASH||v.resultHash!==hash(JSON.stringify(v.reference)))return;const ref=validatePixelReference(v.reference);if(PIXEL_DIMENSIONS.some(k=>ref.analysis[k].method==='error'))return;return adapt(ref,true);}catch{return;}};
    const existing=read();if(existing)return existing;
    const canonical=fs.realpathSync(this.root);
    return enqueuePixel(canonical,signal,()=>withPixelLock(this.dataDir,signal,async()=>{
      const prior=read();if(prior)return prior;
      const temp=fs.mkdtempSync(path.join(this.root,'.input-'));
      try{
        const input=path.join(temp,'image');fs.writeFileSync(input,bytes,{mode:0o600});
        const reference=await executePixelWorker(input,signal,this.options);signal.throwIfAborted();
        if(PIXEL_DIMENSIONS.every(k=>reference.analysis[k].method!=='error')){
          atomicJson(file,{imageHash,implementationHash:PIXEL_IMPLEMENTATION_HASH,configHash:PIXEL_CONFIG_HASH,resultHash:hash(JSON.stringify(reference)),reference});
          preserveDataOwner(file,this.root);
        }
        return adapt(reference,false);
      }finally{fs.rmSync(temp,{recursive:true,force:true});}
    }));
  }
  async operationFocus(_result:PixelResult,context:string,signal:AbortSignal,bytes:Buffer){
    // This independent semantic check never contributes to the pixel score.
    const legacy=this.legacy(),observation=await legacy.check(bytes,signal,null,legacy.policy());
    return legacy.operationFocus(observation,context,signal);
  }
  operationFocusFast(context:string,signal:AbortSignal,bytes:Buffer){
    return new PixelOperationFocusChecker(this.dataDir,{model:this.options.model,timeoutMs:this.options.timeoutMs}).check(bytes,context,signal);
  }
}
export type PixelResult=Awaited<ReturnType<PixelImageChecker['check']>>;
