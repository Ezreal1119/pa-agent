import { readyClientUser, clientCredentials } from './helpers/client-user.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import {createCkdUiServer} from '../src/ckd/ui-server.js';
import {ClientAccess} from '../src/ckd/client-access.js';
import {createImageReview,cropReviewImage,reviewImageBytes,cropOverrides,repairFailedPreviews,effectiveHashes} from '../src/ckd/image-review-stage.js';
import {translateText,verifyTranslation} from '../src/ckd/library-translation.js';
import {validateCkdLibrary} from '../src/ckd/library-validation.js';
import {LibraryMaintenance} from '../src/ckd/library-maintenance.js';
import {PixelImageChecker,type PixelResult} from '../src/ckd/image-pixel.js';
import {mockTranslated} from './helpers/mock-translation.js';
import type {CkdRun} from '../src/ckd/types.js';
const {BackendClient}=createRequire(import.meta.url)('../desktop/backend.cjs');
function fixture(t:{after(fn:()=>void|Promise<void>):void}){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ckd-oct28-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function write(file:string,value:string|Buffer){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
const input={projectName:'A',documentNumber:'1',sopName:'Trash Test',author:'Acceptance'};

test('recoverable deletion checks ownership and live locks; restart/restore retain task bytes and artifacts',async t=>{
 const root=fixture(t),dataDir=path.join(root,'data'),library=path.join(root,'ckd-library-v2');write(path.join(library,'product_lib/A/project.json'),'{}');
 const app=createCkdUiServer({dataDir,libraryPath:library,adminAuth:false});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise<void>(r=>app.server.close(()=>r())));
 const address=app.server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 const clientUser=await readyClientUser(dataDir);
 const desktop=new BackendClient(base);await desktop.login(clientCredentials);
 const owned=app.service.create(input),foreign=app.service.create(input);new ClientAccess(dataDir).claim(owned.id,clientUser.id);
 const file=path.join(owned.workspaceRoot,owned.workspaceRelative,'outputs/retained.xlsx');write(file,'retained workbook');
 const stateFile=path.join(owned.workspaceRoot,owned.workspaceRelative,'state.json'),before=fs.readFileSync(stateFile);
 await assert.rejects(desktop.trash(foreign.id),/任务不存在/u);
 let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
 const lock=app.service.store.locked(owned.id,async()=>{started();await held;});await ready;
 await assert.rejects(desktop.trash(owned.id),/busy/u);release();await lock;
 await desktop.trash(owned.id);assert.equal((await desktop.list()).runs.length,0);assert.equal((await desktop.deleted()).runs.length,1);
 await assert.rejects(desktop.get(owned.id),/回收站/u);await assert.rejects(desktop.resume(owned.id),/回收站/u);
 assert.deepEqual(fs.readFileSync(stateFile),before);assert.equal(fs.readFileSync(file,'utf8'),'retained workbook');
 await desktop.restore(owned.id);assert.equal((await desktop.get(owned.id)).run.id,owned.id);assert.equal((await desktop.deleted()).runs.length,0);assert.deepEqual(fs.readFileSync(stateFile),before);
 assert.equal((await fetch(base+'/api/client/trash')).status,401);
});

test('large JPG previews stay under 10MiB while full-resolution crops retain original pixels',async t=>{
 const root=fixture(t),id='11111111-1111-4111-8111-111111111111',w=2000,h=2200;
 const raw=Buffer.alloc(w*h*3);let seed=1977;for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=seed>>>24;}
 const jpg=await sharp(raw,{raw:{width:w,height:h,channels:3}}).jpeg({quality:80}).toBuffer();assert.ok(jpg.length<10*1024*1024);
 const relative=`effective-processes/${id}/P/photos/p1.jpg`,file=path.join(root,id,relative);write(file,jpg);
 const run={id,workspaceRoot:root,workspaceRelative:id,status:'awaiting_image_review'} as CkdRun;
 const prepared={output:{imageQuality:{images:[{path:relative,processId:'P',processName:'P'}]}}} as any;
 run.imageReview=await createImageReview(run,prepared,{}, effectiveHashes(run),new AbortController().signal);
 const image=run.imageReview.images[0]!;assert.equal(image.previewError,undefined);assert.ok(image.width<=1600&&image.height<=1600);assert.equal(image.sourceWidth,w);assert.equal(image.sourceHeight,h);
 assert.ok(reviewImageBytes(run,image.id,true).length<10*1024*1024);
 const originalId=image.id;image.previewError='图片预览超过 10 MiB，无法裁剪。';delete image.previewFile;
 assert.equal(await repairFailedPreviews(run),true);assert.equal(image.id,originalId);assert.equal(image.previewError,undefined);assert.equal(run.imageReview.prepared,prepared);
 await cropReviewImage(run,image.id,{left:0,top:0,width:image.width,height:image.height});
 const override=cropOverrides(run)[0] as any,full=fs.readFileSync(path.join(root,id,override.file));assert.ok(full.length>10*1024*1024);
 const actual=await sharp(full).metadata();assert.equal(actual.width,w);assert.equal(actual.height,h);assert.ok(reviewImageBytes(run,image.id).length<10*1024*1024);
 const decoded=await sharp(jpg).raw().toBuffer(),cropped=await sharp(full).raw().toBuffer();assert.deepEqual(cropped,decoded);assert.deepEqual(fs.readFileSync(file),jpg);
 const exported=path.join(root,'excel-processes/P');write(path.join(exported,'metadata.txt'),'Large JPG');write(path.join(exported,'operation_steps.txt'),'Check image.');write(path.join(exported,'photos/p1.png'),full);
 const {buildCkdSop}=createRequire(import.meta.url)(path.resolve('resources/workflows/create-ckd-sop/create-ckd-sop-v3/fill_sop_sheet.js'));
 const xlsx=path.join(root,'large.xlsx');await buildCkdSop({output:xlsx,projectDir:path.dirname(exported),projectName:'A',documentNo:'1',sopName:'Large Crop',author:'Test',processList:['P'],sopType:'assembly_test',templateLanguage:'English'});
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(xlsx);let embedded=false;
 for(const media of (book.model as any).media??[]){if(!media.buffer)continue;const info=await sharp(Buffer.from(media.buffer)).metadata();if(info.width===w&&info.height===h)embedded=true;}
 assert.equal(embedded,true,'Excel embeds the full-resolution crop, not the display preview');
});

test('EXIF orientation and scaled crop coordinates map to full resolution',async t=>{
 const root=fixture(t),id='11111111-1111-4111-8111-111111111111';
 const jpg=await sharp({create:{width:2400,height:1800,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const relative=`effective-processes/${id}/P/photos/p1.jpg`;write(path.join(root,id,relative),jpg);
 const run={id,workspaceRoot:root,workspaceRelative:id,status:'awaiting_image_review'} as CkdRun;
 run.imageReview=await createImageReview(run,{output:{imageQuality:{images:[{path:relative,processId:'P',processName:'P'}]}}} as any,{}, {},new AbortController().signal);
 const image=run.imageReview.images[0]!;assert.equal(image.sourceWidth,1800);assert.equal(image.sourceHeight,2400);assert.equal(image.height,1600);
 await cropReviewImage(run,image.id,{left:0,top:0,width:image.width/2,height:image.height});
 const full=await sharp(path.join(root,id,image.crop!.file)).metadata();assert.equal(full.width,900);assert.equal(full.height,2400);
});

test('numeric title boundaries are restored without weakening identifiers, digits or cache validation',async t=>{
 const root=fixture(t);let calls=0;
 const context={directory:path.join(root,'jobs/job'),signal:new AbortController().signal,model:{async complete(r:any){calls++;const p=JSON.parse(r.prompt);return {model:'fake',text:JSON.stringify({text:p.text.replace('扫描头组件加工','Scan Engine Assembly Processing')})};}}};
 for(const title of ['620扫描头组件加工5-1','620扫描头组件加工5-2']){
  const translated=await translateText(context,title,'English');assert.match(translated.text,/^620 Scan Engine Assembly Processing 5-[12]$/u);verifyTranslation(title,translated.text);
  const count=calls;assert.equal((await translateText(context,title,'English')).text,translated.text);assert.equal(calls,count);
 }
 const identifier=await translateText(context,'M3扫描头组件加工5-1','English');assert.equal(identifier.text,'M3 Scan Engine Assembly Processing 5-1');verifyTranslation('M3扫描头组件加工5-1',identifier.text);
 assert.throws(()=>verifyTranslation('620扫描头组件加工5-1','621 Scan Engine Assembly Processing 5-1'),/numeric/u);
 assert.throws(()=>verifyTranslation('M3型号620','M4 model 620'),/numeric/u);
});

test('preflight collects unreadable text and image paths before any model or Library write',async t=>{
 const root=fixture(t),library=path.join(root,'ckd-library-v2'),p=path.join(library,'processes_lib/factory_test/P');
 write(path.join(library,'product_lib/A/project.json'),'{}');write(path.join(p,'metadata.txt'),'Camera');write(path.join(p,'operation_steps.txt'),'Check camera.');
 write(path.join(p,'Previous_Station_Check.txt'),Buffer.from([0xff,0xfe,0x81]));write(path.join(p,'photos/p1.jpg'),Buffer.from('encrypted proprietary file'));
 write(path.join(p,'photos/p2.png'),Buffer.from('encrypted second file'));
 const report=await validateCkdLibrary(library,{},true);assert.equal(report.errors.length,3);assert.ok(report.errors.some(e=>e.file.endsWith('Previous_Station_Check.txt')));assert.ok(report.errors.some(e=>e.file.endsWith('photos/p1.jpg')));assert.ok(report.errors.every(e=>e.message.includes('解密')));
 let calls=0;const jobs=new LibraryMaintenance({dataDir:path.join(root,'data'),libraryPath:library,model:{async complete(){calls++;throw new Error('must not run');}}});
 const job=await jobs.start('sync');assert.equal(calls,0);assert.equal(job.sync!.stages.validate!.status,'failed');assert.equal(job.sync!.stages.translate,undefined);assert.equal(job.sync!.validation!.errors.length,3);
 assert.equal(fs.readFileSync(path.join(p,'photos/p1.jpg'),'utf8'),'encrypted proprietary file');
});

test('image scoring errors report every path sharing a hash',async t=>{
 const root=fixture(t),library=path.join(root,'ckd-library-v2'),data=path.join(root,'data'),p=path.join(library,'processes_lib/factory_test/P');
 write(path.join(library,'product_lib/A/project.json'),'{}');write(path.join(p,'metadata.txt'),'Camera');write(path.join(p,'operation_steps.txt'),'Check camera.');
 const png=await sharp({create:{width:32,height:32,channels:3,background:'gray'}}).png().toBuffer();write(path.join(p,'photos/p1.png'),png);write(path.join(p,'photos/p2.png'),png);
 class Failed extends PixelImageChecker{override async check():Promise<PixelResult>{throw new Error('forced decoding failure');}}
 const jobs=new LibraryMaintenance({dataDir:data,libraryPath:library,imageChecker:new Failed(data),model:{async complete(r){if(r.purpose==='translate'){const v=JSON.parse(r.prompt);return {model:'fake',text:JSON.stringify({text:mockTranslated(v.text,v.targetLanguage)})};}return {model:'fake',text:'Visible camera.'};}}});
 const job=await jobs.start('sync'),errors=job.items.filter(i=>i.key.startsWith('images:')&&i.status==='error');assert.equal(errors.length,1);
 assert.ok(errors[0]!.message!.includes('photos/p1.png'));assert.ok(errors[0]!.message!.includes('photos/p2.png'));assert.ok(job.sync!.images!.filter(i=>i.error).length>=2);
});
