const { contextBridge, ipcRenderer } = require('electron');

// 录入窗口专用桥：只允许关闭自己、把主窗口切回前台，不暴露任何后端能力。
contextBridge.exposeInMainWorld('ckdEditor', Object.freeze({
  close: () => ipcRenderer.send('ckd-editor:close'),
  focusMain: () => ipcRenderer.send('ckd-editor:focus-main'),
}));
