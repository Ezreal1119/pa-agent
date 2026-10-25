import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWebServer } from '../dist/web/server.js';
import { dispatchAutoSync, autoSyncSocketPath } from '../dist/knowledge-sync/auto-sync-socket.js';
import { emptyUsage, hash } from '../dist/knowledge-sync/core.js';

test('Auto-sync settings are admin/Origin/CSRF protected and the owner-only timer dispatch produces an ordinary report',async t=>{
  const root=await fs.mkdtemp('/tmp/as-web-'),dataDir=path.join(root,'data');
  let app, saves=0;
  let state={available:true,editable:true,unit:'product-expert-auto-sync.timer',calendar:'*-*-* 07:00:00 Asia/Shanghai',enabled:false,active:false,nextRun:null,revision:'v1',schedule:{enabled:false,frequency:'daily',time:'07:00'}};
  app=await createWebServer({cwd:root,dataDir,resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'fixture-password'},bridgeToken:'fixture-bridge-token-0123456789012345',model:{apiKey:'fixture',baseUrl:'https://unused.invalid',modelId:'fixture'},
    autoSyncSchedule:{status:async()=>structuredClone(state),save:async(schedule,revision)=>{saves++;if(revision!==state.revision){const e=new Error('Timer changed elsewhere');e.status=409;throw e;}state={...state,revision:'v2',schedule,enabled:schedule.enabled};return state;}},
    sync:{converter:()=>async source=>({markdown:await fs.readFile(source,'utf8'),sourceHash:hash(await fs.readFile(source)),coverage:['Fixture'],visual:emptyUsage(),version:4}),planner:()=>async()=>({decision:{action:'review',reason:'Need decision',summary:'Held',products:[],slot:'',oldPaths:[],versionEvidence:'',authorizedException:false,reviewedPaths:[]},staged:new Map()})}});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base+'/api/sync/settings/schedule')).status,401);
  const token=(await(await fetch(base+'/api/auth/status')).json()).token;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify({account:'admin',password:'fixture-password'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(method='GET',body,extra={})=>fetch(base+'/api/sync/settings/schedule',{method,headers:{Cookie:cookie,'x-local-token':token,'content-type':'application/json',...extra},body:body?JSON.stringify(body):undefined});
  const before=await(await request()).json();assert.equal(before.enabled,false);assert.equal(before.trigger.available,true);assert.equal(before.lastRun,null);
  const body={schedule:{enabled:true,frequency:'daily',time:'08:30'},revision:'v1'};
  assert.equal((await request('PUT',body,{'x-local-token':''})).status,403);
  assert.equal((await request('PUT',body,{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await request('PUT',{...body,command:'injected'})).status,400);
  assert.equal((await request('PUT',{...body,schedule:{...body.schedule,frequency:'weekly',weekday:'Mon'}})).status,400);
  assert.equal(saves,0);assert.equal((await request('PUT',body)).status,200);assert.equal(saves,1);
  assert.equal((await fetch(base+'/api/wecom/sync/settings/schedule',{headers:{Authorization:'Bearer fixture-bridge-token-0123456789012345'}})).status,403);
  const html=await(await fetch(base+'/synchronize',{headers:{Cookie:cookie}})).text();assert.match(html,/id="auto-settings-open"/);assert.match(html,/id="auto-settings-dialog"/);
  assert.equal((await fetch(base+'/synchronize-auto-settings.js',{headers:{Cookie:cookie}})).status,200);
  const inbox=path.join(dataDir,'urovo-product-expert/newly_added');await fs.mkdir(inbox,{recursive:true});await fs.writeFile(path.join(inbox,'a.md'),'# New source');
  const dispatched=await dispatchAutoSync(autoSyncSocketPath(dataDir));assert.equal(dispatched.selected,1);
  let last;
  for(let n=0;n<100;n++){last=(await(await request()).json()).lastRun;if(last.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(last.status,'completed');assert.deepEqual(last.counts,{needs_review:1});
  const reports=await(await fetch(base+'/api/sync/jobs',{headers:{Cookie:cookie}})).json();assert.equal(reports.jobs.length,1);
  assert.equal((await dispatchAutoSync(autoSyncSocketPath(dataDir))).status,'skipped_handled');
  const cli=await promisify(execFile)(process.execPath,[path.resolve('dist/knowledge-sync/auto-sync-cli.js')],{cwd:root,env:{PATH:process.env.PATH,AGENT_DATA_DIR:dataDir}});
  assert.equal(JSON.parse(cli.stdout).status,'skipped_handled');
  assert.equal(cli.stderr,'');
  assert.equal((await fetch(base+'/api/sync/auto-run',{method:'POST',headers:{Cookie:cookie,'x-local-token':token,'content-type':'application/json'},body:'{}'})).status,404,'no network dispatch endpoint was added');
});
