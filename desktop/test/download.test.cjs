const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { BackendClient } = require('../backend.cjs');
const id = '11111111-1111-4111-8111-111111111111';
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const header = { 'content-type': mime, 'content-disposition': "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.xlsx" };
async function fixture(t, handler, timeouts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-download-'));
  const seen = [], timers = new Set();
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    if (req.url.endsWith('/login')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: 'test-token', account: '111' })); return; }
    if (req.method === 'HEAD') { res.writeHead(200, { ...header, 'content-length': 100 }); res.end(); return; }
    handler(req, res, later);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  // Tiny request deadlines below exercise the operation, not fixture login.
  const client = new BackendClient('http://127.0.0.1:' + server.address().port, { timeouts: { ...timeouts, request: 60000 } });
  await client.login({ account: '111', password: '222' });
  if (timeouts.request !== undefined) client.timeouts.request = timeouts.request;
  return { root, client, seen, destination: path.join(root, 'test.xlsx') };
}
function chunkStream(res, later, { chunks = 12, delay = 25, size = 8192, end = true } = {}) {
  res.writeHead(200, { ...header, 'content-length': chunks * size });
  let i = 0;
  const write = () => { if (res.destroyed) return; const bytes = Buffer.alloc(size, 7); if (!i) bytes.set([0x50, 0x4b, 3, 4]); res.write(bytes); if (++i < chunks) later(write, delay); else if (end) res.end(); };
  write();
}
test('download uses one lightweight HEAD, streams beyond ordinary request deadline and reports progress', async t => {
  const f = await fixture(t, (req, res, later) => chunkStream(res, later), { request: 1000, idle: 500, total: 3000 });
  const file = await f.client.artifact(id, 0), updates = [];
  assert.equal(file.name, '测试.xlsx');
  await f.client.saveArtifact(id, 0, f.destination, { file, onProgress: value => updates.push(value) });
  assert.equal(fs.statSync(f.destination).size, 12 * 8192);
  assert.equal(f.seen.filter(s => s.startsWith('HEAD ')).length, 1);
  assert.equal(f.seen.some(s => s === 'GET /api/client/runs/' + id), false);
  assert.equal(updates.at(-1).state, 'completed'); assert.equal(updates.at(-1).received, 12 * 8192);
  assert.equal(updates.at(-1).total, 12 * 8192);
  assert.ok(updates.some(s => s.state === 'validating'));
});
test('64 MiB download preserves byte hash and bounded streaming progress', async t => {
  const size = 64 * 1048576, chunk = Buffer.alloc(65536, 9); chunk.set([0x50, 0x4b, 3, 4]);
  const expected = createHash('sha256'); for (let i = 0; i < size / chunk.length; i++) expected.update(chunk);
  const f = await fixture(t, async (req, res) => {
    res.writeHead(200, { ...header, 'content-length': size });
    for (let i = 0; i < size / chunk.length; i++) { if (res.destroyed) return; if (!res.write(chunk)) await once(res, 'drain'); }
    res.end();
  });
  let progress;
  await f.client.saveArtifact(id, 0, f.destination, { onProgress: value => { progress = value; } });
  const actual = createHash('sha256'); for await (const bytes of fs.createReadStream(f.destination)) actual.update(bytes);
  assert.equal(actual.digest('hex'), expected.digest('hex')); assert.equal(progress.received, size);
  assert.deepEqual(fs.readdirSync(f.root), ['test.xlsx']);
});
test('idle timeout and absolute deadline are distinct, preserve destination and clean partial files', async t => {
  for (const kind of ['idle', 'total']) await t.test(kind, async sub => {
    const f = await fixture(sub, (req, res, later) => {
      if (kind === 'idle') { res.writeHead(200, { ...header, 'content-length': 100 }); res.write(Buffer.from([0x50, 0x4b, 3, 4])); }
      else chunkStream(res, later, { chunks: 100, delay: 25 });
    }, { idle: kind === 'idle' ? 120 : 500, total: kind === 'total' ? 220 : 2000 });
    fs.writeFileSync(f.destination, 'original');
    await assert.rejects(f.client.saveArtifact(id, 0, f.destination), e => e.code === 'download_timeout' && e.message.includes(kind === 'idle' ? '没有收到数据' : '最长等待'));
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original'); assert.deepEqual(fs.readdirSync(f.root), ['test.xlsx']);
  });
});
test('premature socket close reports interrupted download without overwriting destination', async t => {
  const f = await fixture(t, (req, res, later) => { res.writeHead(200, { ...header, 'content-length': 100000 }); res.write(Buffer.from([0x50, 0x4b, 3, 4])); later(() => res.destroy(), 40); });
  fs.writeFileSync(f.destination, 'original');
  await assert.rejects(f.client.saveArtifact(id, 0, f.destination), e => e.code === 'download_interrupted');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original'); assert.deepEqual(fs.readdirSync(f.root), ['test.xlsx']);
});
test('session cancellation stops an active stream and cleans its partial file', async t => {
  const f = await fixture(t, (req, res, later) => chunkStream(res, later, { chunks: 100, delay: 20 }));
  await assert.rejects(f.client.saveArtifact(id, 0, f.destination, { onProgress: value => { if (value.received) f.client.cancelDownloads(); } }), e => e.code === 'download_cancelled');
  assert.deepEqual(fs.readdirSync(f.root), []);
});
test('ordinary response timeout is not reported as server offline; HTTP errors retain status', async t => {
  const f = await fixture(t, (req, res, later) => { if (req.url.endsWith('/status')) { res.writeHead(502, { 'content-type': 'text/html' }); res.end('Bad gateway'); } else later(() => res.end('{}'), 300); }, { request: 100 });
  await assert.rejects(f.client.get(id), e => e.code === 'timeout');
  await assert.rejects(f.client.status(), e => e.code === 502);
});
test('invalid header, prepared route and local write failure cannot overwrite other files', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(200, header); res.end(Buffer.from([0x50, 0x4b, 3, 4])); });
  await assert.rejects(f.client.saveArtifact(id, 0, f.destination, { file: { name: 'bad.xlsx', route: 'https://evil.example/file' } }), e => e.code === 400);
  assert.equal(f.seen.some(s => s.startsWith('GET ')), false);
  await assert.rejects(f.client.saveArtifact(id, 0, path.join(f.root, 'missing', 'a.xlsx')), e => e.code === 'download_save');
  assert.deepEqual(fs.readdirSync(f.root), []);
});
