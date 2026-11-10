const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BackendClient, ClientError } = require('./backend.cjs');
const { SavedFiles } = require('./saved-files.cjs');
const metadata = require('./package.json');
// A build profile embeds its endpoint; the development/local build keeps config.json.
const backendUrl = metadata.ckdBackendUrl ?? require('./config.json').backendUrl;
// 主界面也从服务器加载：改 desktop/ui 只需要更新服务器，不用重新发包。
const remoteUiUrl = new URL('/client/', backendUrl).href;
const productName = metadata.productName ?? 'CKD SOP';
const backend = new BackendClient(backendUrl), saved = new SavedFiles();
let window;
let sessionGeneration = 0;
const saving = new Set();
protocol.registerSchemesAsPrivileged([{ scheme: 'ckd', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function register(name, action) {
  ipcMain.handle('ckd:' + name, async (event, ...args) => {
    const generation = sessionGeneration, changesSession = ['login', 'logout', 'changePassword'].includes(name);
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new ClientError(403, '请求来源无效。');
      const frameUrl = event.senderFrame.url;
      if (!(frameUrl.startsWith('ckd://ui/') || frameUrl.startsWith(remoteUiUrl))) throw new ClientError(403, '请求来源无效。');
      const value = await action(...args);
      if (!changesSession && generation !== sessionGeneration) throw new ClientError('session_changed', '登录已改变，请重试当前操作。');
      return { ok: true, value };
    } catch (error) { if (!changesSession && generation !== sessionGeneration) return { ok: false, code: 'session_changed', error: '登录已改变，请重试当前操作。' }; if (error.code === 401) { sessionGeneration++; saved.clear(); backend.cancelDownloads(); closeEditor(); } return { ok: false, code: error.code || 'error', error: error.message || '操作失败，请重试。' }; }
  });
}
ipcMain.handle('ckd:version', async event => {
  try {
    if (!window || event.sender !== window.webContents) throw new ClientError(403, '请求来源无效。');
    const response = await fetch(new URL('/api/client/version', backendUrl));
    if (!response.ok) throw new ClientError(response.status, '版本服务暂不可用。');
    return { ok: true, value: { current: app.getVersion(), ...await response.json() } };
  } catch (error) { return { ok: false, code: error.code || 'error', error: error.message || '版本检查失败，请稍后重试。' }; }
});
ipcMain.handle('ckd:openExternal', async (event, url) => {
  if (!window || event.sender !== window.webContents) throw new ClientError(403, '请求来源无效。');
  if (typeof url !== 'string' || !/^https:\/\//u.test(url)) throw new ClientError(400, '链接无效。');
  await shell.openExternal(url);
  return { ok: true };
});
for (const name of ['status', 'list', 'deleted', 'trash', 'restore', 'get', 'start', 'answer', 'resume', 'cancel', 'image', 'crop', 'generate', 'me']) register(name, (...args) => backend[name](...args));
register('changePassword', async input => { const result = await backend.changePassword(input); sessionGeneration++; saved.clear(); closeEditor(); return result; });
register('login', input => { sessionGeneration++; saved.clear(); closeEditor(); return backend.login(input); });
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
 * 保留正式库录入功能；服务端使用新用户体系校验每次请求。
 * 令牌由主进程注入当前窗口的请求头，页面本身看不到它。
 */
let editorWindow, editorSession;
function ensureEditorSession() {
  if (editorSession) return editorSession;
  editorSession = session.fromPartition('editor');
  editorSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  editorSession.setPermissionCheckHandler(() => false);
  // 只给后端这一个源注入令牌；主窗口走 ckd:// 协议，不受影响。
  editorSession.webRequest.onBeforeSendHeaders({ urls: [new URL(backendUrl).origin + '/*'] }, (details, callback) => {
    if (!editorWindow || editorWindow.isDestroyed() || details.webContentsId !== editorWindow.webContents.id) { callback({ cancel: true }); return; }
    const token = backend.token;
    if (token) details.requestHeaders.Authorization = 'Bearer ' + token;
    callback({ requestHeaders: details.requestHeaders });
  });
  return editorSession;
}
function closeEditor() { const previous = editorWindow; editorWindow = undefined; if (previous && !previous.isDestroyed()) previous.destroy(); }
register('openEditor', async () => {
  const generation = sessionGeneration;
  if (!backend.token) throw new ClientError(401, '请先登录。');
  await backend.status(); // Also rejects first-password and revoked sessions.
  if (generation !== sessionGeneration) throw new ClientError('session_changed', '登录已改变，请重新打开录入窗口。');
  if (editorWindow && !editorWindow.isDestroyed()) { editorWindow.focus(); return { ok: true }; }
  ensureEditorSession();
  editorWindow = new BrowserWindow({ width: 1320, height: 900, minWidth: 1040, minHeight: 660, title: productName + ' · 逐工序录入', backgroundColor: '#101b17', autoHideMenuBar: true,
    webPreferences: { partition: 'editor', preload: path.join(__dirname, 'editor-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  editorWindow.setMenu(null);
  editorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editorWindow.webContents.on('will-navigate', event => event.preventDefault());
  const openedEditor = editorWindow;
  editorWindow.on('closed', () => { if (editorWindow === openedEditor) editorWindow = undefined; });
  void editorWindow.loadURL(new URL('/admin/editor', backendUrl).href);
  return { ok: true };
});

// 录入窗口的「返回工作台」：主页面是独立窗口，关闭录入窗并把主窗切回前台。
ipcMain.on('ckd-editor:close', event => {
  if (!editorWindow || editorWindow.isDestroyed() || event.sender !== editorWindow.webContents) return;
  closeEditor();
});
ipcMain.on('ckd-editor:focus-main', event => {
  if (!editorWindow || editorWindow.isDestroyed() || event.sender !== editorWindow.webContents) return;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function createWindow() {
  window = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 640, title: `${productName} v${app.getVersion()}`, backgroundColor: '#101b17', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.setMenu(null);
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  window.on('closed', () => { sessionGeneration++; window = undefined; saved.clear(); closeEditor(); void backend.logout().catch(() => {}); });
  // 优先用服务器下发的页面；HTTP 错误（如 502）也回退到本地打包版本。
  void (async () => {
    const win = window;
    if (!win) return;
    try {
      const response = await net.fetch(remoteUiUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await win.loadURL(remoteUiUrl);
    } catch {
      if (!win.isDestroyed()) await win.loadURL('ckd://ui/index.html').catch(() => {});
    }
  })();
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
