import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {decodeOfficeXml} from '../dist/file-tools/office-xml.js';
import {preflightPackage} from '../dist/file-tools/preflight.js';
import {FileTools,fileToolConfig} from '../dist/file-tools/index.js';

function utf16(xml,bigEndian=false,bom=true) {
 const data=Buffer.from(xml,'utf16le');if(bigEndian)data.swap16();
 return bom?Buffer.concat([Buffer.from(bigEndian?[0xfe,0xff]:[0xff,0xfe]),data]):data;
}
async function setup(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'office-encoding-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return {root,config:fileToolConfig(root,{enabled:true,workerImage:''})};
}
async function writePackage(root,data) {
 const zip=new JSZip();zip.file('customXml/item1.xml',data);const file=path.join(root,randomUUID()+'.docx');
 await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));return file;
}

test('Office XML decoding handles UTF-8 BOM and UTF-16 endianness/signatures without changing bytes',()=>{
 const xml='<?xml version="1.0" encoding="utf-8"?><meta>泰文 ภาษาไทย &amp; 中文</meta>';
 const variants=[Buffer.from(xml),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(xml)]),utf16(xml),utf16(xml,true),utf16(xml,false,false),utf16(xml,true,false)];
 for(const data of variants){const before=Buffer.from(data);assert.equal(decodeOfficeXml(data),xml);assert.deepEqual(data,before);}
 assert.throws(()=>decodeOfficeXml(Buffer.from([0xc3,0x28])));
 assert.throws(()=>decodeOfficeXml(Buffer.from([0xff,0xfe,0x3c])));
 assert.throws(()=>decodeOfficeXml(Buffer.from([0xff,0xfe,0,0,0x3c,0,0,0])),/UTF-32/);
});

test('UTF-16 custom metadata passes preflight, including stale XML declarations, preserving raw package',async t=>{
 const {root,config}=await setup(t);
 for(const bigEndian of [false,true]){
  const data=utf16("<?xml version='1.0' encoding='us-ascii'?><meta>ไทย</meta>",bigEndian);const file=await writePackage(root,data);const original=await fs.readFile(file);
  await preflightPackage(file,'.docx',config);assert.deepEqual(await fs.readFile(file),original);
 }
});

test('UTF-16 DOCTYPE/ENTITY and malformed XML/encoding still fail closed with the failing part named',async t=>{
 const {root,config}=await setup(t);
 for(const bigEndian of [false,true]){
  const file=await writePackage(root,utf16('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY data "forbidden">]><x>&data;</x>',bigEndian));
  await assert.rejects(preflightPackage(file,'.docx',config),/customXml\/item1.xml.*DOCTYPE\/ENTITY/);
 }
 const malformed=await writePackage(root,utf16('<?xml version="1.0"?><x><y></x>'));
 await assert.rejects(preflightPackage(malformed,'.docx',config),/customXml\/item1.xml.*line/);
 const badBytes=await writePackage(root,Buffer.from([0xc3,0x28]));
 await assert.rejects(preflightPackage(badBytes,'.docx',config),/encoding: customXml\/item1.xml/);
 const limited=await writePackage(root,utf16('<meta>'+'A'.repeat(1000)+'</meta>'));
 await assert.rejects(preflightPackage(limited,'.docx',{...config,maxExpandedBytes:100}),/expanded size/);
});

test('real Excel workers read and patch workbooks with UTF-16 metadata and exact trailing-space sheet names',async t=>{
 const {config}=await setup(t);const tools=new FileTools(config);const session=randomUUID();
 const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Spec EDC ');sheet.getCell('A1').value='ข้อกำหนด';sheet.getCell('B2').border={bottom:{style:'thin'}};sheet.getCell('C3').value='Preserve';
 const zip=await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
 const metadata=utf16("<?xml version='1.0' encoding='utf-8'?><metadata>ข้อมูล</metadata>");zip.file('customXml/item1.xml',metadata);
 const source=await zip.generateAsync({type:'nodebuffer'});const file=await tools.store.upload(session,'encoding.xlsx',[source]);
 const read=await tools.execute(session,'excel_read',{path:file.path,scope:'worksheet',sheet:'Spec EDC ',range:'A1:C3'});assert.equal(read.ok,true);assert.match(JSON.stringify(read),/ข้อกำหนด/);
 const patched=await tools.execute(session,'excel_patch_template',{sourcePath:file.path,outputPath:'patched.xlsx',operations:[{type:'setCell',sheet:'Spec EDC ',range:'B2',value:'ไทย & 中文'}]});assert.equal(patched.ok,true);
 const opened=await tools.store.open(session,patched.file.id);const output=await opened.handle.readFile();await opened.handle.close();
 const outputZip=await JSZip.loadAsync(output);assert.deepEqual(await outputZip.file('customXml/item1.xml').async('nodebuffer'),metadata);
 const result=new ExcelJS.Workbook();await result.xlsx.load(output);assert.equal(result.getWorksheet('Spec EDC ').getCell('B2').value,'ไทย & 中文');assert.equal(result.getWorksheet('Spec EDC ').getCell('C3').value,'Preserve');
 const original=await tools.store.open(session,file.id);assert.deepEqual(await original.handle.readFile(),source);await original.handle.close();
});
