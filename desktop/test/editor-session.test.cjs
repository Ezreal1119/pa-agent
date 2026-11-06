const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { ClientError } = require('../backend.cjs');

// Exercise main-process IPC/window lifecycle without opening real windows.
async function fixture() {
  const handlers = new Map(), windows = []; let backend, beforeHeaders;
  class FakeWindow {
    constructor() {
      this.events = new Map(); this.destroyed = false;
      this.webContents = { id: windows.length + 1, mainFrame: { url: 'ckd://ui/index.html' }, on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    on(name, callback) { this.events.set(name, callback); }
    setMenu() {} focus() {} isMinimized() { return false; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.events.get('closed')?.(); }
    loadURL(url) { this.url = url; return Promise.resolve(); }
  }
  class FakeBackend {
    constructor() { backend = this; this.token = 'old-user-token'; this.statusCode = 0; }
    async status() { if (this.gate) await this.gate; if (this.statusCode) throw new ClientError(this.statusCode, 'session rejected'); return { libraryReady: true }; }
    async login(input) { this.token = 'token-' + input.account; return { account: input.account }; }
    async logout() { this.token = undefined; return { ok: true }; }
    async changePassword() { this.token = undefined; return { ok: true }; }
    cancelDownloads() {}
  }
  const permissions = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const electron = {
    app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {}, quit() {} },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, action) => handlers.set(name, action), on: (name, action) => handlers.set(name, action) },
    session: { defaultSession: permissions, fromPartition: () => ({ ...permissions, webRequest: { onBeforeSendHeaders: (_filter, handler) => { beforeHeaders = handler; } } }) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} }, dialog: {}, shell: {}, net: {},
  };
  const main = path.resolve(__dirname, '../main.cjs');
  vm.runInNewContext(fs.readFileSync(main, 'utf8'), { URL, __dirname: path.dirname(main), require(name) {
    if (name === 'electron') return electron;
    if (name === './backend.cjs') return { BackendClient: FakeBackend, ClientError };
    if (name === './saved-files.cjs') return { SavedFiles: class { clear() {} } };
    if (name === './package.json') return { ckdBackendUrl: 'https://backend.example', productName: 'Fixture' };
    return require(name);
  } }, { filename: main });
  await new Promise(resolve => setImmediate(resolve));
  const call = (name, ...args) => handlers.get('ckd:' + name)({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, ...args);
  const headers = id => { let result; beforeHeaders({ webContentsId: id, requestHeaders: {} }, value => { result = value; }); return result; };
  return { windows, backend, call, headers };
}

test('editor opens only after business authentication and closes on login, password change and revocation', async () => {
  const f = await fixture(); f.backend.statusCode = 403;
  assert.equal(f.windows[0].url, 'https://backend.example/client/', '主界面改为从服务器加载');
  assert.equal((await f.call('openEditor')).code, 403); assert.equal(f.windows.length, 1);
  f.backend.statusCode = 0;
  assert.equal((await f.call('openEditor')).ok, true); const old = f.windows[1];
  assert.equal(old.url, 'https://backend.example/admin/editor');
  assert.equal(f.headers(old.webContents.id).requestHeaders.Authorization, 'Bearer old-user-token');
  await f.call('login', { account: 'Bob' }); assert.equal(old.destroyed, true);
  assert.equal(f.headers(old.webContents.id).cancel, true);
  await f.call('openEditor'); const current = f.windows[2];
  assert.equal(f.headers(current.webContents.id).requestHeaders.Authorization, 'Bearer token-Bob');
  assert.equal(f.headers(old.webContents.id).cancel, true);
  await f.call('changePassword', {}); assert.equal(current.destroyed, true);
  await f.call('login', { account: 'Carol' }); await f.call('openEditor'); const revoked = f.windows[3];
  f.backend.statusCode = 401; assert.equal((await f.call('status')).code, 401); assert.equal(revoked.destroyed, true);
});

test('an editor-open request waiting during an account switch cannot open a window for the new account', async () => {
  const f = await fixture(); let release;
  f.backend.gate = new Promise(resolve => { release = resolve; });
  const pending = f.call('openEditor'); await f.call('login', { account: 'Bob' }); release();
  assert.equal((await pending).code, 'session_changed'); assert.equal(f.windows.length, 1);
});
