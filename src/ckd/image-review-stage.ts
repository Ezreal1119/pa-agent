import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { CkdRun, JsonValue, WorkflowStepSubmission } from './types.js';
import { isInside } from './store.js';
import { sha256 } from './scripts.js';
import { inspectImage, MAX_IMAGE_BYTES } from './image-input.js';

export interface CropRect { left: number; top: number; width: number; height: number }
export interface ReviewImage {
  id: string; processId: string; processName: string; name: string; path: string; sourceHash: string;
  width: number; height: number; previewFile?: string; previewHash?: string; previewError?: string;
  sourceWidth?:number; sourceHeight?:number;
  crop?: { rect: CropRect; file: string; hash: string; sourceRect?:CropRect; previewFile?:string; previewHash?:string };
}
export interface ImageReviewStage {
  id: string; revision: number; approved: boolean; values: Record<string, JsonValue>;
  prepared: WorkflowStepSubmission; sourceHashes: Record<string, string>; images: ReviewImage[];
}
const workspace = (run: CkdRun) => path.resolve(run.workspaceRoot, run.workspaceRelative);
const temporary = (run: CkdRun) => {
  const dir = path.join(workspace(run), 'image-review-temp');
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !isInside(workspace(run), fs.realpathSync(dir)))) throw new Error('裁剪缓存目录无效。');
  return dir;
};
export function taskFile(run: CkdRun, name: string) {
  const root = workspace(run), file = path.resolve(root, name);
  if (!isInside(root, file) || !isInside(root, fs.realpathSync(file)) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('图片不在当前任务目录内。');
  return file;
}
export function effectiveHashes(run: CkdRun): Record<string, string> {
  const root = path.join(workspace(run), 'effective-processes', run.id), hashes: Record<string, string> = {};
  function visit(dir: string) {
    if (fs.lstatSync(dir).isSymbolicLink() || !isInside(workspace(run), fs.realpathSync(dir))) throw new Error('任务资料路径无效。');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('任务资料不能包含符号链接。');
      const key = path.relative(root, file).split(path.sep).join('/');
      if (entry.isDirectory()) { hashes[key + '/'] = 'directory'; visit(file); }
      else if (entry.isFile()) hashes[key] = sha256(fs.readFileSync(file));
    }
  }
  visit(root); return hashes;
}
export function verifyReviewSources(run: CkdRun) {
  if (JSON.stringify(effectiveHashes(run)) !== JSON.stringify(run.imageReview!.sourceHashes)) throw new Error('图片确认期间任务资料已改变，请新建任务。');
}
function writeBytes(file: string, bytes: Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
async function previewBytes(bytes:Buffer){
  const preview=await sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  if(preview.length>MAX_IMAGE_BYTES)throw new Error('显示预览超过10 MiB，请检查图片格式。');
  return preview;
}
export async function createImageReview(run: CkdRun, prepared: WorkflowStepSubmission, values: Record<string, JsonValue>, sourceHashes: Record<string, string>, signal: AbortSignal): Promise<ImageReviewStage> {
  const report = (prepared.output as any).imageQuality;
  const images: ReviewImage[] = [];
  for (const item of report.images) {
    signal.throwIfAborted();
    const file = taskFile(run, item.path), bytes = fs.readFileSync(file);
    const image: ReviewImage = { id: randomUUID(), processId: item.processId, processName: item.processName, name: path.basename(file), path: item.path, sourceHash: sha256(bytes), width: 0, height: 0 };
    images.push(image);
    try {
      inspectImage(bytes);
      const metadata=await sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}).metadata();
      const swapped=metadata.orientation!==undefined&&metadata.orientation>=5&&metadata.orientation<=8;
      image.sourceWidth=(swapped?metadata.height:metadata.width)!;image.sourceHeight=(swapped?metadata.width:metadata.height)!;
      const preview = await previewBytes(bytes);
      signal.throwIfAborted();
      if (preview.length > MAX_IMAGE_BYTES) throw new Error('图片预览超过 10 MiB，无法裁剪。');
      const info = inspectImage(preview); image.width = info.width; image.height = info.height;
      const previewFile = path.join(temporary(run), image.id + '-original.png');
      writeBytes(previewFile, preview);
      image.previewFile = path.relative(workspace(run), previewFile); image.previewHash = sha256(preview);
    } catch (error) { signal.throwIfAborted(); image.previewError = error instanceof Error ? error.message : String(error); }
  }
  return { id: randomUUID(), revision: 0, approved: false, values, prepared, sourceHashes, images };
}
export function reviewImageBytes(run: CkdRun, id: string, original = false) {
  const stage = run.imageReview;
  if (!stage || stage.approved || run.status !== 'awaiting_image_review') throw new Error('当前任务不在图片确认环节。');
  const image = stage.images.find(item => item.id === id);
  if (!image?.previewFile) throw new Error('图片预览不可用。');
  const originalBytes = fs.readFileSync(taskFile(run, image.path));
  if (sha256(originalBytes) !== image.sourceHash) throw new Error('原始图片已改变，请新建任务。');
  const selected = !original && image.crop ? {file:image.crop.previewFile??image.crop.file,hash:image.crop.previewHash??image.crop.hash} : { file: image.previewFile, hash: image.previewHash };
  const bytes = fs.readFileSync(taskFile(run, selected.file));
  if (bytes.length > MAX_IMAGE_BYTES || sha256(bytes) !== selected.hash) throw new Error('缓存图片已改变，请新建任务。');
  return bytes;
}
/** Rebuild only failed previews in historical review stages; keep reports/crops. */
export async function repairFailedPreviews(run:CkdRun){
  const stage=run.imageReview;if(!stage||stage.approved||!stage.images.some(i=>i.previewError))return false;
  verifyReviewSources(run);let changed=false;
  for(const image of stage.images.filter(i=>i.previewError)){
    const source=fs.readFileSync(taskFile(run,image.path));if(sha256(source)!==image.sourceHash)throw new Error('原始图片已改变，请新建任务。');
    const prepared={...stage.prepared,output:{...(stage.prepared.output as any),imageQuality:{images:[{path:image.path,processId:image.processId,processName:image.processName}]}}};
    const rebuilt=(await createImageReview(run,prepared,stage.values,stage.sourceHashes,new AbortController().signal)).images[0]!;
    if(rebuilt.previewError){if(image.previewError!==rebuilt.previewError){image.previewError=rebuilt.previewError;changed=true;}continue;}
    const id=image.id,crop=image.crop;Object.assign(image,rebuilt,{id,crop});delete image.previewError;changed=true;
  }
  if(changed)stage.revision++;return changed;
}
export async function cropReviewImage(run: CkdRun, id: string, rect: unknown) {
  const bytes = reviewImageBytes(run, id, true), stage = run.imageReview!, image = stage.images.find(item=>item.id===id)!;
  if (rect === null) { delete image.crop; stage.revision++; return; }
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) throw new Error('裁剪范围无效。');
  const r = rect as CropRect;
  if (Object.keys(rect).sort().join(',') !== 'height,left,top,width' || ![r.left,r.top,r.width,r.height].every(Number.isSafeInteger) || r.left < 0 || r.top < 0 || r.width < 1 || r.height < 1 || r.left+r.width > image.width || r.top+r.height > image.height) throw new Error('裁剪范围超出原图。');
  const sw=image.sourceWidth??image.width,sh=image.sourceHeight??image.height;
  const left=Math.floor(r.left*sw/image.width),top=Math.floor(r.top*sh/image.height);
  const sourceRect={left,top,width:Math.min(sw,Math.ceil((r.left+r.width)*sw/image.width))-left,height:Math.min(sh,Math.ceil((r.top+r.height)*sh/image.height))-top};
  const source=image.sourceWidth?fs.readFileSync(taskFile(run,image.path)):bytes;
  const cropped = await sharp(source, { limitInputPixels: 40_000_000,failOn:'error' }).rotate().extract(sourceRect).png().toBuffer();
  if (cropped.length > 192*1024*1024) throw new Error('裁剪输出超出内部资源限制。');
  const hash = sha256(cropped), file = path.join(temporary(run), image.id + '-' + hash + '.png');
  const preview=await previewBytes(cropped),previewFile=file+'.preview.png';
  writeBytes(file, cropped);writeBytes(previewFile,preview);
  image.crop = { rect: { ...r },sourceRect, file: path.relative(workspace(run), file), hash,previewFile:path.relative(workspace(run),previewFile),previewHash:sha256(preview) }; stage.revision++;
}
export function cropOverrides(run: CkdRun): JsonValue[] {
  const root = path.join(workspace(run), 'effective-processes', run.id);
  return run.imageReview!.images.filter(image=>image.crop).map(image=> {
    const file = taskFile(run, image.crop!.file);
    if (sha256(fs.readFileSync(file)) !== image.crop!.hash) throw new Error('裁剪缓存已改变。');
    return { file: image.crop!.file, hash: image.crop!.hash, target: path.relative(root, taskFile(run, image.path)).split(path.sep).join('/') };
  });
}
export function cleanupReview(run: CkdRun) { fs.rmSync(temporary(run), { recursive: true, force: true }); }
export function publicImageReview(run: CkdRun) {
  const stage = run.imageReview;
  if (!stage || stage.approved || run.status !== 'awaiting_image_review') return undefined;
  const { generation: _generation, effectiveFiles: _files, ...output } = stage.prepared.output as Record<string, JsonValue>;
  return { id: stage.id, revision: stage.revision, images: stage.images.map(({ id, processName, name, width, height, sourceWidth,sourceHeight,crop, previewError })=>({ id, processName, name, width, height,sourceWidth:sourceWidth??width,sourceHeight:sourceHeight??height, cropped: !!crop, rect: crop?.rect, previewError })),
    output };
}
