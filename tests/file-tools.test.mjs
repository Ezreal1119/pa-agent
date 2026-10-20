import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {crc32} from 'node:zlib';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {FileTools} from '../dist/file-tools/index.js';
import {fileToolConfig} from '../dist/file-tools/config.js';
import {fileQueue,queueState} from '../dist/file-tools/runner.js';
import {fixtures,imageFixture} from './file-fixtures.mjs';

async function setup(t,overrides={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'expert-files-'));const source=path.join(root,'fixtures');await fixtures(source);
 const requests=[];let delay=0;
 const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;requests.push(JSON.parse(text));if(delay)await new Promise(r=>setTimeout(r,delay));if(res.destroyed)return;res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'mock-vision',choices:[{message:{content:'A blue square and the text TEST 42.'}}],usage:{prompt_tokens:12,completion_tokens:9,total_tokens:21}}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const config=fileToolConfig(path.join(root,'.data'),{enabled:true,markitdown:process.env.FILE_TEST_MARKITDOWN||path.resolve('.data/file-runtime/bin/markitdown'),vision:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'TEST_VISION_SECRET',model:'mock-vision'},...overrides});const tools=new FileTools(config);const session=randomUUID();
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const upload=async name=>tools.store.upload(session,name,[await fs.readFile(path.join(source,name))]);
 return {root,source,tools,session,upload,requests,delay(ms){delay=ms;}};
}
test('all six tools process real formats in isolated processes, with protected Excel output', {timeout:120000},async t=>{
 const f=await setup(t);const uploaded={};for(const name of ['image.png','sample.pdf','sample.docx','sample.pptx','sample.xlsx'])uploaded[name]=await f.upload(name);
 const run=(name,args)=>f.tools.execute(f.session,name,args);
 const image=await run('image_read',{path:uploaded['image.png'].path,question:'Read the text.'});assert.equal(image.ok,true);assert.match(image.description,/TEST 42/);assert.equal(image.metrics.visionCalls,1);assert.ok(image.metrics.peakRssKiB>0);assert.ok(!JSON.stringify(image).includes('base64'));assert.ok(!JSON.stringify(image).includes('TEST_VISION_SECRET'));
 if(f.tools.config.workerImage){assert.equal(image.metrics.backend,'docker');assert.ok(image.metrics.workerPeakBytes>0);assert.ok(image.metrics.workerPeakBytes<=768*1024*1024);}else assert.equal(image.metrics.backend,'process');
 const crop=await run('image_read',{path:uploaded['image.png'].path,region:{left:0,top:0,width:80,height:90}});assert.equal(crop.processedImages[0].width,80);assert.ok(crop.processedImages[0].region);
 const pdf=await run('pdf_read',{path:uploaded['sample.pdf'].path});assert.match(pdf.markdown,/PDF FILE TOOL TEST 42/);assert.equal(pdf.pageCount,1);assert.equal(pdf.metrics.visionCalls,0);
 const cachedPdf=await run('pdf_read',{path:uploaded['sample.pdf'].path,query:'TEST 42'});assert.equal(cachedPdf.conversionCacheHit,true);assert.equal(cachedPdf.matches.length,1);
 const refreshedPdf=await run('pdf_read',{path:uploaded['sample.pdf'].path,forceRefresh:true});assert.equal(refreshedPdf.conversionCacheHit,false);
 const pdfVisual=await run('pdf_read',{path:uploaded['sample.pdf'].path,visualAnalysis:'required',visualPages:[1]});assert.equal(pdfVisual.visualAnalysis.status,'completed');
 const docx=await run('docx_read',{path:uploaded['sample.docx'].path});assert.match(docx.markdown,/DOCX FILE TOOL TEST 42/);assert.equal(docx.metrics.visionCalls,0);
 const docxVisual=await run('docx_read',{path:uploaded['sample.docx'].path,visualAnalysis:'required',imageIndexes:[1]});assert.equal(docxVisual.visualAnalysis.status,'completed');
 const pptx=await run('pptx_read',{path:uploaded['sample.pptx'].path});assert.match(pptx.markdown,/PPTX FILE TOOL TEST 42/);assert.equal(pptx.slideCount,1);assert.equal(pptx.visualContent.status,'not_analyzed');
 const search=await run('pptx_read',{path:uploaded['sample.pptx'].path,query:'TEST 42',slideNumbers:[1]});assert.equal(search.matches.length,1);
 const workbook=await run('excel_read',{path:uploaded['sample.xlsx'].path,scope:'workbook'});assert.equal(workbook.status,'complete');assert.match(JSON.stringify(workbook),/HIDDEN SENTINEL/);assert.match(JSON.stringify(workbook),/B2\*2/);assert.equal(workbook.metrics.visionCalls,0);
 const worksheet=await run('excel_read',{path:uploaded['sample.xlsx'].path,scope:'worksheet',sheet:'Data',range:'A1:C3',visualAnalysis:true});assert.equal(worksheet.sheet,'Data');
 const fullImages=await run('excel_read',{path:uploaded['sample.xlsx'].path,scope:'worksheet',sheet:'Data',visualAnalysis:true});assert.equal(fullImages.imageSummary.analyzed,1);
 const noVision=new FileTools({...f.tools.config,vision:{...f.tools.config.vision,apiKey:''}});const imageFailure=await noVision.execute(f.session,'excel_read',{path:uploaded['sample.xlsx'].path,scope:'worksheet',sheet:'Data',visualAnalysis:true});assert.equal(imageFailure.ok,true);assert.equal(imageFailure.imageSummary.analyzed,0);assert.equal(imageFailure.imageBatches[0].status,'unavailable');
 const baseline=await fs.readFile(path.join(f.source,'sample.xlsx'));const patched=await run('excel_patch_template',{sourcePath:uploaded['sample.xlsx'].path,outputPath:'filled.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:77},{type:'setRange',sheet:'Data',range:'A9:B10',values:[['new',1],['other',2]]}]});assert.equal(patched.ok,true);assert.equal(patched.sourcePreserved,true);assert.ok(patched.unchangedPartsVerified>0);
 const opened=await f.tools.store.open(f.session,patched.file.id);const output=await opened.handle.readFile();await opened.handle.close();const beforeZip=await JSZip.loadAsync(baseline);const afterZip=await JSZip.loadAsync(output);assert.deepEqual(await afterZip.file('xl/media/image1.png').async('nodebuffer'),await beforeZip.file('xl/media/image1.png').async('nodebuffer'));
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(output);assert.equal(wb.getWorksheet('Data').getCell('B2').value,77);assert.equal(wb.getWorksheet('Data').getCell('A2').font.bold,true);assert.equal(wb.getWorksheet('Data').getCell('C2').formula,'B2*2');assert.deepEqual(await fs.readFile(path.join(f.source,'sample.xlsx')),baseline);
 await assert.rejects(run('excel_patch_template',{sourcePath:uploaded['sample.xlsx'].path,outputPath:'oversize.xlsx',operations:[{type:'clearRange',sheet:'Data',range:'A1:XFD1048576'}]}),/cell limit|50000-cell/);
 await assert.rejects(run('excel_patch_template',{sourcePath:uploaded['sample.xlsx'].path,outputPath:'blocked.xlsx',operations:[{type:'setCell',sheet:'Data',range:'C2',value:{formula:'1+1'}}]}),/formula/);
 await assert.rejects(run('excel_patch_template',{sourcePath:uploaded['sample.xlsx'].path,outputPath:'filled.xlsx',operations:[{type:'clearCell',sheet:'Data',range:'B2'}]}),/already exists/);
 assert.equal((await fs.readdir(path.join(f.tools.store.directory(f.session),'work'))).length,0);
});
test('disabled module, ownership, symlinks, file quotas and package expansion fail closed', {timeout:30000},async t=>{
 const f=await setup(t);const uploaded=await f.upload('sample.xlsx');
 const disabled=new FileTools({...f.tools.config,enabled:false});assert.deepEqual(disabled.tools(f.session),[]);await assert.rejects(disabled.execute(f.session,'excel_read',{path:uploaded.path,scope:'workbook'}),/disabled/);
 await assert.rejects(f.tools.store.resolve(randomUUID(),uploaded.path),/outside/);await assert.rejects(f.tools.store.upload(f.session,'../escape.xlsx',[Buffer.from('bad')]),/Invalid/);await assert.rejects(f.tools.store.upload(f.session,'file.exe',[Buffer.from('bad')]),/Unsupported/);
 await assert.rejects(f.tools.execute(f.session,'excel_read',{path:uploaded.path,scope:'workbook',sheet:'Data'}),/without sheet/);
 const absolute=path.join(f.tools.store.directory(f.session),uploaded.path);await fs.unlink(absolute);await fs.symlink(path.join(f.source,'sample.xlsx'),absolute);await assert.rejects(f.tools.store.open(f.session,uploaded.id));
 const zip=new JSZip();zip.file('word/document.xml','<word>'+ 'A'.repeat(100000)+'</word>');const bomb=await f.tools.store.upload(f.session,'expansion.docx',[await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})]);const limited=new FileTools({...f.tools.config,maxExpandedBytes:1000});await assert.rejects(limited.execute(f.session,'docx_read',{path:bomb.path}),/expanded/);
 const mergeZip=await JSZip.loadAsync(await fs.readFile(path.join(f.source,'sample.xlsx')));const sheetXml=await mergeZip.file('xl/worksheets/sheet1.xml').async('string');mergeZip.file('xl/worksheets/sheet1.xml',sheetXml.replace('A4:C4','A1:XFD1048576'));const hugeMerge=await f.tools.store.upload(f.session,'huge-merge.xlsx',[await mergeZip.generateAsync({type:'nodebuffer'})]);await assert.rejects(f.tools.execute(f.session,'excel_read',{path:hugeMerge.path,scope:'workbook'}),/merged-cell area/);
 const quota=new FileTools({...f.tools.config,maxFileBytes:10});await assert.rejects(quota.store.upload(f.session,'big.png',[imageFixture()]),/size/);
});
test('single global file queue rejects excess and removes cancelled waiting work',async()=>{
 let release;const blocked=fileQueue(1,undefined,()=>new Promise(resolve=>{release=resolve;}));const controller=new AbortController();const next=fileQueue(1,controller.signal,async()=>assert.fail('cancelled queued work ran'));
 await assert.rejects(fileQueue(1,undefined,async()=>{}),/queue is full/);controller.abort();await assert.rejects(next,/cancelled/);release();await blocked;assert.deepEqual(queueState(),{active:0,waiting:0});
});
test('vision cancellation stops the worker and unavailable vision preserves document text', {timeout:30000},async t=>{
 const f=await setup(t);const image=await f.upload('image.png');f.delay(5000);const controller=new AbortController();const pending=f.tools.execute(f.session,'image_read',{path:image.path},controller.signal);await new Promise(resolve=>setTimeout(resolve,1000));controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(queueState().active,0);
 const doc=await f.upload('sample.docx');const unavailable=new FileTools({...f.tools.config,vision:{...f.tools.config.vision,apiKey:''}});const result=await unavailable.execute(f.session,'docx_read',{path:doc.path,visualAnalysis:'required'});assert.equal(result.ok,true);assert.match(result.markdown,/DOCX FILE TOOL/);assert.equal(result.visualAnalysis.status,'unavailable');
});
test('vision results are reused only within a run and stale session files expire after thirty idle days', {timeout:30000},async t=>{
 const f=await setup(t);const image=await f.upload('image.png');
 await f.tools.execute(f.session,'image_read',{path:image.path},undefined,'same-run');const cached=await f.tools.execute(f.session,'image_read',{path:image.path},undefined,'same-run');assert.equal(cached.metrics.visionCalls,0);assert.equal(cached.metrics.visionCacheHits,1);assert.equal(f.requests.length,1);
 await f.tools.execute(f.session,'image_read',{path:image.path},undefined,'another-run');assert.equal(f.requests.length,2);
 const directory=f.tools.store.directory(f.session);const old=new Date(Date.now()-31*86400000);await fs.utimes(directory,old,old);const cleaned=await f.tools.store.cleanup();assert.deepEqual(cleaned,[f.session]);assert.equal(await fs.stat(directory).catch(()=>null),null);
});

test('individual file switches deny direct execution as well as model tool registration',async()=>{
 const config=fileToolConfig(path.resolve('.data/test-no-write'),{enabled:true,tools:['pdf_read']});const tools=new FileTools(config);assert.deepEqual(tools.tools('test-session-id').map(t=>t.name),['pdf_read']);await assert.rejects(tools.execute('test-session-id','image_read',{path:'inputs/test.png'}),/disabled/);
});

test('Excel and image workers accept inputs above their old private caps under the 30 MiB limit', {timeout:60000},async t=>{
 const f=await setup(t,{maxFileBytes:30*1024*1024,workerImage:''});
 const zip=await JSZip.loadAsync(await fs.readFile(path.join(f.source,'sample.xlsx')));
 zip.file('customXml/preserved.bin',Buffer.alloc(21*1024*1024,0x41));
 const source=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});assert.ok(source.length>20*1024*1024);
 const excel=await f.tools.store.upload(f.session,'large.xlsx',[source]);
 const read=await f.tools.execute(f.session,'excel_read',{path:excel.path,scope:'workbook'});assert.equal(read.ok,true);assert.match(JSON.stringify(read),/DT66/);
 const patch=await f.tools.execute(f.session,'excel_patch_template',{sourcePath:excel.path,outputPath:'large-patched.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:77}]});assert.equal(patch.ok,true);
 const png=imageFixture();const payload=Buffer.alloc(13*1024*1024,0x41);payload.write('Comment\0');
 const type=Buffer.from('tEXt');const chunk=Buffer.alloc(payload.length+12);chunk.writeUInt32BE(payload.length,0);type.copy(chunk,4);payload.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([type,payload])),payload.length+8);
 const image=await f.tools.store.upload(f.session,'large.png',[png.subarray(0,-12),chunk,png.subarray(-12)]);
 const seen=await f.tools.execute(f.session,'image_read',{path:image.path,question:'Describe.'});assert.equal(seen.ok,true);assert.match(seen.description,/TEST 42/);
});

test('native production workers create protected outputs without Docker or a shell on PATH', {timeout:30000},async t=>{
 const f=await setup(t,{workerImage:''});const file=await f.upload('sample.xlsx');
 const source=await fs.readFile(path.join(f.tools.store.directory(f.session),file.path));
 const previous={PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV};
 try {
  process.env.PATH='';process.env.NODE_ENV='production';
  const result=await f.tools.execute(f.session,'excel_patch_template',{sourcePath:file.path,outputPath:'native.xlsx',operations:[{type:'setCell',sheet:'Data',range:'B2',value:88}]});
  assert.equal(result.ok,true);assert.equal(result.metrics.backend,'process');assert.equal(result.metrics.workerPeakBytes,undefined);
  const opened=await f.tools.store.open(f.session,result.file.id);const output=await opened.handle.readFile();await opened.handle.close();
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(output);assert.equal(workbook.getWorksheet('Data').getCell('B2').value,88);
  assert.deepEqual(await fs.readFile(path.join(f.tools.store.directory(f.session),file.path)),source);
  await assert.rejects(f.tools.execute(f.session,'excel_patch_template',{sourcePath:file.path,outputPath:'formula.xlsx',operations:[{type:'clearCell',sheet:'Data',range:'C2'}]}),/formula/);
 } finally {
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
 assert.equal((await fs.readdir(path.join(f.tools.store.directory(f.session),'work'))).length,0);
});
