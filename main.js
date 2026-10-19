const { app, BrowserWindow, dialog, ipcMain, shell, protocol, crashReporter, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const util = require('util');

// keep minidumps locally and note every process crash in <userData>\crash.log, so a vanished window can be diagnosed
crashReporter.start({ uploadToServer: false });
const crashLog = (what) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), `${new Date().toISOString()} ${what}\n`); } catch {}
};
app.on('child-process-gone', (_e, d) => crashLog(`${d.type} process gone: ${d.reason} (exit ${d.exitCode})${d.name ? ' ' + d.name : ''}`));
app.on('render-process-gone', (_e, _wc, d) => crashLog(`renderer gone: ${d.reason} (exit ${d.exitCode})`));
process.on('uncaughtException', (e) => { crashLog(`main exception: ${e && e.stack || e}`); });
process.on('unhandledRejection', (e) => { crashLog(`main rejection: ${e && e.stack || e}`); });
app.on('before-quit', () => crashLog('app quitting'));
process.on('exit', (c) => crashLog(`app exit (code ${c})`));

// project files reopen their video/data straight from disk: streamed to <video> through vfile://, read in ranges over IPC
protocol.registerSchemesAsPrivileged([{ scheme: 'vfile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

let mainWin = null;

// small frameless loading box shown while the main window loads
function createSplash() {
  const s = new BrowserWindow({
    width: 625, height: 348, frame: false, resizable: false, movable: true, show: false, center: true,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#000000', title: '360Sync',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  s.once('ready-to-show', () => s.show());
  s.loadFile(path.join(__dirname, 'src', 'splash.html'));
  return s;
}

function createWindow() {
  const splash = createSplash();
  // load the main window once the splash is on screen, so the splash appears straight away
  let started = false;
  const go = () => { if (!started) { started = true; createMainWindow(splash, Date.now()); } };
  splash.once('show', go);
  setTimeout(go, 3000);
}

function createMainWindow(splash, shown) {
  const win = (mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#111317',
    title: '360Sync',
    icon: path.join(__dirname, 'src', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  }));
  win.on('closed', () => { crashLog('main window closed'); abortExports(); if (mainWin === win) mainWin = null; });
  win.on('unresponsive', () => crashLog('window not responding'));
  win.on('responsive', () => crashLog('window responding again'));
  win.webContents.on('did-start-navigation', (_e, _u, inPlace, isMain) => { if (isMain && !inPlace) abortExports(); });
  win.webContents.on('render-process-gone', async (_e, d) => {
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    abortExports();
    const r = await dialog.showMessageBox(win, {
      type: 'error', title: '360Sync', buttons: ['Reload', 'Close'],
      message: 'The 360Sync window crashed',
      detail: `Reason: ${d.reason}. Save often; if this keeps happening during export, try a lower export resolution.`,
    });
    if (win.isDestroyed()) return;
    if (r.response === 0) win.reload(); else win.close();
  });
  let revealed = false;
  const reveal = async () => {
    if (revealed) return;
    revealed = true;
    // keep the splash up long enough to be seen, then fill the bar and swap
    await new Promise((r) => setTimeout(r, Math.max(0, 1500 - (Date.now() - shown))));
    if (!splash.isDestroyed()) await splash.webContents.executeJavaScript('window.finish && window.finish()').catch(() => {});
    if (!win.isDestroyed()) { win.show(); win.focus(); }
    if (!splash.isDestroyed()) splash.destroy();
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 15000); // never get stuck behind the splash
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

// ---- export file writing (positioned writes, the MP4 muxer seeks back to patch headers) ----
const files = new Map();
let nextId = 1;
// paths the user chose in the export dialog; only these (and their numbered lap clips) can be written or revealed
const exportTargets = new Set();
const exported = new Set();
const canExport = (file) => {
  if (typeof file !== 'string' || !/\.mp4$/i.test(file)) return false;
  const f = path.resolve(file);
  if (exportTargets.has(f)) return true;
  for (const t of exportTargets) {
    const stem = t.replace(/\.mp4$/i, '');
    if (path.dirname(f) === path.dirname(t) && f.startsWith(stem) && /^\d{2,3}\.mp4$/i.test(f.slice(stem.length))) return true;
  }
  return false;
};
ipcMain.handle('export:save-dialog', async (e, name) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: 'Export video',
    defaultPath: path.join(app.getPath('videos'), name || 'export.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (r.canceled || !r.filePath) return null;
  exportTargets.add(path.resolve(r.filePath));
  return r.filePath;
});
ipcMain.handle('export:open', (_e, file) => {
  if (!canExport(file)) throw new Error('export path not chosen in the save dialog');
  const id = nextId++;
  // an export is "idle" to Windows (no input), so stop it sleeping mid-render; sleep powers down USB/Thunderbolt drives
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  files.set(id, { fd: fs.openSync(file, 'w'), file, inflight: new Set(), bytes: 0, logged: 0, blocker });
  exported.add(path.resolve(file));
  crashLog(`export started: ${file}`);
  return id;
});
const writeAt = util.promisify(fs.write);
// written off the main thread, so a slow or stalling drive can't freeze the whole app
ipcMain.handle('export:write', async (_e, id, pos, data) => {
  const f = files.get(id);
  if (!f) throw new Error('file not open');
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const job = (async () => {
    let off = 0;
    while (off < b.length) off += (await writeAt(f.fd, b, off, b.length - off, pos + off)).bytesWritten;
  })();
  f.inflight.add(job);
  try { await job; } finally { f.inflight.delete(job); }
  f.bytes += b.length;
  if (f.bytes - f.logged >= 1 << 28) { f.logged = f.bytes; crashLog(`export progress: ${(f.bytes / 2 ** 30).toFixed(2)} GB written`); }
});
const closeExport = async (id, remove) => {
  const f = files.get(id);
  if (!f) return;
  files.delete(id);
  if (powerSaveBlocker.isStarted(f.blocker)) powerSaveBlocker.stop(f.blocker);
  await Promise.allSettled([...f.inflight]);
  await util.promisify(fs.close)(f.fd).catch(() => {});
  crashLog(`export ${remove ? 'aborted' : 'finished'}: ${f.file} (${(f.bytes / 2 ** 30).toFixed(2)} GB)`);
  if (remove) await fs.promises.rm(f.file, { force: true }).catch(() => {});
};
// while exporting, note every 10 s that the app is alive, with memory per process, so a sudden death can be traced
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now(), gap = now - lastBeat;
  lastBeat = now;
  if (!files.size) return;
  const mem = app.getAppMetrics().map((m) => `${m.type}:${Math.round((m.memory.privateBytes || m.memory.workingSetSize) / 1024)}MB`).join(' ');
  const written = [...files.values()].map((f) => `${(f.bytes / 2 ** 30).toFixed(2)}GB/${f.inflight.size}q`).join(' ');
  crashLog(`alive: ${written} | ${mem}${gap > 15000 ? ` | main thread was blocked ${Math.round(gap / 1000)} s` : ''}`);
}, 10000).unref();
ipcMain.handle('export:close', (_e, id, remove) => closeExport(id, remove));
// a window closed mid-export: close and delete its partial files
const abortExports = () => { for (const id of [...files.keys()]) closeExport(id, true).catch(() => {}); };
ipcMain.handle('export:reveal', (_e, file) => { if (typeof file === 'string' && exported.has(path.resolve(file))) shell.showItemInFolder(file); });

// ---- small text files (overlay templates) ----
ipcMain.handle('text:save', async (e, name, filterName, ext, text) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(text), 'utf8');
  return r.filePath;
});
ipcMain.handle('app:info', () => ({ version: require('./package.json').version, electron: process.versions.electron, chrome: process.versions.chrome }));

// ---- projects ----
// only files the user picked (dialogs, drops, project files) can be read back
const allowed = new Set();
const allow = (p) => { allowed.add(path.resolve(p)); return path.resolve(p); };
const isAllowed = (p) => typeof p === 'string' && allowed.has(path.resolve(p));
const PROJECT_FILTER = [{ name: '360Sync project', extensions: ['360sync'] }];
const info = (p) => {
  try { const s = fs.statSync(p); return s.isFile() ? { path: allow(p), name: path.basename(p), size: s.size } : null; } catch { return null; }
};
// project files the user picked, dropped or opened with the app
const projects = new Set();
const allowProject = (p) => { projects.add(path.resolve(p)); return p; };
const projectOK = (p) => typeof p === 'string' && (projects.has(path.resolve(p)) || isAllowed(p));

ipcMain.handle('file:allow', (_e, p) => (p ? info(p) : null));
const MAX_READ = 64 * 1024 * 1024;
ipcMain.handle('file:read', (_e, p, pos, len) => {
  if (!isAllowed(p)) throw new Error('file not available');
  if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(len) || pos < 0 || len < 0) throw new Error('bad read range');
  len = Math.min(len, MAX_READ);
  return readRetry(p, pos, len);
});
// external / USB drives can hiccup or briefly drop out: keep retrying for a while before giving up
async function readRetry(p, pos, len) {
  const until = Date.now() + 20000;
  for (let wait = 250; ; wait = Math.min(wait * 2, 2000)) {
    try {
      const fh = await fs.promises.open(p, 'r');
      try {
        const b = Buffer.alloc(len);
        let n = 0;
        while (n < len) { const { bytesRead } = await fh.read(b, n, len - n, pos + n); if (!bytesRead) break; n += bytesRead; }
        return new Uint8Array(b.buffer, b.byteOffset, n);
      } finally { await fh.close().catch(() => {}); }
    } catch (e) {
      if (Date.now() + wait > until) {
        const drive = path.parse(p).root;
        throw new Error(`lost access to ${path.basename(p)} (${e.code || e.message}). If it's on an external drive (${drive}), check it's still connected — the drive may have disconnected or be failing`);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
ipcMain.handle('file:text', (_e, p) => {
  if (!isAllowed(p)) throw new Error('file not available');
  return fs.readFileSync(p, 'utf8');
});
ipcMain.handle('file:locate', async (e, name, kind) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const filters = kind === 'video'
    ? [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'insv', 'lrv'] }, { name: 'All files', extensions: ['*'] }]
    : [{ name: 'Telemetry', extensions: ['csv', 'txt', 'tsv', 'dat'] }, { name: 'All files', extensions: ['*'] }];
  const r = await dialog.showOpenDialog(win, { title: `Find ${name}`, properties: ['openFile'], filters });
  return r.canceled || !r.filePaths[0] ? null : info(r.filePaths[0]);
});

ipcMain.handle('project:open-dialog', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: 'Open project', properties: ['openFile'], filters: PROJECT_FILTER });
  return r.canceled || !r.filePaths[0] ? null : allowProject(r.filePaths[0]);
});
ipcMain.handle('project:save-dialog', async (e, name) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { title: 'Save project', defaultPath: path.join(app.getPath('documents'), name || 'project.360sync'), filters: PROJECT_FILTER });
  return r.canceled || !r.filePath ? null : allowProject(r.filePath);
});
// media paths are stored absolute and relative to the project, so a folder can be moved or shared
ipcMain.handle('project:write', (_e, file, proj) => {
  if (!/\.360sync$/i.test(file) || !projectOK(file)) throw new Error('not a project file');
  const dir = path.dirname(file);
  for (const k of ['video', 'data']) {
    const m = proj[k];
    if (m && m.path) m.rel = path.relative(dir, m.path).split(path.sep).join('/');
  }
  fs.writeFileSync(file, JSON.stringify(proj, null, 2));
  return true;
});
ipcMain.handle('project:read', (_e, file) => {
  if (!/\.360sync$/i.test(file) || !projectOK(file)) throw new Error('not a 360Sync project');
  allowProject(file);
  const proj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!proj || proj.app !== '360Sync') throw new Error('not a 360Sync project');
  const dir = path.dirname(file);
  const found = {};
  for (const k of ['video', 'data']) {
    const m = proj[k];
    if (!m) continue;
    found[k] = (m.path && info(m.path)) || (m.rel && info(path.resolve(dir, m.rel))) || (m.name && info(path.join(dir, m.name))) || null;
  }
  return { proj, found, name: path.basename(file) };
});

// a project passed on the command line (Open with… / double-click once associated)
const projectArg = (argv) => argv.slice(1).find((a) => /\.360sync$/i.test(a) && fs.existsSync(a)) || null;
let pendingProject = projectArg(process.argv);
if (pendingProject) allowProject(pendingProject);
ipcMain.handle('project:initial', () => { const p = pendingProject; pendingProject = null; return p; });

async function serveFile(req) {
  const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
  if (!isAllowed(p)) return new Response('Not found', { status: 404 });
  let size;
  try { size = (await fs.promises.stat(p)).size; } catch { return new Response('Not found', { status: 404 }); }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0, end = size - 1;
  if (m) {
    if (m[1] === '') start = Math.max(0, size - +m[2]);
    else { start = +m[1]; if (m[2]) end = Math.min(end, +m[2]); }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const ext = path.extname(p).toLowerCase();
  const type = ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), { status: m ? 206 : 200, headers });
}

if (process.platform === 'win32') app.setAppUserModelId('com.360sync.app');
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const w = mainWin, p = projectArg(argv);
  if (p) allowProject(p);
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore(); w.focus();
    if (p) w.webContents.send('project:open', p);
  } else if (p) pendingProject = p; // still starting up: the window asks for it once loaded
});

app.whenReady().then(() => {
  crashLog(`app started v${require('./package.json').version} pid ${process.pid}`);
  protocol.handle('vfile', serveFile);
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) powerMonitor.on(ev, () => crashLog(`system ${ev}`));
  createWindow();
  app.on('activate', () => {
    if (!mainWin) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
