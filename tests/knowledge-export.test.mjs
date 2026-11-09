import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {ExportAccess, exportTokens} from '../dist/knowledge-export/access.js';
import {KnowledgeSnapshots} from '../dist/knowledge-export/snapshot.js';
import {knowledgeLock} from '../dist/knowledge-sync/core.js';
import {createWebServer} from '../dist/web/server.js';
import {FILE_TOOL_NAMES} from '../dist/file-tools/config.js';

const TOKEN_A = 'reader-a-' + 'a'.repeat(48);
const TOKEN_B = 'reader-b-' + 'b'.repeat(48);
const BRIDGE_TOKEN = 'PRIVATE_BRIDGE_TOKEN'.padEnd(48,'x');
const READERS = [{id:'alice',token:TOKEN_A}, {id:'bob',token:TOKEN_B}];
const ROUTE = '/api/knowledge/export';
const MAIN = 'memory/urovo-product-expert/MEMORY.md';
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function put(root, relative, text) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, text);
  return file;
}

async function fixture(t) {
  const debug = path.resolve('.data/debug');
  await fs.mkdir(debug, {recursive:true});
  const root = await fs.mkdtemp(path.join(debug, 'knowledge-export-'));
  const dataDir = path.join(root, '.data');
  const business = {
    'urovo-product-expert/SKILL.md':'PRODUCT SKILL',
    'urovo-product-expert/SYNC_PROMPT.md':'MAINTENANCE PROMPT',
    'urovo-product-expert/产品库/设备.MD':'正式资料 — 产品参数',
    'ums-expert/SKILL.md':'UMS SKILL',
    'ums-expert/references/guide.md':'UMS GUIDE',
    [MAIN]:'BUSINESS MAIN MEMORY',
  };
  const privateFiles = {
    'sessions/private.jsonl':'PRIVATE SESSION',
    'files/private/inputs/upload.jpg':'PRIVATE ATTACHMENT',
    'memory/urovo-product-expert/MEMORY_EXTRA.md':'PRIVATE EXTRA MEMORY',
    'web-auth/private.json':'PRIVATE COOKIE',
    'wecom-auth/key.json':'PRIVATE WECOM AUTH',
    'web-agent-settings.json':JSON.stringify({effort:'low',fileTools:{tools:Object.fromEntries(FILE_TOOL_NAMES.map(name=>[name,false]))}}),
    'logs/sftp_sync/run.json':'PRIVATE LOG',
    'knowledge-sync/transactions/old.json':'{"state":"committed","created":"2099-01-01T00:00:00Z","changes":[],"private":"PRIVATE TRANSACTION"}',
    'maintenance-backups/private.md':'PRIVATE BACKUP',
    'urovo-product-expert/newly_added/incoming.md':'PRIVATE INBOX',
    'urovo-product-expert/.hidden/secret.md':'PRIVATE HIDDEN FILE',
    'urovo-product-expert/MEMORY.md':'PRIVATE LEGACY MEMORY',
    'urovo-product-expert/nested/MEMORY_EXTRA.md':'PRIVATE MISPLACED EXTRA',
    'ums-expert/MEMORY.md':'PRIVATE LEGACY UMS MEMORY',
    'ums-expert/references/binary.dat':'PRIVATE NON-MARKDOWN',
  };
  for (const [relative, text] of Object.entries({...business, ...privateFiles})) await put(dataDir, relative, text);
  await put(root, '.env', 'API_KEY=PRIVATE_MODEL_KEY\nADMIN_PASSWORD=PRIVATE_PASSWORD\n');
  let app;
  let base;
  t.after(async () => { await app?.close(); await fs.rm(root, {recursive:true, force:true}); });
  const start = async (tokens = READERS, extra = {}) => {
    await app?.close();
    app = undefined;
    app = await createWebServer({
      cwd:root, dataDir, resourcesDir:path.resolve('resources'),
      model:{apiKey:'',baseUrl:'',modelId:''}, admin:{account:'local-admin',password:'local-password'},
      fileTools:{enabled:false}, bridgeToken:BRIDGE_TOKEN,
      mcp:{enabled:true,apiKey:'PRIVATE_MCP_TOKEN'},
      knowledgeExport:{tokens}, ...extra,
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const request = (route = ROUTE, token = TOKEN_A, init = {}) => fetch(base + route, {
    ...init, redirect:'manual', headers:{...(token ? {Authorization:`Bearer ${token}`} : {}), ...init.headers},
  });
  const raw = (route, headers, method = 'GET') => new Promise((resolve,reject) => {
    const request = httpRequest(base + route, {headers,method}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    request.on('error',reject); request.end();
  });
  return {root,dataDir,business,privateFiles,start,request,raw, get base(){return base;}, get server(){return app.server;}};
}

test('export credentials are opt-in, dedicated, validated and do not leak malformed secrets', () => {
  assert.deepEqual(exportTokens({}), []);
  assert.equal(new ExportAccess([]).configured, false);
  const access = new ExportAccess(READERS);
  assert.equal(access.authenticated(`Bearer ${TOKEN_A}`), true);
  assert.equal(access.authenticated(`bearer ${TOKEN_B}`), true);
  for (const header of [undefined, TOKEN_A, `Basic ${TOKEN_A}`, 'Bearer wrong', `Bearer ${TOKEN_A} extra`]) {
    assert.equal(access.authenticated(header), false);
  }
  for (const readers of [[{id:'a',token:'short'}], [READERS[0],READERS[0]],
    [{...READERS[0],extra:'unexpected'}], [{id:'b',token:TOKEN_A},READERS[0]]]) {
    assert.throws(() => new ExportAccess(readers));
  }
  assert.throws(() => exportTokens({KNOWLEDGE_EXPORT_TOKENS:'[PRIVATE_SECRET'}), error => !error.message.includes('PRIVATE_SECRET'));
});

test('HTTP export returns only allowed business files with matching per-file and archive hashes', async t => {
  const f = await fixture(t); await f.start();
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.equal(response.headers.get('x-knowledge-sha256'), sha256(bytes));
  assert.equal(response.headers.get('etag'), `"${sha256(bytes)}"`);
  const zip = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files).sort(), ['manifest.json',...Object.keys(f.business)].sort());
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.totalFiles, Object.keys(f.business).length);
  assert.equal(manifest.version, sha256(JSON.stringify(manifest.files)));
  assert.equal(response.headers.get('x-knowledge-version'), manifest.version);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="knowledge-[a-f0-9]{16}\.zip"$/);
  let total = 0;
  for (const file of manifest.files) {
    const content = await zip.file(file.path).async('nodebuffer');
    assert.equal(content.toString(), f.business[file.path]);
    assert.equal(content.length, file.bytes);
    assert.equal(sha256(content), file.sha256);
    total += content.length;
  }
  assert.equal(total, manifest.totalBytes);
  assert.ok(!JSON.stringify(manifest).includes(f.root));
  for (const [relative,text] of Object.entries(f.privateFiles)) assert.equal(await fs.readFile(path.join(f.dataDir,relative),'utf8'), text);
  assert.equal(await fs.readFile(path.join(f.root,'.env'),'utf8'), 'API_KEY=PRIVATE_MODEL_KEY\nADMIN_PASSWORD=PRIVATE_PASSWORD\n');
});

test('authorization precedes export reads and admin, Bridge, MCP credentials cannot download', async t => {
  const f = await fixture(t); await f.start();
  // If credentials were checked after reading, this would become a source-data error.
  await fs.rm(path.join(f.dataDir,'urovo-product-expert/SKILL.md'));
  for (const token of [null,'wrong',BRIDGE_TOKEN,'PRIVATE_MCP_TOKEN']) {
    const response = await f.request(ROUTE,token);
    assert.equal(response.status,401);
    assert.match(response.headers.get('www-authenticate'),/knowledge-export/);
    assert.ok(!(await response.text()).includes('PRIVATE_'));
  }
  const status = await f.request('/api/auth/status',null);
  const csrf = (await status.json()).token;
  const login = await f.request('/api/auth/login',null,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':csrf},body:JSON.stringify({account:'local-admin',password:'local-password'})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request(ROUTE,null,{headers:{Cookie:cookie}})).status,401);
  assert.equal((await f.request('/api/sessions')).status,401);
  assert.equal((await f.request('/api/wecom/status')).status,401);
  assert.equal((await f.request('/mcp')).status,401);
});

test('export is disabled by default and supports per-reader revocation after restart', async t => {
  const f = await fixture(t); await f.start([]);
  assert.equal((await f.request()).status,404);
  await f.start();
  assert.equal((await f.request(ROUTE,TOKEN_A)).status,200);
  assert.equal((await f.request(ROUTE,TOKEN_B)).status,200);
  await f.start([READERS[1]]);
  assert.equal((await f.request(ROUTE,TOKEN_A)).status,401);
  assert.equal((await f.request(ROUTE,TOKEN_B)).status,200);
});

test('GET-only route rejects arbitrary paths, query tokens, cross-site requests and duplicate credentials', async t => {
  const f = await fixture(t); await f.start(READERS,{publicUrl:'https://knowledge.example.test'});
  for (const method of ['POST','PUT','DELETE','HEAD','OPTIONS']) {
    const response = await f.request(ROUTE,TOKEN_A,{method});
    assert.equal(response.status,405);
    assert.equal(response.headers.get('allow'),'GET');
  }
  for (const query of ['?path=../../.env','?token='+TOKEN_A,'?file=sessions/private.jsonl']) {
    assert.equal((await f.request(ROUTE+query)).status,400);
  }
  assert.equal((await f.request(ROUTE+'?token='+TOKEN_A,null)).status,401);
  assert.equal((await f.request(ROUTE,TOKEN_A,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await f.raw(ROUTE,{Host:'evil.example',Authorization:`Bearer ${TOKEN_A}`})).status,403);
  const duplicate = await f.raw(ROUTE,['Host',new URL(f.base).host,'Authorization',`Bearer ${TOKEN_A}`,'Authorization',`Bearer ${TOKEN_B}`]);
  assert.equal(duplicate.status,401);
  const publicHost = await f.raw(ROUTE,{Host:'knowledge.example.test',Origin:'https://knowledge.example.test',Authorization:`Bearer ${TOKEN_A}`});
  assert.equal(publicHost.status,200);
  assert.equal(publicHost.headers['access-control-allow-origin'],undefined);
});

test('unchanged exports reuse the archive and ETag, while edits and deletions invalidate it', async t => {
  const f = await fixture(t); await f.start();
  const first = await f.request();
  const etag = first.headers.get('etag');
  const bytes = Buffer.from(await first.arrayBuffer());
  const same = await f.request(ROUTE,TOKEN_B);
  assert.equal(same.headers.get('etag'),etag);
  assert.deepEqual(Buffer.from(await same.arrayBuffer()),bytes);
  assert.equal((await f.request(ROUTE,TOKEN_A,{headers:{'If-None-Match':etag}})).status,304);
  assert.equal((await f.request(ROUTE,null,{headers:{'If-None-Match':etag}})).status,401);
  const release = await knowledgeLock(path.join(f.dataDir,'urovo-product-expert')).write();
  try {
    await fs.rm(path.join(f.dataDir,'urovo-product-expert/产品库/设备.MD'));
    await put(f.dataDir,'urovo-product-expert/new.md','NEW PRODUCT');
    await put(f.dataDir,MAIN,'UPDATED BUSINESS MAIN MEMORY');
  } finally { release(); }
  const updated = await f.request(ROUTE,TOKEN_A,{headers:{'If-None-Match':etag}});
  assert.equal(updated.status,200);
  assert.notEqual(updated.headers.get('etag'),etag);
  const zip = await JSZip.loadAsync(await updated.arrayBuffer());
  assert.equal(zip.file('urovo-product-expert/产品库/设备.MD'),null);
  assert.equal(await zip.file('urovo-product-expert/new.md').async('string'),'NEW PRODUCT');
  assert.equal(await zip.file(MAIN).async('string'),'UPDATED BUSINESS MAIN MEMORY');
});

test('snapshot waits for publication and concurrent clients share one coherent version', async t => {
  const f = await fixture(t);
  const snapshots = new KnowledgeSnapshots(f.dataDir);
  const release = await knowledgeLock(path.join(f.dataDir,'urovo-product-expert')).write();
  let settled = false;
  const pending = snapshots.get().then(value => {settled=true;return value;});
  try {
    await put(f.dataDir,'urovo-product-expert/产品库/设备.MD','PUBLISHED PRODUCT');
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(settled,false);
    await put(f.dataDir,MAIN,'PUBLISHED MAIN MEMORY');
  } finally {release();}
  const [snapshot,second,third] = await Promise.all([pending,snapshots.get(),snapshots.get()]);
  assert.strictEqual(snapshot.bytes,second.bytes);
  assert.strictEqual(snapshot.bytes,third.bytes);
  const zip = await JSZip.loadAsync(snapshot.bytes);
  assert.equal(await zip.file('urovo-product-expert/产品库/设备.MD').async('string'),'PUBLISHED PRODUCT');
  assert.equal(await zip.file(MAIN).async('string'),'PUBLISHED MAIN MEMORY');
});

test('a fifth download is rejected while the first four wait for a consistent publication', {timeout:10000}, async t => {
  const f = await fixture(t); await f.start();
  const release = await knowledgeLock(path.join(f.dataDir,'urovo-product-expert')).write();
  let received = 0;
  let allReceived;
  const waiting = new Promise(resolve => {allReceived=resolve;});
  const observe = req => {if (req.url===ROUTE && ++received===4) allReceived();};
  f.server.on('request',observe);
  const pending = Array.from({length:4},()=>f.request());
  try {
    await waiting;
    const excess = await f.request();
    assert.equal(excess.status,429);
    assert.equal(excess.headers.get('retry-after'),'5');
  } finally {f.server.off('request',observe);release();}
  for (const response of await Promise.all(pending)) {
    assert.equal(response.status,200);
    await response.arrayBuffer();
  }
  assert.equal((await f.request()).status,200);
});

test('an out-of-process change during collection rejects the candidate without serving stale cache', async t => {
  const f = await fixture(t);
  const snapshots = new KnowledgeSnapshots(f.dataDir);
  await snapshots.get();
  await put(f.dataDir,'urovo-product-expert/new.md','NEW FILE');
  const read = snapshots.read.bind(snapshots);
  let changed = false;
  snapshots.read = async source => {
    const bytes = await read(source);
    if (!changed) {
      changed = true;
      await put(f.dataDir,MAIN,'EXTERNAL EDIT DURING COLLECTION');
    }
    return bytes;
  };
  await assert.rejects(snapshots.get(),error=>[409,503].includes(error.status));
  const recovered = await snapshots.get();
  const zip = await JSZip.loadAsync(recovered.bytes);
  assert.equal(await zip.file(MAIN).async('string'),'EXTERNAL EDIT DURING COLLECTION');
});

test('symlinks and hard links fail closed, including after a valid archive was cached', async t => {
  const f = await fixture(t);
  const snapshots = new KnowledgeSnapshots(f.dataDir);
  await snapshots.get();
  const file = path.join(f.dataDir,'urovo-product-expert/产品库/设备.MD');
  await fs.rm(file); await fs.symlink(path.join(f.root,'.env'),file);
  await assert.rejects(snapshots.get(),error => error.status===503 && !error.message.includes(f.root));
  await fs.rm(file); await fs.link(path.join(f.root,'.env'),file);
  await assert.rejects(snapshots.get(),error => error.status===503 && !error.message.includes('PRIVATE_'));
});

test('main memory is required and UMS remains optional', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.dataDir,'ums-expert'),{recursive:true});
  const snapshots = new KnowledgeSnapshots(f.dataDir);
  const snapshot = await snapshots.get();
  assert.ok(snapshot.manifest.files.every(file=>!file.path.startsWith('ums-expert/')));
  await fs.rm(path.join(f.dataDir,MAIN));
  await assert.rejects(snapshots.get(),error=>error.status===503);
});

test('oversized source files fail before allocation or compression', async t => {
  const f = await fixture(t);
  const file = await put(f.dataDir,'urovo-product-expert/large.md','');
  await fs.truncate(file,33*1024*1024);
  await assert.rejects(new KnowledgeSnapshots(f.dataDir).get(),error=>error.status===413);
});

test('total snapshot size is bounded even when each individual source file is allowed', async t => {
  const f = await fixture(t);
  for (const name of ['a','b','c']) {
    const file = await put(f.dataDir,`urovo-product-expert/${name}.md`,'');
    await fs.truncate(file,23*1024*1024);
  }
  await assert.rejects(new KnowledgeSnapshots(f.dataDir).get(),error=>error.status===413);
});

test('compression deadline rejects safely and the next request can build a fresh snapshot', async t => {
  const f = await fixture(t);
  const snapshots = new KnowledgeSnapshots(f.dataDir);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timeoutMock = t.mock.method(AbortSignal,'timeout',ms=>ms===30000 ? controller.signal : timeout(ms));
  const generate = JSZip.prototype.generateInternalStream;
  const zipMock = t.mock.method(JSZip.prototype,'generateInternalStream',function(options) {
    const stream = generate.call(this,options);
    queueMicrotask(()=>controller.abort());
    return stream;
  });
  await assert.rejects(snapshots.get(),error=>error.status===503);
  zipMock.mock.restore(); timeoutMock.mock.restore();
  assert.ok((await snapshots.get()).bytes.length > 0);
});

test('server reads export readers from its own .env without exposing them in normal status', async t => {
  const f = await fixture(t);
  await put(f.root,'.env',`KNOWLEDGE_EXPORT_TOKENS='${JSON.stringify(READERS)}'\n`);
  const previous = process.env.KNOWLEDGE_EXPORT_TOKENS;
  delete process.env.KNOWLEDGE_EXPORT_TOKENS;
  try { await f.start(undefined,{knowledgeExport:undefined}); }
  finally { if(previous===undefined) delete process.env.KNOWLEDGE_EXPORT_TOKENS; else process.env.KNOWLEDGE_EXPORT_TOKENS=previous; }
  assert.equal((await f.request()).status,200);
  const status = await f.request('/api/auth/status',null);
  const text = await status.text();
  assert.ok(!text.includes(TOKEN_A)); assert.ok(!text.includes(TOKEN_B));
});
