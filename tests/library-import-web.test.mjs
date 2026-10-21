// Administrator boundary fixtures; not executed in this implementation round.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {createWebServer} from '../dist/web/server.js';

test('library import administrator API preserves Cookie, Origin and CSRF boundaries and never exposes credentials',async t=>{
 const saved=Object.fromEntries(Object.keys(process.env).filter(k=>k.startsWith('LIBRARY_IMPORT_')).map(k=>[k,process.env[k]]));
 for(const k of Object.keys(saved))delete process.env[k];t.after(()=>Object.assign(process.env,saved));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'library-import-web-'));let app;
 t.after(async()=>{await app?.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(root,'.env'),'LIBRARY_IMPORT_BASE_URL=https://library.example\nLIBRARY_IMPORT_ADMIN_PASSWORD=private-library-password\n');
 const bridge='bridge-fixture-token-12345678901234567890';
 app=await createWebServer({cwd:root,dataDir:path.join(root,'.data'),resourcesDir:path.resolve('resources'),admin:{account:'admin',password:'fixture-pass'},model:{apiKey:'',baseUrl:'',modelId:''},bridgeToken:bridge,mcp:{apiKey:'mcp-fixture-private-key-123456789'}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 assert.equal((await fetch(base+'/api/library-import/status')).status,401);
 for(const key of [bridge,'mcp-fixture-private-key-123456789'])assert.equal((await fetch(base+'/api/library-import/status',{headers:{Authorization:`Bearer ${key}`}})).status,401);
 assert.equal((await fetch(base+'/api/wecom/library-import/status',{headers:{Authorization:`Bearer ${bridge}`}})).status,403);
 const token=(await(await fetch(base+'/api/auth/status')).json()).token;
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'X-Local-Token':token,'Content-Type':'application/json'},body:JSON.stringify({account:'admin',password:'fixture-pass'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,'X-Local-Token':token,'Content-Type':'application/json'};
 const state=await(await fetch(base+'/api/library-import/status',{headers})).json();assert.equal(state.configured,false);assert(state.missing.includes('API_KEY / BASE_URL / MODEL_ID'));assert(!JSON.stringify(state).includes('private-library-password'));
 assert.equal((await fetch(base+'/api/library-import/runs',{method:'POST',headers:{cookie},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/library-import/runs',{method:'POST',headers:{...headers,Origin:'https://bad.example'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/library-import/runs',{method:'POST',headers,body:'{"url":"https://127.0.0.1/"}'})).status,400);
 assert.equal((await fetch(base+'/api/library-import/runs',{method:'POST',headers,body:'{}'})).status,409);
 assert.equal((await fetch(base+'/api/status',{headers})).status,200);
 const html=await(await fetch(base+'/synchronize',{headers})).text();assert.match(html,/Library imports/);assert.match(html,/library-import-run/);assert.match(html,/SFTP imports/);
});
