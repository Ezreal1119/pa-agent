const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('cloud build falls back for missing, partial, stale or foreign Electron distributions', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ckd-build-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '../electron-builder.cloud.cjs'), path.join(root, 'config.cjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ build: { directories: {} } }));
  const select = require(path.join(root, 'config.cjs')).electronDist;
  const options = { platformName: process.platform, arch: process.arch, version: '44.7.0' };
  assert.equal(select(options), null);
  const dist = path.join(root, 'node_modules/electron/dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'version'), '44.7.0');
  assert.equal(select(options), null);
  const binary = path.join(dist, process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32' ? 'electron.exe' : 'electron');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'fixture');
  assert.equal(select(options), dist);
  assert.equal(select({ ...options, version: '44.8.0' }), null);
  assert.equal(select({ ...options, arch: process.arch === 'x64' ? 'arm64' : 'x64' }), null);
  assert.equal(select({ ...options, platformName: process.platform === 'win32' ? 'darwin' : 'win32' }), null);
});
