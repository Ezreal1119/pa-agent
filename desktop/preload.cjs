const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ckd', Object.freeze({
  login: input => ipcRenderer.invoke('ckd:login', input),
  logout: () => ipcRenderer.invoke('ckd:logout'),
  status: () => ipcRenderer.invoke('ckd:status'),
  list: () => ipcRenderer.invoke('ckd:list'),
  deleted: () => ipcRenderer.invoke('ckd:deleted'),
  trash: id => ipcRenderer.invoke('ckd:trash',id),
  restore: id => ipcRenderer.invoke('ckd:restore',id),
  get: id => ipcRenderer.invoke('ckd:get', id),
  start: input => ipcRenderer.invoke('ckd:start', input),
  answer: (id, questionId, text) => ipcRenderer.invoke('ckd:answer', id, questionId, text),
  image: (id, imageId, original) => ipcRenderer.invoke('ckd:image', id, imageId, original),
  crop: (id, imageId, reviewId, revision, rect) => ipcRenderer.invoke('ckd:crop', id, imageId, reviewId, revision, rect),
  generate: (id, reviewId, revision) => ipcRenderer.invoke('ckd:generate', id, reviewId, revision),
  resume: id => ipcRenderer.invoke('ckd:resume', id),
  cancel: id => ipcRenderer.invoke('ckd:cancel', id),
  save: (id, index) => ipcRenderer.invoke('ckd:save', id, index),
  onDownloadProgress: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected callback');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ckd:download-progress', listener);
    return () => ipcRenderer.removeListener('ckd:download-progress', listener);
  },
  open: handle => ipcRenderer.invoke('ckd:open', handle),
  show: handle => ipcRenderer.invoke('ckd:show', handle)
}));
