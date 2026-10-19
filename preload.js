// Exposes a small native API to the renderer (which stays sandboxed): MP4 export writing and project files.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  saveDialog: (name) => ipcRenderer.invoke('export:save-dialog', name),
  open: (file) => ipcRenderer.invoke('export:open', file),
  write: (id, pos, data) => ipcRenderer.invoke('export:write', id, pos, data),
  close: (id, remove) => ipcRenderer.invoke('export:close', id, remove),
  reveal: (file) => ipcRenderer.invoke('export:reveal', file),
  saveText: (name, filterName, ext, text) => ipcRenderer.invoke('text:save', name, filterName, ext, text),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // a file the user opened or dropped: its path on disk (so a project can find it again), or null
  registerFile: (file) => {
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch { /* not a disk file */ }
    return p ? ipcRenderer.invoke('file:allow', p) : Promise.resolve(null);
  },
  readFile: (path, pos, len) => ipcRenderer.invoke('file:read', path, pos, len),
  readText: (path) => ipcRenderer.invoke('file:text', path),
  locateFile: (name, kind) => ipcRenderer.invoke('file:locate', name, kind),
  projectOpenDialog: () => ipcRenderer.invoke('project:open-dialog'),
  projectSaveDialog: (name) => ipcRenderer.invoke('project:save-dialog', name),
  projectWrite: (path, proj) => ipcRenderer.invoke('project:write', path, proj),
  projectRead: (path) => ipcRenderer.invoke('project:read', path),
  projectInitial: () => ipcRenderer.invoke('project:initial'),
  onProjectOpen: (cb) => ipcRenderer.on('project:open', (_e, p) => cb(p)),
});