import { ImageAssessmentChecker, ASSESSMENT_VERSION, ASSESSMENT_SCORE_VERSION, validatePolicy, type ImagePolicy, type AssessmentCalibration, type ImageAssessmentResult } from './image-assessment.js';
import { PixelImageChecker, PIXEL_VERSION, PIXEL_SCORE_VERSION, PIXEL_CONFIG_HASH, PIXEL_IMPLEMENTATION_HASH, type PixelOptions, type PixelPolicy, type PixelCalibration, type PixelResult } from './image-pixel.js';
import type { ImageAnalysisFailure } from './image-analysis-failure.js';
import { PIXEL_FOCUS_VERSION } from './image-pixel-focus.js';

export type ImageScorer=ImageAssessmentChecker|PixelImageChecker;
export type ScoredImage=ImageAssessmentResult|PixelResult;
export type ScoringPolicy=ImagePolicy|PixelPolicy;
export type ScoringCalibration=AssessmentCalibration|PixelCalibration;
export interface ScoringContext {
  analysisVersion:string; scoreVersion:string; policy:ScoringPolicy; calibration:ScoringCalibration|null;
  configHash?:string; implementationHash?:string;
  operationFocusVersion?:typeof PIXEL_FOCUS_VERSION;
}
export type ImageScorerMode='legacy'|'pixel-v1.23.0';
export function createImageScorer(dataDir:string,options:PixelOptions&{imageScorer?:ImageScorerMode}={}):ImageScorer {
  const mode=options.imageScorer??process.env.CKD_IMAGE_SCORER??'legacy';
  if(mode==='legacy')return new ImageAssessmentChecker(dataDir,options);
  if(mode==='pixel-v1.23.0')return new PixelImageChecker(dataDir,options);
  throw new Error(`Unknown CKD_IMAGE_SCORER: ${mode}`);
}
export function scoringContext(checker:ImageScorer):ScoringContext {
  return {analysisVersion:checker instanceof PixelImageChecker?PIXEL_VERSION:ASSESSMENT_VERSION,
    scoreVersion:checker instanceof PixelImageChecker?PIXEL_SCORE_VERSION:ASSESSMENT_SCORE_VERSION,
    policy:checker.policy(),calibration:checker.calibration()??null,
    ...(checker instanceof PixelImageChecker?{configHash:PIXEL_CONFIG_HASH,implementationHash:PIXEL_IMPLEMENTATION_HASH,
      ...(process.env.CKD_PIXEL_FOCUS_MODE==='legacy'?{}:{operationFocusVersion:PIXEL_FOCUS_VERSION})}:{})};
}
export function scorerForContext(checker:ImageScorer,context:ScoringContext):ImageScorer {
  if(context.analysisVersion===PIXEL_VERSION){
    if(context.scoreVersion!==PIXEL_SCORE_VERSION||context.configHash!==PIXEL_CONFIG_HASH||context.implementationHash!==PIXEL_IMPLEMENTATION_HASH)throw new Error('Saved V1.23.0 scoring implementation/configuration changed. Start a new task.');
    return checker instanceof PixelImageChecker?checker:new PixelImageChecker(checker.dataDir);
  }
  if(context.analysisVersion!==ASSESSMENT_VERSION||context.scoreVersion!==ASSESSMENT_SCORE_VERSION)throw new Error('Saved image assessment version changed; start a new task.');
  validatePolicy(context.policy);
  return checker instanceof PixelImageChecker?checker.legacy():checker;
}
export function scoreWithContext(checker:ImageScorer,bytes:Buffer,signal:AbortSignal,context:ScoringContext,retry=false):Promise<{result?:ScoredImage;fallback?:ImageAnalysisFailure;error?:string}> {
  const selected=scorerForContext(checker,context);
  if(selected instanceof PixelImageChecker)return selected.checkWithFallback(bytes,signal,context.calibration as PixelCalibration|null,context.policy as PixelPolicy,retry);
  return selected.checkWithFallback(bytes,signal,context.calibration as AssessmentCalibration|null,context.policy as ImagePolicy,retry);
}
export function checkWithContext(checker:ImageScorer,bytes:Buffer,signal:AbortSignal,context:ScoringContext):Promise<ScoredImage>{
  const selected=scorerForContext(checker,context);
  if(selected instanceof PixelImageChecker)return selected.check(bytes,signal,context.calibration as PixelCalibration|null,context.policy as PixelPolicy);
  return selected.check(bytes,signal,context.calibration as AssessmentCalibration|null,context.policy as ImagePolicy);
}
export function checkOperationFocus(checker:ImageScorer,image:ScoredImage,bytes:Buffer,context:string,signal:AbortSignal,version?:string){
  if(version!==undefined&&version!==PIXEL_FOCUS_VERSION)throw new Error('Saved operation-focus version is unsupported.');
  if('referenceResult' in image){const pixel=checker instanceof PixelImageChecker?checker:new PixelImageChecker(checker.dataDir);return version===PIXEL_FOCUS_VERSION?pixel.operationFocusFast(context,signal,bytes):pixel.operationFocus(image,context,signal,bytes);}
  const legacy=checker instanceof PixelImageChecker?checker.legacy():checker;return legacy.operationFocus(image,context,signal);
}
