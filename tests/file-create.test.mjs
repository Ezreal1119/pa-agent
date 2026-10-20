import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {FileTools} from '../dist/file-tools/index.js';
import {fileToolConfig,CREATE_TOOL_NAMES,TEXT_OUTPUT_EXTENSIONS} from '../dist/file-tools/config.js';
import {AgentSettingsStore} from '../dist/web/agent-settings.js';

async function setup(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'expert-create-'));const session=randomUUID();const config=fileToolConfig(path.join(root,'.data'),{enabled:true,tools:[...CREATE_TOOL_NAMES],workerImage:'',...options},{});const tools=new FileTools(config);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bytes=async file=>{const opened=await tools.store.open(session,file.id);try{return await opened.handle.readFile();}finally{await opened.handle.close();}};
 return{root,session,tools,config,bytes};
}
const sample={filename:'产品对比.xlsx',sheets:[{name:'对比',headers:['项目','DT610','DT630'],rows:[['屏幕',6,6.6],['RFID',true,false],['备注','中文\n第二行 😀','=1+1'],['空值',null,'']],widths:[20,28,28],formats:['text','general','general']},{name:'Summary',headers:['Ratio'],rows:[[0.5]],formats:['percent'],freezeHeader:false,autoFilter:false}]};
test('new Excel files need no source; all values, text formula literals, styles and multiple worksheets survive readback',{timeout:30000},async t=>{
 const f=await setup(t);let published;const result=await f.tools.execute(f.session,'excel_create',sample,undefined,'run',undefined,file=>{published=file;});assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(published.id,result.file.id);assert.equal(result.metrics.visionCalls,0);assert.ok(result.metrics.peakRssKiB>0);
 const bytes=await f.bytes(result.file);const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);const ws=wb.getWorksheet('对比');assert.equal(ws.getCell('B2').value,6);assert.equal(ws.getCell('B3').value,true);assert.equal(ws.getCell('B4').value,'中文\n第二行 😀');assert.equal(ws.getCell('C4').value,'=1+1');assert.equal(ws.getCell('C4').formula,undefined);assert.equal(ws.getCell('B5').value,null);assert.equal(ws.getCell('C5').value,'');assert.equal(ws.getCell('A1').font.bold,true);assert.equal(ws.getColumn(2).width,28);assert.equal(ws.views[0].ySplit,1);assert.ok(ws.autoFilter);assert.equal(wb.getWorksheet('Summary').getCell('A2').numFmt,'0.00%');
 const zip=await JSZip.loadAsync(bytes);assert.ok(!Object.keys(zip.files).some(name=>/externalLinks|vbaProject/i.test(name)));assert.equal((await fs.stat(path.join(f.tools.store.directory(f.session),result.file.path))).mode&0o777,0o400);
 assert.deepEqual(await fs.readdir(path.join(f.tools.store.directory(f.session),'work')),[]);
});
test('UTF-8 text and source formats are exact, downloadable data; text inputs can also be received without changing output formats',{timeout:30000},async t=>{
 const f=await setup(t);const content='中文 😀\r\n  <script>globalThis.DO_NOT_RUN=1</script>\npublic class Test {}\n';
 for(const ext of TEXT_OUTPUT_EXTENSIONS){const result=await f.tools.execute(f.session,'text_file_create',{filename:'result'+ext,content});assert.equal(result.ok,true);assert.equal(result.encoding,'UTF-8');const bytes=await f.bytes(result.file);assert.equal(bytes.toString('utf8'),content);assert.equal(result.file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.ok(result.file.path.endsWith(ext));}
 const uploaded=await f.tools.store.upload(f.session,'input.md',[Buffer.from('input')]);assert.equal(uploaded.direction,'inputs');
 const restored=new FileTools(f.config);assert.equal((await restored.store.list(f.session)).length,TEXT_OUTPUT_EXTENSIONS.size+1);
 const empty=await f.tools.execute(f.session,'text_file_create',{filename:'empty.txt',content:''});assert.equal((await f.bytes(empty.file)).length,0);
});
test('creators reject path escapes, overwrite, executable values and malformed workbooks without altering unrelated files',{timeout:30000},async t=>{
 const f=await setup(t);const sentinel=path.join(f.root,'sentinel.txt');await fs.writeFile(sentinel,'UNCHANGED');
 for(const filename of ['../sentinel.txt',sentinel,'outputs/x.md','.env','x.exe','x.sh','x.xlsx'])await assert.rejects(f.tools.execute(f.session,'text_file_create',{filename,content:'BAD'}));
 for(const sheets of [[{name:'Data',headers:['x'],rows:[[1,2]]}],[{name:'Data',headers:['x'],rows:[[{formula:'1+1'}]]}],[{name:'Data',headers:['x'],rows:[[1]],widths:[10,20]}],[{name:'Data',headers:['x'],rows:[[1]]},{name:'data',headers:['x'],rows:[[2]]}],[{name:'A/B',headers:['x'],rows:[[1]]}]])await assert.rejects(f.tools.execute(f.session,'excel_create',{filename:'bad.xlsx',sheets}));
 await assert.rejects(f.tools.execute(f.session,'text_file_create',{filename:'nul.txt',content:'a\0b'}),/NUL/);
 const first=await f.tools.execute(f.session,'text_file_create',{filename:'once.md',content:'first'});await assert.rejects(f.tools.execute(f.session,'text_file_create',{filename:'once.md',content:'second'}),/already exists/);assert.equal((await f.bytes(first.file)).toString(),'first');assert.equal(await fs.readFile(sentinel,'utf8'),'UNCHANGED');
 await assert.rejects(f.tools.store.open(randomUUID(),first.file.id));assert.equal((await f.tools.store.list(f.session)).length,1);
});
test('limits, failed verification jobs, symlinks and cancellation do not publish outputs',{timeout:30000},async t=>{
 const f=await setup(t,{maxCells:2});await assert.rejects(f.tools.execute(f.session,'excel_create',sample),/cell limit/);
 const quota=new FileTools({...f.config,sessionQuotaBytes:4});await assert.rejects(quota.execute(f.session,'text_file_create',{filename:'quota.md',content:'too much'}),/quota/);
 const timeout=new FileTools({...f.config,timeoutMs:1});await assert.rejects(timeout.execute(f.session,'text_file_create',{filename:'timeout.md',content:'x'}),/timed out/);
 const controller=new AbortController();controller.abort();await assert.rejects(f.tools.execute(f.session,'text_file_create',{filename:'cancel.md',content:'x'},controller.signal),/cancelled/);
 const big=new FileTools({...f.config,maxFileBytes:5});await assert.rejects(big.execute(f.session,'text_file_create',{filename:'big.md',content:'中文中文'}),/limit/);
 const directory=f.tools.store.directory(f.session);await fs.mkdir(path.join(directory,'outputs'),{recursive:true});await fs.rmdir(path.join(directory,'outputs'));await fs.symlink(f.root,path.join(directory,'outputs'));
 await assert.rejects(f.tools.execute(f.session,'text_file_create',{filename:'link.md',content:'BAD'}),/unsafe/i);assert.equal(await fs.stat(path.join(f.root,'link.md')).catch(()=>null),null);assert.deepEqual(await f.tools.store.list(f.session),[]);assert.deepEqual(await fs.readdir(path.join(directory,'work')),[]);
});
test('new creation tools default off; old six-tool preferences migrate without enabling them; expiry deletes all generated formats',async t=>{
 const f=await setup(t);const defaults=fileToolConfig(f.root,{enabled:true},{});assert.ok(CREATE_TOOL_NAMES.every(name=>!defaults.tools.includes(name)));
 const disabled=new FileTools({...f.config,tools:[]});assert.deepEqual(disabled.tools(f.session),[]);await assert.rejects(disabled.execute(f.session,'text_file_create',{filename:'off.md',content:'x'}),/disabled/);
 const store=new AgentSettingsStore(path.join(f.root,'settings'));const old={effort:'low',fileTools:{tools:Object.fromEntries(defaults.tools.map(name=>[name,true]))}};await store.save(old);const settings=await store.load(old);assert.equal(settings.fileTools.tools.excel_create,false);assert.equal(settings.fileTools.tools.text_file_create,false);assert.ok(defaults.tools.every(name=>settings.fileTools.tools[name]));
 await f.tools.execute(f.session,'text_file_create',{filename:'expired.html',content:'<h1>test</h1>'});await f.tools.execute(f.session,'excel_create',{filename:'expired.xlsx',sheets:[{name:'Data',headers:['x'],rows:[[1]]}]});const directory=f.tools.store.directory(f.session);const oldDate=new Date(Date.now()-31*86400000);await fs.utimes(directory,oldDate,oldDate);assert.deepEqual(await f.tools.store.cleanup(),[f.session]);assert.equal(await fs.stat(directory).catch(()=>null),null);
});
