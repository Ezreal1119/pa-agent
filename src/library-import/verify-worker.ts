// Isolated structural validation only. Never renders, executes macros, or invokes a model.
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { preflightPackage } from '../file-tools/preflight.js';
import { fileToolConfig } from '../file-tools/config.js';

try {
  const [file,extension]=process.argv.slice(2);
  if(!file || !extension)throw Error('Missing validation input.');
  if(extension==='.pdf') {
    const bytes=await fs.readFile(file);
    if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')) || !bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from('%%EOF')))throw Error('Not a complete PDF document (header/EOF missing).');
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,disableFontFace:true,stopAtErrors:true});
    try{const pdf=await task.promise;if(!pdf.numPages)throw Error('Empty PDF.');for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);await page.getOperatorList();page.cleanup();}}finally{await task.destroy();}
  } else {
    const config=fileToolConfig(process.cwd(),{maxSheets:200,maxPages:500,maxCells:500000,maxExpandedBytes:256*1048576},{});
    await preflightPackage(file,extension,config);
    const zip=await JSZip.loadAsync(await fs.readFile(file),{checkCRC32:true});
    const main:Record<string,string>={'.docx':'word/document.xml','.xlsx':'xl/workbook.xml','.pptx':'ppt/presentation.xml'};
    const contentTypes:Record<string,string>={'.docx':'wordprocessingml.document.main+xml','.xlsx':'spreadsheetml.sheet.main+xml','.pptx':'presentationml.presentation.main+xml'};
    const types=await zip.file('[Content_Types].xml')?.async('string');
    if(!main[extension] || !zip.file(main[extension]!) || !types || !types.includes(contentTypes[extension]!))throw Error('Office file content does not match its extension.');
    if(Object.keys(zip.files).some(n=>/vbaProject\.bin$/i.test(n)))throw Error('Macro-enabled documents are not accepted.');
  }
} catch(e){console.error((e as Error).message.slice(0,1500));process.exitCode=1;}
