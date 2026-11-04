import fs from "node:fs";
import path from "node:path";
import { atomicJson } from "./store.js";
import { sha256 } from "./scripts.js";
import { acquireDirectoryLock } from "./library-lock.js";
export interface ReviewedImageLabel{file:string;imageHash:string;filenameScore:number;score:number;comment:string}
/** Small RFC4180 reader, including quoted commas/newlines; reject malformed feedback rather than silently mislabel images. */
export function feedbackLabels(file:string){
 const text=fs.readFileSync(file,'utf8').replace(/^\ufeff/u,''),rows:string[][]=[];let row:string[]=[],cell='',quoted=false,ended=false;
 for(let i=0;i<text.length;i++){const c=text[i]!;if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;ended=true;}}else cell+=c;continue;}
 if(ended&&c!==','&&c!=='\n'&&c!=='\r')throw new Error('Invalid feedback CSV quoting.');
 if(c==='"'){if(cell||ended)throw new Error('Invalid feedback CSV quoting.');quoted=true;}else if(c===','){row.push(cell);cell='';ended=false;}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';ended=false;}else cell+=c;
 }if(quoted)throw new Error('Unclosed feedback CSV quote.');if(cell||row.length||ended){row.push(cell);rows.push(row);}
 const header=rows.shift()??[],name=header.indexOf('图片'),score=header.indexOf('需求方复评分'),note=header.indexOf('扣分原因'),previousAi=header.indexOf('AI建议分');if(name<0||score<0)throw new Error('Feedback CSV requires 图片 and 需求方复评分 columns.');
 const labels=new Map<string,{score:number;comment:string;previousAiScore?:number}>();for(const r of rows){const file=r[name]!,v=r[score]?.trim();if(!file||labels.has(file)||!v||!Number.isFinite(Number(v))||Number(v)<0||Number(v)>100)throw new Error(`Invalid/duplicate reviewed label ${file}`);const old=previousAi<0?undefined:r[previousAi]?.trim();if(old&&(!Number.isFinite(Number(old))||Number(old)<0||Number(old)>100))throw new Error(`Invalid previous AI score ${file}`);labels.set(file,{score:Number(v),comment:note<0?'':r[note]??'',...(old?{previousAiScore:Number(old)}:{})});}return labels;
}
export function importReviewedLabels(dataDir:string,csvFile:string){
 const rows=feedbackLabels(csvFile),samples=path.resolve(dataDir,'ckd/image-calibration/samples'),labels:ReviewedImageLabel[]=[];
 for(const [file,label] of rows){const full=path.resolve(samples,file);if(path.dirname(full)!==samples||fs.lstatSync(full).isSymbolicLink()||!fs.statSync(full).isFile())throw new Error(`Invalid reference ${file}`);const match=/^(\d{1,3}(?:\.\d{1,2})?)-.+\.(png|jpe?g)$/iu.exec(file);if(!match)throw new Error(`Invalid reference name ${file}`);labels.push({file,imageHash:sha256(fs.readFileSync(full)),filenameScore:Number(match[1]),score:label.score,comment:label.comment});}
 for(const label of labels)if(labels.some(other=>other.imageHash===label.imageHash&&other.score!==label.score))throw new Error('Conflicting reviewed scores for the same image Hash');
 const root=path.resolve(dataDir,'ckd/image-calibration/seven-dimensions'),release=acquireDirectoryLock(path.join(root,'calibration.lock'));
 try{const target=path.join(root,'reviewed-labels.json');if(fs.existsSync(target))fs.copyFileSync(target,path.join(root,`reviewed-labels-${Date.now()}.backup.json`));atomicJson(target,{sourceHash:sha256(fs.readFileSync(csvFile)),importedAt:new Date().toISOString(),labels});return labels;}finally{release();}
}
export function reviewedLabels(dataDir:string){const file=path.resolve(dataDir,'ckd/image-calibration/seven-dimensions/reviewed-labels.json');if(!fs.existsSync(file))return [] as ReviewedImageLabel[];const data=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(data.labels))throw new Error('Invalid reviewed labels');for(const r of data.labels){if(typeof r.file!=='string'||!/^[a-f0-9]{64}$/u.test(r.imageHash)||!Number.isFinite(r.score)||r.score<0||r.score>100||!Number.isFinite(r.filenameScore))throw new Error('Invalid reviewed label');}return data.labels as ReviewedImageLabel[];}
