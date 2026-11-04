import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const hash=b=>createHash('sha256').update(b).digest('hex');
const json=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
const scripts=['build-ckd-catalog-v3','normalize-ckd-inputs-v3','resolve-ckd-reference-processes-v3','resolve-ckd-transplant-reference-processes-v3','create-ckd-sop-v3'];
function walk(root){if(!fs.existsSync(root))return [];const files=[];for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isSymbolicLink())throw new Error(`Symlink not supported: ${p}`);if(e.isDirectory())files.push(...walk(p));else if(e.isFile())files.push(p);}return files;}
function atomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
/** Offline relocation of live CKD metadata only. Archives, Library, reports and observations remain byte-identical. */
export function planMigration({root,fromRoot}){
 root=fs.realpathSync(root);fromRoot=path.resolve(fromRoot);if(root===fromRoot)throw new Error('Source and destination must differ.');
 const data=path.join(root,'.data'),ckd=path.join(data,'ckd'),runs=path.join(ckd,'runs'),library=path.join(ckd,'library/ckd-library-v2');
 if(!fs.statSync(library).isDirectory())throw new Error('Default Library is missing.');
 const oldLibrary=path.join(fromRoot,'.data/ckd/library/ckd-library-v2');
 const relocate=s=>s===fromRoot?root:s.startsWith(fromRoot+'/')?root+s.slice(fromRoot.length):s;
 const changes=new Map(),moves=[],hashes=new Map(),runStates=[];
 const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
 const save=(file,value)=>{const bytes=Buffer.isBuffer(value)?value:json(value),before=fs.existsSync(file)?fs.readFileSync(file):null;if(before?.equals(bytes))return;changes.set(file,{file,before,after:bytes});};
 const transform=x=>{if(typeof x==='string')return hashes.get(x)??relocate(x);if(Array.isArray(x))return x.map(transform);if(x&&typeof x==='object'){const out={};for(const [k,v]of Object.entries(x)){const name=relocate(k);if(Object.hasOwn(out,name))throw new Error('Relocated key collision.');out[name]=transform(v);}return out;}return x;};
 const locked=walk(ckd).filter(f=>/\/(?:run|job|calibration)\.lock\/owner\.json$/u.test(f)||f.endsWith('.pi-operation.lock/owner.json'));
 if(locked.length)throw new Error('Copied locks exist; quiesce source and inspect locks before migration.');
 if(fs.existsSync(path.join(path.dirname(library),'.ckd-library-v2.pi-pending.json')))throw new Error('Interrupted Library write must be settled before relocation.');
 const directories=fs.existsSync(runs)?fs.readdirSync(runs).filter(id=>/^[0-9a-f-]{36}$/u.test(id)&&fs.existsSync(path.join(runs,id,'state.json'))).map(id=>path.join(runs,id)):[];
 // Validate original snapshots and artifact checksums before changing any metadata.
 for(const dir of directories){
  const state=read(path.join(dir,'state.json'));if(state.id!==path.basename(dir))throw new Error('Task identity mismatch.');
  if(![path.join(fromRoot,'.data/ckd/runs'),runs].includes(state.workspaceRoot)||![oldLibrary,library].includes(state.libraryPath))throw new Error(`Unexpected task roots: ${state.id}`);
  runStates.push(state);
  const catalogFile=path.join(dir,'ckd-catalog-v3.json');
  if(fs.existsSync(catalogFile)){
   const c=read(catalogFile),{generatedAt,catalogHash,...content}=c;if(hash(JSON.stringify(content))!==catalogHash)throw new Error(`Catalog checksum mismatch: ${state.id}`);
   const source=transform(c.source),next={...c,source};const {generatedAt:g,catalogHash:h,...newContent}=next;next.catalogHash=hash(JSON.stringify(newContent));hashes.set(catalogHash,next.catalogHash);if(JSON.stringify(source)!==JSON.stringify(c.source))save(catalogFile,next);
  }
  for(const receiptFile of walk(path.join(dir,'scripts')).filter(f=>path.basename(f)==='result.json')){
   const receipt=read(receiptFile);if(!receipt.result||!receipt.hashes)throw new Error('Invalid script receipt.');
   for(const [name,expected]of Object.entries(receipt.hashes)){const file=path.resolve(runs,relocate(name));if(!inside(dir,file)||hash(fs.readFileSync(file))!==expected)throw new Error(`Artifact checksum mismatch: ${state.id}/${name}`);}
  }
 }
 for(const dir of directories){
  for(const file of walk(dir)){
   const relative=path.relative(dir,file);if(relative==='ckd-catalog-v3.json')continue;
   if(relative==='state.json'||/^scripts\/[^/]+\/(?:input|output|result)\.json$/u.test(relative)){
    const original=read(file),next=transform(original);
    if(relative.endsWith('/result.json'))for(const name of Object.keys(next.hashes)){const target=path.resolve(runs,name);next.hashes[name]=hash(changes.get(target)?.after??fs.readFileSync(target));}
    if(JSON.stringify(next)!==JSON.stringify(original))save(file,next);
   }else if(relative.startsWith('sessions/')&&file.endsWith('.jsonl')){
    const original=fs.readFileSync(file,'utf8'),lines=original.split('\n');let changed=false;
    // Preserve transcript entries, IDs, prompts and historical tool calls verbatim.
    for(let i=0;i<lines.length;i++)if(lines[i].trim()){const entry=JSON.parse(lines[i]);if(entry.type==='session'&&typeof entry.cwd==='string'&&relocate(entry.cwd)!==entry.cwd){entry.cwd=relocate(entry.cwd);lines[i]=JSON.stringify(entry);changed=true;}}
    if(changed)save(file,Buffer.from(lines.join('\n')));
   }
  }
  const state=runStates.find(s=>s.id===path.basename(dir));
  for(const file of walk(path.join(dir,'scripts')).filter(f=>path.basename(f)==='input.json')){
   const old=read(file),cache=path.dirname(file),oldKey=path.basename(cache),step=old.workflow.stepId;
   const script=scripts.find(script=>hash(JSON.stringify({id:step,script,values:old.inputs,assets:state.scriptHashes}))===oldKey);
   if(!script)throw new Error(`Unknown script cache identity: ${state.id}/${oldKey}`);
   const next=JSON.parse((changes.get(file)?.after??fs.readFileSync(file)).toString()),newKey=hash(JSON.stringify({id:step,script,values:next.inputs,assets:state.scriptHashes}));
   if(oldKey!==newKey){const destination=path.join(path.dirname(cache),newKey);if(fs.existsSync(destination))throw new Error('Relocated script cache already exists.');moves.push({from:cache,to:destination});}
  }
 }
 for(const base of ['library-jobs','image-prewarm'])for(const file of walk(path.join(ckd,base)).filter(f=>/^[^/]+\/state\.json$/u.test(path.relative(path.join(ckd,base),f)))){
  const original=read(file),next=transform(original);delete next.ownerPid;if(next.status==='running')next.status='interrupted';if(JSON.stringify(original)!==JSON.stringify(next))save(file,next);
 }
 // The per-Library registry key is the real absolute path hash, not a content hash.
 const oldRegistry=path.join(ckd,'library-cache',hash(oldLibrary)),newRegistry=path.join(ckd,'library-cache',hash(library));
 for(const old of walk(oldRegistry)){const dest=path.join(newRegistry,path.relative(oldRegistry,old));if(fs.existsSync(dest))continue;const original=fs.readFileSync(old);save(dest,old.endsWith('.json')?json(transform(JSON.parse(original.toString()))):original);}
 const env=path.join(root,'.env');if(fs.existsSync(env)){
  const original=fs.readFileSync(env,'utf8');let changed=false;
  const next=original.split('\n').map(line=>{const m=/^(CKD_DATA_DIR|CKD_LIBRARY|AGENT_DATA_DIR|AGENT_CWD)\s*=\s*(["']?)([^\r\n]*?)\2\s*$/u.exec(line);if(!m)return line;const value=relocate(m[3]);if(value===m[3])return line;changed=true;return m[1]+'='+JSON.stringify(value);}).join('\n');if(changed)save(env,Buffer.from(next));
 }
 const protectedFiles=new Map();
 for(const base of ['library','image-quality','image-quality-failures','image-calibration','library-cache/photos','library-cache/translations'])for(const file of walk(path.join(ckd,base)))protectedFiles.set(file,hash(fs.readFileSync(file)));
 for(const dir of directories)for(const file of walk(path.join(dir,'outputs')))protectedFiles.set(file,hash(fs.readFileSync(file)));
 for(const file of changes.keys())if(protectedFiles.has(file))throw new Error('Refusing to rewrite protected business data.');
 return {root,fromRoot,changes:[...changes.values()],moves,protectedFiles,runCount:directories.length,registryEntries:fs.existsSync(path.join(oldRegistry,'managed-translations.json'))?Object.keys(read(path.join(oldRegistry,'managed-translations.json'))).length:0};
}
export function applyMigration(plan,{reportDir,afterWrite}={}){
 if(!reportDir)throw new Error('A report/backup directory outside the project is required.');reportDir=path.resolve(reportDir);if(inside(plan.root,reportDir))throw new Error('Keep migration backup outside the deployment.');fs.mkdirSync(reportDir,{recursive:true,mode:0o700});
 if(fs.existsSync(path.join(reportDir,'migration.json')))throw new Error('Use a fresh report directory.');
 const manifest={version:1,fromRoot:plan.fromRoot,root:plan.root,createdAt:new Date().toISOString(),status:'prepared',runCount:plan.runCount,registryEntries:plan.registryEntries,protectedFiles:plan.protectedFiles.size,changes:plan.changes.map(c=>({file:path.relative(plan.root,c.file),before:c.before?hash(c.before):null,after:hash(c.after)})),moves:plan.moves.map(m=>({from:path.relative(plan.root,m.from),to:path.relative(plan.root,m.to)}))};
 for(const c of plan.changes){const now=fs.existsSync(c.file)?fs.readFileSync(c.file):null;if(now===null?c.before!==null:c.before===null||!now.equals(c.before))throw new Error('Source changed since migration plan.');if(c.before)atomic(path.join(reportDir,'before',path.relative(plan.root,c.file)),c.before);}
 atomic(path.join(reportDir,'migration.json'),json(manifest));const written=[],moved=[];
 try{
  for(const c of plan.changes){atomic(c.file,c.after);written.push(c);afterWrite?.(c);}
  for(const m of plan.moves){fs.renameSync(m.from,m.to);moved.push(m);}
  for(const [file,expected]of plan.protectedFiles)if(hash(fs.readFileSync(file))!==expected)throw new Error('Protected business data changed.');
  manifest.status='completed';atomic(path.join(reportDir,'migration.json'),json(manifest));return manifest;
 }catch(error){for(const m of moved.reverse())fs.renameSync(m.to,m.from);for(const c of written.reverse()){if(c.before)atomic(c.file,c.before);else fs.rmSync(c.file);}manifest.status='rolled_back';manifest.error=error.message;atomic(path.join(reportDir,'migration.json'),json(manifest));throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{root:{type:'string'},from:{type:'string'},apply:{type:'boolean'},backup:{type:'string'}}});
 if(!values.root||!values.from)throw new Error('Usage: node deploy/migrate-data.mjs --root DEST --from OLD_ROOT [--apply --backup OUTSIDE_DIR]');
 const plan=planMigration({root:values.root,fromRoot:values.from});
 const result=values.apply?applyMigration(plan,{reportDir:values.backup}):{status:'dry_run',runCount:plan.runCount,registryEntries:plan.registryEntries,changedFiles:plan.changes.length,movedCaches:plan.moves.length,protectedFiles:plan.protectedFiles.size};console.log(JSON.stringify(result,null,2));
}
