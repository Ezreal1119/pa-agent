import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createWebServer} from '../dist/web/server.js';
import {WebOriginPolicy} from '../dist/web/origin.js';

const PUBLIC='https://urovo-agent.patrick-shenzhen.cn';
const ADMIN={account:'fixture-admin',password:'fixture-password'};
const BRIDGE='fixture-machine-token-'.repeat(3);
async function setup(t,publicUrl=PUBLIC,fromDisk=false){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'web-public-origin-'));
 const previous=process.env.WEB_PUBLIC_URL;
 if(fromDisk)await fs.writeFile(path.join(root,'.env'),`WEB_PUBLIC_URL=${publicUrl}\n`);
 let app;
 try{
  if(fromDisk)delete process.env.WEB_PUBLIC_URL;
  app=await createWebServer({cwd:root,dataDir:path.join(root,'.data'),resourcesDir:path.resolve('resources'),admin:ADMIN,bridgeToken:BRIDGE,...(fromDisk?{}:{publicUrl}),model:{apiKey:'',baseUrl:'',modelId:''},fileTools:{enabled:false}});
 }finally{if(previous===undefined)delete process.env.WEB_PUBLIC_URL;else process.env.WEB_PUBLIC_URL=previous;}
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const url=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const request=(route,method='GET',body,headers={})=>new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=httpRequest(url+route,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}),...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});
  });req.on('error',reject);req.end(data);
 });
 return{request};
}

test('configured HTTPS domain login works with preserved Host and retains session/CSRF protections',async t=>{
 const f=await setup(t);const host=new URL(PUBLIC).host;
 const page=await f.request('/login','GET',undefined,{Host:host});assert.equal(page.status,200);
 const bootstrap=await f.request('/api/auth/status','GET',undefined,{Host:host});assert.equal(bootstrap.status,200);const token=bootstrap.json().token;
 const headers={Host:host,Origin:PUBLIC,'Sec-Fetch-Site':'same-origin','X-Local-Token':token};
 assert.equal((await f.request('/api/status','GET',undefined,{Host:host})).status,401);
 assert.equal((await f.request('/api/auth/login','POST',ADMIN,{...headers,'X-Local-Token':''})).status,403);
 assert.equal((await f.request('/api/auth/login','POST',ADMIN,{...headers,Origin:'https://evil.example'})).status,403);
 const login=await f.request('/api/auth/login','POST',ADMIN,headers);assert.equal(login.status,200,login.text);
 const setCookie=login.headers['set-cookie'][0];assert.match(setCookie,/; Secure(?:;|$)/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);assert.match(setCookie,/Max-Age=604800/);
 const cookie=setCookie.split(';')[0];assert.equal((await f.request('/api/status','GET',undefined,{Host:host,Cookie:cookie})).status,200);
 const logout=await f.request('/api/auth/logout','POST',{}, {...headers,Cookie:cookie});assert.equal(logout.status,200);assert.match(logout.headers['set-cookie'][0],/; Secure/);
 assert.equal((await f.request('/api/status','GET',undefined,{Host:host,Cookie:cookie})).status,401);
});
test('proxy rewritten loopback Host accepts the explicit HTTPS Origin, ignores forwarded claims and keeps machine API local',async t=>{
 const f=await setup(t);
 const token=(await f.request('/api/auth/status')).json().token;
 const login=await f.request('/api/auth/login','POST',ADMIN,{Origin:PUBLIC,'Sec-Fetch-Site':'same-origin','X-Local-Token':token});assert.equal(login.status,200,login.text);assert.match(login.headers['set-cookie'][0],/; Secure/);
 const cookie=login.headers['set-cookie'][0].split(';')[0];
 assert.equal((await f.request('/api/status','GET',undefined,{Cookie:cookie,Origin:PUBLIC})).status,200);
 for(const origin of ['null','http://urovo-agent.patrick-shenzhen.cn','https://urovo-agent.patrick-shenzhen.cn.evil.example','https://sub.urovo-agent.patrick-shenzhen.cn','https://urovo-agent.patrick-shenzhen.cn:8443'])assert.equal((await f.request('/api/auth/login','POST',ADMIN,{Origin:origin,'X-Local-Token':token,'X-Forwarded-Host':new URL(PUBLIC).host,'X-Forwarded-Proto':'https'})).status,403,origin);
 assert.equal((await f.request('/api/auth/login','POST',ADMIN,{Origin:PUBLIC,'Sec-Fetch-Site':'cross-site','X-Local-Token':token})).status,403);
 assert.equal((await f.request('/api/wecom/status','GET',undefined,{Host:new URL(PUBLIC).host,Authorization:`Bearer ${BRIDGE}`})).status,403);
 assert.equal((await f.request('/api/wecom/status','GET',undefined,{Origin:PUBLIC,Authorization:`Bearer ${BRIDGE}`})).status,403);
 assert.equal((await f.request('/api/wecom/status','GET',undefined,{Authorization:`Bearer ${BRIDGE}`})).status,200);
});
test('unset public origin retains loopback-only login and rejects a forged public forwarded origin',async t=>{
 const f=await setup(t,'');const token=(await f.request('/api/auth/status')).json().token;
 assert.equal((await f.request('/login','GET',undefined,{Host:new URL(PUBLIC).host})).status,403);
 assert.equal((await f.request('/api/auth/login','POST',ADMIN,{Origin:PUBLIC,'X-Forwarded-Proto':'https','X-Forwarded-Host':new URL(PUBLIC).host,'X-Local-Token':token})).status,403);
 const login=await f.request('/api/auth/login','POST',ADMIN,{'X-Local-Token':token});assert.equal(login.status,200);assert.ok(!login.headers['set-cookie'][0].includes('; Secure'));
});
test('WEB_PUBLIC_URL loads from .env and rejects wildcard, non-HTTPS, credentials and URL paths',async t=>{
 const f=await setup(t,PUBLIC,true);assert.equal((await f.request('/login','GET',undefined,{Host:new URL(PUBLIC).host})).status,200);
 for(const value of ['*','https://*.example.com','http://example.com','https://example.com/login','https://example.com?query=1','https://example.com#fragment','https://user:password@example.com'])assert.throws(()=>new WebOriginPolicy(value),/WEB_PUBLIC_URL/);
 assert.equal(new WebOriginPolicy(PUBLIC+'/').publicUrl.origin,PUBLIC);
});
