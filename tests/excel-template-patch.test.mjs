import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {patchWorkbookTemplateOoxml} from '../dist/file-tools/vendor/excelTemplateOoxml.js';
import {assertWorksheetPatchIntegrity,worksheetElements,worksheetAttributes} from '../dist/file-tools/vendor/excelTemplateValidation.js';
import {FileTools} from '../dist/file-tools/index.js';
import {fileToolConfig} from '../dist/file-tools/config.js';

const sheet='Hardware Specification';
async function template(transform=x=>x) {
 const workbook=new ExcelJS.Workbook();const ws=workbook.addWorksheet(sheet);
 for(let row=1;row<=33;row++) {
  for(let column=1;column<=5;column++)ws.getCell(row,column).value=`Original ${row}:${column}`;
  ws.getRow(row).height=22;
  ws.getCell(row,6).border={bottom:{style:'thin'}};
  if(row<5)ws.getCell(row,6).value=`Header ${row}`;
 }
 ws.getCell('E8').value={formula:'1+1',result:2};
 ws.mergeCells('A1:C1');ws.pageSetup.printArea='A1:F33';
 const second=workbook.addWorksheet('TMS Specification');for(let r=1;r<=11;r++)second.getCell(r,1).value=`TMS ${r}`;
 const zip=await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
 zip.file('xl/worksheets/sheet1.xml',transform(await zip.file('xl/worksheets/sheet1.xml').async('string')));
 return zip.generateAsync({type:'nodebuffer'});
}
const set=(range,value)=>({type:'setCell',sheet,range,value});
async function open(buffer) {const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);return workbook;}
async function xml(buffer) {return (await JSZip.loadAsync(buffer)).file('xl/worksheets/sheet1.xml').async('string');}

test('styled self-closing row-end cells never consume the following row or its formula',async()=>{
 const source=await template();const original=await xml(source);
 assert.match(original,/<c r="F7"[^>]*\/>/);
 const result=await patchWorkbookTemplateOoxml(source,[set('F7','TEST')]);
 const workbook=await open(result.buffer);const ws=workbook.getWorksheet(sheet);
 assert.equal(ws.rowCount,33);assert.equal(ws.getCell('F7').value,'TEST');
 assert.equal(ws.getCell('B8').value,'Original 8:2');assert.equal(ws.getCell('E8').formula,'1+1');
 assert.deepEqual(ws.getCell('F7').border,(await open(source)).getWorksheet(sheet).getCell('F7').border);
 assertWorksheetPatchIntegrity(original,await xml(result.buffer),new Map([['F7','TEST']]));
});

test('multi-sheet range filling preserves all 33 rows and every untouched cell',async()=>{
 const source=await template();const values=Array.from({length:29},(_,i)=>[`Answer ${i+5} & <ok> 中文`]);
 const result=await patchWorkbookTemplateOoxml(source,[{type:'setRange',sheet,range:'F5:F33',values},{type:'setRange',sheet:'TMS Specification',range:'F4:F11',values:Array.from({length:8},()=>['Yes'])}]);
 const ws=(await open(result.buffer)).getWorksheet(sheet);assert.equal(ws.rowCount,33);
 for(let row=5;row<=33;row++){assert.equal(ws.getCell(row,6).value,values[row-5][0]);assert.equal(ws.getCell(row,2).value,`Original ${row}:2`);}
 assert.equal(result.cellsChanged,37);assert.equal((await open(source)).getWorksheet(sheet).getCell('F7').value,null);
});

test('clear and refill preserve styles, including empty strings, escaped text, numbers and booleans',async()=>{
 const source=await template();
 const first=await patchWorkbookTemplateOoxml(source,[set('F7','first'),{type:'clearCell',sheet,range:'F7'},set('F7',' final & <value> '),set('F8',''),set('F9',0),set('F10',false)]);
 const ws=(await open(first.buffer)).getWorksheet(sheet);
 assert.equal(ws.getCell('F7').value,' final & <value> ');assert.ok([null,''].includes(ws.getCell('F8').value));assert.equal(ws.getCell('F9').value,0);assert.equal(ws.getCell('F10').value,false);
 const cleared=await patchWorkbookTemplateOoxml(first.buffer,[{type:'clearRange',sheet,range:'F7:F10'}]);
 const filled=await patchWorkbookTemplateOoxml(cleared.buffer,[set('F7','refilled')]);
 assert.equal((await open(filled.buffer)).getWorksheet(sheet).rowCount,33);
 assert.equal((await open(filled.buffer)).getWorksheet(sheet).getCell('F7').value,'refilled');
});

test('insertion into self-closing rows and absent rows/cells keeps coordinate order',async()=>{
 const source=await template(original=>{
  let out=original;const rows=worksheetElements(original,'row');
  for(const row of [...rows].reverse()) {
   const r=worksheetAttributes(row.openingTag).get('r');
   if(r==='6')out=out.slice(0,row.index)+row.openingTag.replace(/>$/,'/>')+out.slice(row.end);
   if(r==='2')out=out.slice(0,row.index)+out.slice(row.end);
  }
  const cell=worksheetElements(out,'c').find(c=>worksheetAttributes(c.openingTag).get('r')==='C7');
  return out.slice(0,cell.index)+out.slice(cell.end);
 });
 const result=await patchWorkbookTemplateOoxml(source,[set('F6','empty-row'),set('C7','middle-cell'),set('A2','new-row')]);
 const ws=(await open(result.buffer)).getWorksheet(sheet);
 assert.equal(ws.getCell('F6').value,'empty-row');assert.equal(ws.getCell('C7').value,'middle-cell');assert.equal(ws.getCell('D7').value,'Original 7:4');assert.equal(ws.getCell('A2').value,'new-row');assert.equal(ws.rowCount,33);
});

test('both empty sheetData forms can receive their first row without moving worksheet nodes',async()=>{
 for(const data of ['<sheetData/>','<sheetData></sheetData>']) {
  const source=await template(original=>{
   const element=worksheetElements(original,'sheetData')[0];
   return original.slice(0,element.index)+data+original.slice(element.end);
  });
  const result=await patchWorkbookTemplateOoxml(source,[set('F7','new')]);
  assert.equal((await open(result.buffer)).getWorksheet(sheet).getCell('F7').value,'new');
 }
});

test('single-quoted opening attributes remain supported without duplicate type/style attributes',async()=>{
 const source=await template(original=>original.replace(/<c r="F7" s="([^"]+)"\/>/,"<c r='F7' s='$1' t='n'/>"));
 const result=await patchWorkbookTemplateOoxml(source,[set('F7','Text')]);
 assert.equal((await open(result.buffer)).getWorksheet(sheet).getCell('F7').value,'Text');
});

test('verification rejects cross-row damage, wrong values, style loss and changes outside requested cells',async()=>{
 const source=await template();const before=await xml(source);
 const result=await patchWorkbookTemplateOoxml(source,[set('F7','TEST')]);const after=await xml(result.buffer);const expected=new Map([['F7','TEST']]);
 const row8=worksheetElements(after,'row').find(r=>worksheetAttributes(r.openingTag).get('r')==='8');
 assert.throws(()=>assertWorksheetPatchIntegrity(before,after.replace(row8.xml,''),expected),/row 8|verification/);
 assert.throws(()=>assertWorksheetPatchIntegrity(before,after.replace('>TEST<','>WRONG<'),expected),/wrong value/);
 const f7=worksheetElements(after,'c').find(c=>worksheetAttributes(c.openingTag).get('r')==='F7');
 assert.throws(()=>assertWorksheetPatchIntegrity(before,after.replace(f7.xml,f7.xml.replace(/ s="[^"]+"/,'')),expected),/style/);
 const b9=worksheetElements(after,'c').find(c=>worksheetAttributes(c.openingTag).get('r')==='B9');
 assert.throws(()=>assertWorksheetPatchIntegrity(before,after.replace(b9.xml,b9.xml.replace(/<v>[^<]*<\/v>/,'<v>99999</v>')),expected),/untouched cell/);
 assert.throws(()=>assertWorksheetPatchIntegrity(before,after.replace('A1:C1','A1:D1'),expected),/layout/);
 // Reproduce the former greedy match: it swallows the row boundary after a self-closing F7.
 const broken=before.replace(/<c\b(?=[^>]*\br="F7")[^>]*(?:\/>|>[\s\S]*?<\/c>)/u,'<c r="F7" s="1" t="inlineStr"><is><t>TEST</t></is></c>');
 assert.throws(()=>assertWorksheetPatchIntegrity(before,broken,expected),/misplaced|row|verification/);
});

test('unsupported worksheet structure fails through the real worker without publishing any file',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'expert-excel-verification-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const tools=new FileTools(fileToolConfig(root,{enabled:true,tools:['excel_patch_template'],workerImage:''}));const session=randomUUID();
 const source=await template(original=>original.replace('<row r="7"','<row'));
 const file=await tools.store.upload(session,'unsupported.xlsx',[source]);
 let published=false;
 await assert.rejects(tools.execute(session,'excel_patch_template',{sourcePath:file.path,outputPath:'bad.xlsx',operations:[set('F7','TEST')]},undefined,'verification-run',undefined,()=>{published=true;}),/Unsafe worksheet XML/);
 assert.equal(published,false);assert.equal((await tools.store.list(session)).filter(f=>f.direction==='outputs').length,0);
 const opened=await tools.store.open(session,file.id);assert.deepEqual(await opened.handle.readFile(),source);await opened.handle.close();
 assert.deepEqual(await fs.readdir(path.join(tools.store.directory(session),'work')),[]);
});
