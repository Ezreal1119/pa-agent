const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { BackendClient } = require('../backend.cjs');
const { SavedFiles } = require('../saved-files.cjs');
const id='11111111-1111-4111-8111-111111111111';
async function fixture(t){
 let download=Buffer.from([0x50,0x4b,3,4,0,0]),type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',errorStatus=0,seen=[];
 const server=http.createServer(async(req,res)=>{
  const data=req.method==='POST'?JSON.parse(await Array.fromAsync(req).then(chunks=>Buffer.concat(chunks).toString())):undefined;seen.push({url:req.url,headers:req.headers,data});
  if(req.url==='/api/client/login'){res.setHeader('content-type','application/json');res.end(JSON.stringify({token:'a'.repeat(64),account:'111'}));return;}
  if(errorStatus){res.writeHead(errorStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:'登录已失效'}));return;}
  if(req.url.endsWith('/artifacts/0')){res.writeHead(200,{'content-type':type,'content-length':download.length,'content-disposition':"attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.xlsx"});res.end(download);return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/'+id)?{run:{id,result:{artifacts:[{name:'测试.xlsx',url:'https://evil.example/file'}]}}}:{ok:true}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ckd-desktop-'));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 return {client:new BackendClient(url),root,seen,fail:()=>{errorStatus=401;},download:(bytes,mime=type)=>{download=bytes;type=mime;}};
}
test('transport holds token in main only, uses fixed routes/no Origin and resets expired sessions',async t=>{
 const f=await fixture(t);await assert.rejects(f.client.list(),e=>e.code===401);const logged=await f.client.login({account:'111',password:'222'});assert.equal(logged.token,undefined);await f.client.status();assert.equal(f.seen[1].headers.authorization,'Bearer '+'a'.repeat(64));assert.equal(f.seen[1].headers.origin,undefined);
 assert.throws(()=>f.client.get('../library'),e=>e.code===400);await assert.rejects(f.client.artifact(id,-1),e=>e.code===400);f.fail();await assert.rejects(f.client.list(),e=>e.code===401);const calls=f.seen.length;await assert.rejects(f.client.list(),e=>e.code===401);assert.equal(f.seen.length,calls);
});
test('downloads ignore server URLs, validate binary/MIME and preserve existing destination on failure',async t=>{
 const f=await fixture(t);await f.client.login({account:'111',password:'222'});const destination=path.join(f.root,'测试.xlsx');await f.client.saveArtifact(id,0,destination);assert.equal(fs.readFileSync(destination).subarray(0,2).toString(),'PK');assert.ok(f.seen.some(r=>r.url==='/api/client/runs/'+id+'/artifacts/0'));
 f.download(Buffer.from('bad'));await assert.rejects(f.client.saveArtifact(id,0,destination),e=>e.code==='download_invalid');assert.equal(fs.readFileSync(destination).subarray(0,2).toString(),'PK');assert.deepEqual(fs.readdirSync(f.root),['测试.xlsx']);
 f.download(Buffer.from('{}'),'application/json');await assert.rejects(f.client.saveArtifact(id,0,destination),/无效文件/u);assert.deepEqual(fs.readdirSync(f.root),['测试.xlsx']);
});
test('only registered saved files can open; symlink replacement, removal and logout invalidate handles',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ckd-saved-'));try{const file=path.join(root,'a.json'),outside=path.join(root,'b.json');fs.writeFileSync(file,'{}');fs.writeFileSync(outside,'{}');const saved=new SavedFiles(),handle=saved.add(file);assert.equal(saved.get(handle),file);assert.throws(()=>saved.get(outside),/不存在/u);fs.unlinkSync(file);fs.symlinkSync(outside,file);assert.throws(()=>saved.get(handle),/不存在/u);fs.unlinkSync(file);fs.writeFileSync(file,'{}');const second=saved.add(file);saved.clear();assert.throws(()=>saved.get(second),/不存在/u);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
