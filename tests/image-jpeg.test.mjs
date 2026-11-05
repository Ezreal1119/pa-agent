import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {inspectImageHeader, validateImageStructure} from '../dist/file-tools/vendor/imageTools.js';
import {FileTools, fileToolConfig} from '../dist/file-tools/index.js';

function jpegFixture() {
  const canvas = createCanvas(96, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#1250cc';
  context.fillRect(0, 0, 96, 64);
  return canvas.toBuffer('image/jpeg');
}

function segment(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

test('complete JPEGs accept trailing transport bytes without changing the image', async () => {
  const jpeg = jpegFixture();
  const trailer = Buffer.from('347b7ad300000000da0df4cdd22a3ab5c5e2e3ff6c1f9d94', 'hex');
  assert.equal(trailer.length, 24);
  for (const extra of [Buffer.alloc(0), trailer, Buffer.from([0xff, 0xda, 0xff, 0xd9, 0xff])]) {
    const bytes = Buffer.concat([jpeg, extra]);
    const before = Buffer.from(bytes);
    assert.deepEqual(inspectImageHeader(bytes), {format:'jpeg', mimeType:'image/jpeg', width:96, height:64});
    assert.doesNotThrow(() => validateImageStructure(bytes, 'jpeg'));
    const decoded = await loadImage(bytes);
    assert.equal(decoded.width, 96);
    assert.equal(decoded.height, 64);
    assert.deepEqual(bytes, before);
  }
});

test('JPEG completeness checks ignore marker-like bytes inside metadata and stuffed scan data', () => {
  const jpeg = jpegFixture();
  const fakeMarkers = segment(0xfe, Buffer.from([0xff, 0xd9, 0xff, 0xda]));
  const withComment = Buffer.concat([jpeg.subarray(0, 2), fakeMarkers, jpeg.subarray(2)]);
  const startOfScan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(startOfScan > 2);
  for (const bytes of [
    jpeg.subarray(0, -1),
    jpeg.subarray(0, -2),
    jpeg.subarray(0, startOfScan + 3),
    withComment.subarray(0, -2),
    Buffer.concat([jpeg.subarray(0, 2), fakeMarkers, jpeg.subarray(2, startOfScan), Buffer.from([0xff, 0xd9])]),
    Buffer.concat([jpeg.subarray(0, -2), Buffer.from([0xff, 0x00, 0xd9])]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0xff, 0xda, 0xff, 0xd9]),
  ]) {
    assert.throws(() => validateImageStructure(bytes, 'jpeg'), /corrupt or incomplete/);
  }
  assert.doesNotThrow(() => validateImageStructure(withComment, 'jpeg'));
});

test('JPEG marker traversal supports progressive scans, stuffing, fill and restart markers', () => {
  // A structural fixture; actual pixel decoding remains the native decoder's job.
  const frame = segment(0xc2, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
  const scan = segment(0xda, Buffer.from([1, 1, 0, 0, 0, 0]));
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]), frame, scan,
    Buffer.from([0x23, 0xff, 0x00, 0xd9, 0xff, 0xff, 0xd0, 0x45]),
    segment(0xc4, Buffer.from([0])), scan,
    Buffer.from([0x67, 0xff, 0xd9, 0x12, 0x34]),
  ]);
  assert.doesNotThrow(() => validateImageStructure(bytes, 'jpeg'));
  assert.throws(() => validateImageStructure(bytes.subarray(0, -4), 'jpeg'), /corrupt or incomplete/);
});

test('JPEG trailer passes both worker checks and reaches vision; damaged inputs do not', {timeout:30000}, async t => {
  const debug = path.resolve('.data/debug');
  await fs.mkdir(debug, {recursive:true});
  const root = await fs.mkdtemp(path.join(debug, 'jpeg-regression-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({choices:[{message:{content:'Readable label image.'}}]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const config = fileToolConfig(root, {
    enabled:true, workerImage:'',
    vision:{baseUrl:`http://127.0.0.1:${server.address().port}`, apiKey:'TEST_ONLY', model:'mock-vision'},
  });
  const tools = new FileTools(config);
  const session = randomUUID();
  const jpeg = jpegFixture();
  const original = Buffer.concat([jpeg, Buffer.alloc(24, 0x34)]);
  const file = await tools.store.upload(session, 'label.jpg', [original]);
  const result = await tools.execute(session, 'image_read', {path:file.path});
  assert.equal(result.ok, true);
  assert.equal(result.metrics.visionCalls, 1);
  assert.equal(result.processedImages[0].width, 96);
  assert.equal(requests.length, 1);
  const dataUrl = requests[0].messages[1].content.find(block => block.type === 'image_url').image_url.url;
  assert.deepEqual(Buffer.from(dataUrl.split(',')[1], 'base64'), original);
  const opened = await tools.store.open(session, file.id);
  try { assert.deepEqual(await opened.handle.readFile(), original); }
  finally { await opened.handle.close(); }

  const truncated = await tools.store.upload(session, 'truncated.jpg', [jpeg.subarray(0, -2)]);
  await assert.rejects(tools.execute(session, 'image_read', {path:truncated.path}), /corrupt or incomplete/);
  const broken = Buffer.from(original);
  const quantization = broken.indexOf(Buffer.from([0xff, 0xdb]));
  assert.ok(quantization > 0);
  broken[quantization + 4] = 0xf0; // Invalid quantization precision; marker lengths stay intact.
  const corrupt = await tools.store.upload(session, 'corrupt.jpg', [broken]);
  // Native decoder failures may return an unavailable result or terminate the
  // isolated worker; both must fail before sending the image to the provider.
  let rejected;
  try { rejected = await tools.execute(session, 'image_read', {path:corrupt.path}); }
  catch (error) { assert.match(error.message, /File processor exited without a result/); }
  if (rejected) {
    assert.equal(rejected.ok, false);
    assert.equal(rejected.metrics.visionCalls, 0);
  }
  assert.equal(requests.length, 1);
});
