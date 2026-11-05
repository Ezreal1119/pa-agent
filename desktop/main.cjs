const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BackendClient, ClientError } = require('./backend.cjs');
const { SavedFiles } = require('./saved-files.cjs');
const metadata = require('./package.json');
// A build profile embeds its endpoint; the development/local build keeps config.json.
const backendUrl = metadata.ckdBackendUrl ?? require('./config.json').backendUrl;
const productName = metadata.productName ?? 'CKD SOP';
const backend = new BackendClient(backendUrl), saved = new SavedFiles();
let window;
let sessionGeneration = 0;
const saving = new Set();
protocol.registerSchemesAsPrivileged([{ scheme: 'ckd', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function register(name, action) {
  ipcMain.handle('ckd:' + name, async (event, ...args) => {
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('ckd://ui/')) throw new ClientError(403, '请求来源无效。');
      return { ok: true, value: await action(...args) };
    } catch (error) { return { ok: false, code: error.code || 'error', error: error.message || '操作失败，请重试。' }; }
  });
}
for (const name of ['status', 'list', 'deleted', 'trash', 'restore', 'get', 'start', 'answer', 'resume', 'cancel', 'image', 'crop', 'generate']) register(name, (...args) => backend[name](...args));
register('login', input => { sessionGeneration++; saved.clear(); return backend.login(input); });
register('logout', async () => { sessionGeneration++; saved.clear(); closeEditor(); return backend.logout(); });
register('save', async (id, index) => {
  const key = id + ':' + index, generation = sessionGeneration;
  if (saving.has(key)) throw new ClientError('download_busy', '此文件正在保存，请等待完成。');
  saving.add(key);
  try {
    const file = await backend.artifact(id, index), ext = path.extname(file.name).slice(1);
    const selection = await dialog.showSaveDialog(window, { title: '保存 ' + file.name, defaultPath: path.join(app.getPath('downloads'), file.name), filters: [{ name: ext === 'xlsx' ? 'Excel 工作簿' : '评分报告', extensions: [ext] }] });
    if (selection.canceled) return { cancelled: true };
    if (generation !== sessionGeneration) throw new ClientError(401, '登录已改变，请重新保存。');
    const result = await backend.saveArtifact(id, index, selection.filePath, { file, onProgress: progress => {
      if (generation === sessionGeneration && window && !window.isDestroyed()) window.webContents.send('ckd:download-progress', { id, index, ...progress });
    } });
    if (generation !== sessionGeneration) throw new ClientError(401, '登录已改变，请重新保存。');
    return { ...result, handle: saved.add(result.path) };
  } finally { saving.delete(key); }
});
register('open', async handle => { const error = await shell.openPath(saved.get(handle)); if (error) throw new ClientError('open', error); return { ok: true }; });
register('show', handle => { shell.showItemInFolder(saved.get(handle)); return { ok: true }; });

/**
 * 逐工序录入窗口：整页加载服务器的 /admin/editor。
 * 服务端按凭证决定写入范围——带客户端 Bearer 只能写 <库根>/public（待审核区），
 * 碰不到 product_lib。令牌由主进程注入到该窗口的请求头，页面本身看不到它。
 */
let editorWindow, editorSession;
function ensureEditorSession() {
  if (editorSession) return editorSession;
  editorSession = session.fromPartition('editor');
  editorSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  editorSession.setPermissionCheckHandler(() => false);
  // 只给后端这一个源注入令牌；主窗口走 ckd:// 协议，不受影响。
  editorSession.webRequest.onBeforeSendHeaders({ urls: [new URL(backendUrl).origin + '/*'] }, (details, callback) => {
    const token = backend.token;
    if (token) details.requestHeaders.Authorization = 'Bearer ' + token;
    callback({ requestHeaders: details.requestHeaders });
  });
  return editorSession;
}
function closeEditor() { if (editorWindow && !editorWindow.isDestroyed()) editorWindow.close(); editorWindow = undefined; }
register('openEditor', () => {
  if (!backend.token) throw new ClientError(401, '请先登录。');
  if (editorWindow && !editorWindow.isDestroyed()) { editorWindow.focus(); return { ok: true }; }
  ensureEditorSession();
  editorWindow = new BrowserWindow({ width: 1320, height: 900, minWidth: 1040, minHeight: 660, title: productName + ' · 逐工序录入', backgroundColor: '#101b17', autoHideMenuBar: true,
    webPreferences: { partition: 'editor', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  editorWindow.setMenu(null);
  editorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editorWindow.webContents.on('will-navigate', event => event.preventDefault());
  editorWindow.on('closed', () => { editorWindow = undefined; });
  void editorWindow.loadURL(new URL('/admin/editor', backendUrl).href);
  return { ok: true };
});

function createWindow() {
  window = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 640, title: productName, backgroundColor: '#101b17', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.setMenu(null);
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  window.on('closed', () => { sessionGeneration++; window = undefined; saved.clear(); closeEditor(); void backend.logout().catch(() => {}); });
  window.loadURL('ckd://ui/index.html');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    protocol.handle('ckd', request => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.host !== 'ui' || !['/index.html', '/app.js', '/image-crop.js', '/style.css'].includes(url.pathname)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', url.pathname.slice(1))).href);
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
