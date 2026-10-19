import { parseTelemetry, buildSession, guessTimeCol, guessDistCol, guessSpeedCol, guessTimeUnit, fmtTime } from './telemetry.js';
import { Chart } from './chart.js';
import { Player } from './player.js';
import { InsvSource } from './insv.js';
import { initStitchPanel } from './stitchpanel.js';
import { Overlay, initOverlayPanel } from './overlay.js';
import { applySavedNames, editColumns, showOnLoad } from './coldialog.js';
import { exportVideo, exportBitrate, hevcSupported, maxFrame } from './exporter.js';
import { viewAt, keyAt, keyframesChanged } from './keyframes.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const player = new Player($('stage'), video);
const stitchPanel = initStitchPanel(player);
const overlay = new Overlay($('stage'));
const overlayPanel = initOverlayPanel(overlay);
let insv = null;         // active Insta360 source, else the <video> element is used
overlay.getAspect = () => (player.is360 ? 16 / 9 : insv ? 2 : video.videoWidth / video.videoHeight || 16 / 9);
let media = video;       // whichever of the two is active (shared <video>-like API)
const hasMedia = () => (insv ? true : !!video.getAttribute('src'));
const chart = new Chart($('chart'), { onScrub });

let raw = null;          // parsed CSV (all columns)
let session = null;      // time-normalised data used by the chart
let selected = [];       // channel indices plotted, in lane order
let videoName = '';
let videoFile = null;
let videoPath = null;    // on disk, for projects
let dataName = '';
let dataPath = null, dataFile = null;
let synced = false;
let offset = 0;          // video time (s) at which data t = 0
let frameDur = 1 / 30;
let seeking = false;
let loadingProject = false;
let projectPath = null, projectName = '';

// A file reopened from disk by path (projects). Has the parts of File the app uses: name, size, slice().arrayBuffer(), text(), plus a
// streaming URL for the <video> element.
class DiskFile {
  constructor({ path, name, size }) {
    Object.assign(this, { path, name, size });
    this.url = `vfile://f/${encodeURIComponent(path)}`;
  }
  slice(a = 0, b = this.size) {
    a = Math.max(0, a); b = Math.min(this.size, b);
    const p = this.path;
    return {
      arrayBuffer: async () => {
        const u = await window.native.readFile(p, a, Math.max(0, b - a));
        return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer;
      },
    };
  }
  text() { return window.native.readText(this.path); }
}
// where a picked/dropped file lives on disk (null if it can't be known)
async function pathOf(file) {
  if (file.path) return file.path;
  try { const i = await window.native.registerFile(file); return i ? i.path : null; } catch { return null; }
}

// ---------- toast ----------
let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 6000 : 2500);
}

function updateFiles() {
  $('files').textContent = [projectName && `📁 ${projectName}`, videoName && `🎬 ${videoName}`, dataName && `📈 ${dataName}`].filter(Boolean).join('   ');
}

// ---------- video ----------
function closeMedia() {
  if (insv) { insv.close(); insv = null; }
  stitchPanel.setEnabled(false);
  if (video.getAttribute('src')) {
    video.pause();
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
  media = video;
  videoFile = null;
  videoPath = null;
  $('btnExport').disabled = true;
  $('btnPlay').textContent = '▶';
}

// resolves once the video is ready to show (or failed), so projects can restore state after it
function openVideo(file) {
  if (/\.insv$/i.test(file.name)) return openInsv(file);
  closeMedia();
  const ready = new Promise((res) => {
    const done = () => { video.removeEventListener('loadedmetadata', done); video.removeEventListener('error', done); res(); };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('error', done);
  });
  video.src = file.url || URL.createObjectURL(file);
  video.defaultPlaybackRate = video.playbackRate = +$('speed').value;
  player.setVideo(file.name);
  videoName = file.name;
  videoFile = file;
  pathOf(file).then((p) => { if (videoFile === file) videoPath = p; });
  $('btnExport').disabled = false;
  frameDur = 1 / 30;
  lastMedia = null;
  $('videoEmpty').style.display = 'none';
  setSynced(false);
  updateFiles();
  return ready;
}

async function openInsv(file) {
  toast(`Opening ${file.name}…`);
  let src;
  try {
    src = await InsvSource.open(file);
  } catch (e) {
    toast(`Could not open ${file.name}: ${e.message}`, true);
    return;
  }
  closeMedia();
  insv = media = src;
  src.muted = video.muted;
  src.playbackRate = +$('speed').value;
  src.addEventListener('play', onPlayState);
  src.addEventListener('pause', onPlayState);
  player.setInsv(src, file.name);
  stitchPanel.setEnabled(true);
  videoName = file.name;
  videoFile = file;
  pathOf(file).then((p) => { if (videoFile === file) videoPath = p; });
  $('btnExport').disabled = false;
  frameDur = src.frameDur;
  $('videoEmpty').style.display = 'none';
  setSynced(false);
  updateFiles();
  set360(true);
  const res = src.layout === 'tracks' ? `2 × ${src.width}×${src.height}` : `${src.width}×${src.height}`;
  toast(`${src.model} · ${res} dual fisheye${src.calibrated ? '' : ' (no calibration found, using generic lens model)'}`);
  tryRestoreSync();
}

video.addEventListener('loadedmetadata', () => {
  const ar = video.videoWidth / video.videoHeight;
  const is360 = Math.abs(ar - 2) < 0.02;
  set360(is360);
  if (is360) toast('2:1 video detected — switched to 360° mode');
  tryRestoreSync();
});
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  toast('This video can’t be decoded. Try an H.264/H.265 MP4, an equirectangular 360 MP4, or an Insta360 .insv.', true);
});
function onPlayState() { $('btnPlay').textContent = media.paused ? '▶' : '⏸'; }
video.addEventListener('play', onPlayState);
video.addEventListener('pause', onPlayState);

let lastMedia = null;
function onVideoFrame(_now, meta) {
  if (insv) { video.requestVideoFrameCallback(onVideoFrame); return; }
  if (lastMedia !== null) {
    const d = meta.mediaTime - lastMedia;
    if (d > 0.004 && d < frameDur) frameDur = d;
  }
  lastMedia = meta.mediaTime;
  video.requestVideoFrameCallback(onVideoFrame);
}
if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame);

function set360(on) {
  player.set360(on);
  $('modeFlat').classList.toggle('on', !on);
  $('mode360').classList.toggle('on', on);
  $('btnLock').disabled = !on;
  $('kfBox').hidden = !on;
  renderKeyframes();
  updateLock();
}

function updateLock() {
  const b = $('btnLock'), on = player.locked;
  b.classList.toggle('on', on);
  b.textContent = on ? '🔒 Locked' : '🔓 Lock';
  $('btnResetView').disabled = !player.is360 || on;
}
player.onLockChange = updateLock;

function togglePlay() {
  if (!hasMedia()) return;
  if (media.paused) { playFromTrim(); media.play(); } else media.pause();
}

function stepVideo(sec) {
  if (!hasMedia() || !media.duration) return;
  media.pause();
  media.currentTime = Math.min(Math.max(media.currentTime + sec, 0), media.duration);
}

// ---------- data ----------
// saved: column names/units and chart choices from a project (skips the rename dialog)
async function openData(file, saved = null) {
  try {
    const text = await file.text();
    raw = parseTelemetry(text);
    applySavedNames(raw);
    if (saved) {
      if (Array.isArray(saved.names) && saved.names.length === raw.names.length) raw.names = [...saved.names];
      if (Array.isArray(saved.units) && saved.units.length === raw.units.length) raw.units = [...saved.units];
    } else if (showOnLoad()) await editColumns(raw, file.name);
    dataName = file.name;
    dataFile = file;
    dataPath = file.path || null;
    if (!file.path) pathOf(file).then((p) => { if (dataFile === file) dataPath = p; });
    populateSelectors();
    selected = defaultChannels();
    if (saved) restoreDataChoices(saved);
    rebuild();
    $('btnColumns').disabled = false;
    setSynced(false);
    updateFiles();
    if (!saved) toast(`Loaded ${raw.names.length} channels, ${raw.n.toLocaleString()} samples`);
    tryRestoreSync();
    return true;
  } catch (e) {
    toast(`Could not read ${file.name}: ${e.message}`, true);
    return false;
  }
}

function restoreDataChoices(s) {
  const n = raw.names.length;
  if (Number.isInteger(s.time) && s.time >= 0 && s.time < n) $('selTime').value = String(s.time);
  if (Number.isFinite(s.timeUnit)) $('selTimeUnit').value = String(s.timeUnit);
  if (typeof s.dist === 'string' && [...$('selDist').options].some((o) => o.value === s.dist)) $('selDist').value = s.dist;
  if (Array.isArray(s.channels)) selected = s.channels.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  if (s.xMode === 'time' || s.xMode === 'distance') $('xMode').value = s.xMode;
}

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

// the auto-detection works on the file's own column names, whatever they've been renamed to
const byOrig = () => ({ ...raw, names: raw.origNames });

function populateSelectors() {
  const selTime = $('selTime');
  const selDist = $('selDist');
  selTime.replaceChildren(...raw.names.map((n, i) => option(i, n)));
  const ti = guessTimeCol(byOrig());
  selTime.value = ti;
  $('selTimeUnit').value = String(guessTimeUnit(raw.cols[ti]));

  selDist.replaceChildren(option('', '(none)'), ...raw.names.map((n, i) => option(`c:${i}`, n)));
  const si = guessSpeedCol(byOrig());
  if (si >= 0) selDist.append(option(`v:${si}`, `Integrate ${raw.names[si]}`));
  const di = guessDistCol(byOrig());
  selDist.value = di >= 0 ? `c:${di}` : si >= 0 ? `v:${si}` : '';
}

function defaultChannels() {
  const ti = +$('selTime').value;
  const skip = new Set([ti]);
  const dv = $('selDist').value;
  if (dv.startsWith('c:')) skip.add(+dv.slice(2));
  const out = [];
  const add = (i) => { if (i >= 0 && !skip.has(i) && !out.includes(i)) out.push(i); };
  add(guessSpeedCol(byOrig()));
  for (const re of [/throttle|tps|pedal|aps|accel/i, /brake|bps|pbrake/i, /rpm|engine.?speed|nmot|n_eng/i, /gear/i, /steer/i]) {
    add(raw.origNames.findIndex((n, i) => re.test(n) && !skip.has(i) && !out.includes(i)));
  }
  for (let i = 0; out.length < 3 && i < raw.names.length; i++) add(i);
  return out.slice(0, 5);
}

function rebuild() {
  if (!raw) return;
  const dv = $('selDist').value;
  const distSpec = dv ? { type: dv[0] === 'c' ? 'col' : 'speed', idx: +dv.slice(2) } : null;
  try {
    session = buildSession(raw, +$('selTime').value, +$('selTimeUnit').value, distSpec);
    session.origNames = raw.origNames;
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const xm = $('xMode');
  xm.querySelector('option[value=distance]').disabled = !session.dist;
  if (!session.dist) xm.value = 'time';
  chart.mode = xm.value;
  chart.setSession(session);
  overlayPanel.setSession(session);
  chart.setChannels(selected);
  chart.setCursor(synced ? media.currentTime - offset : chart.cursorT);
  renderChannelList();
}

function renderChannelList() {
  const list = $('chanList');
  const f = $('chanFilter').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  raw.names.forEach((name, i) => {
    if (f && !name.toLowerCase().includes(f)) return;
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.includes(i);
    cb.addEventListener('change', () => {
      selected = cb.checked ? [...selected, i] : selected.filter((c) => c !== i);
      chart.setChannels(selected);
      renderChannelList();
    });
    const sw = document.createElement('span');
    sw.className = 'sw';
    const lane = selected.indexOf(i);
    sw.style.background = lane >= 0 ? Chart.color(lane) : 'transparent';
    const txt = document.createElement('span');
    txt.textContent = name;
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = raw.units[i] || '';
    lab.append(cb, sw, txt, u);
    frag.append(lab);
  });
  list.replaceChildren(frag);
}

// ---------- sync ----------
const syncKey = () => `sync:${videoName}|${dataName}|${raw ? raw.n : 0}`;

function setSynced(on) {
  synced = on;
  $('btnSync').classList.toggle('on', on);
  $('btnSync').textContent = on ? '⛓ Synced' : '⛓ Sync';
  $('nudgeMinus').disabled = !on;
  $('nudgePlus').disabled = !on;
  const lbl = $('offsetLabel');
  lbl.classList.toggle('on', on);
  lbl.textContent = on ? `Data 0 @ video ${fmtTime(offset)}` : 'Not synced';
  if (on) chart.setCursor(media.currentTime - offset);
}

function toggleSync() {
  if (synced) return setSynced(false);
  if (!session || !hasMedia()) return toast('Load a video and a data file first');
  offset = media.currentTime - chart.cursorT;
  localStorage.setItem(syncKey(), String(offset));
  setSynced(true);
  toast('Synced — chart now follows the video');
}

function nudge(sec) {
  if (!synced) return;
  offset += sec;
  localStorage.setItem(syncKey(), String(offset));
  setSynced(true);
}

function tryRestoreSync() {
  if (!session || !videoName || loadingProject) return;
  const v = localStorage.getItem(syncKey());
  if (v === null) return;
  offset = +v;
  setSynced(true);
  toast('Restored previous sync for this video + data pair');
}

function onScrub(t) {
  if (synced && hasMedia() && media.duration) {
    media.currentTime = Math.min(Math.max(t + offset, 0), media.duration);
  }
}

// ---------- main loop ----------
let lastT = NaN;
function tick() {
  const dur = media.duration || 0;
  const now = media.currentTime;
  if (!seeking) {
    $('seek').max = dur || 1;
    $('seek').value = now;
  }
  $('timeLabel').textContent = `${fmtTime(now)} / ${fmtTime(dur)}`;
  if (synced && session) {
    const t = now - offset;
    if (t !== lastT && !chart.drag) { lastT = t; chart.setCursor(t); }
  }
  if (lapsFor !== videoName) loadLaps();
  enforceTrim(now);
  applyKeyframes(now);
  overlay.playing = hasMedia() && !media.paused;
  overlay.setVideoTime(now);
  overlay.update(chart.cursorT);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- wiring ----------
$('btnOpenVideo').onclick = () => $('fileVideo').click();
$('btnOpenData').onclick = () => $('fileData').click();
$('fileVideo').onchange = (e) => { if (e.target.files[0]) openVideo(e.target.files[0]); e.target.value = ''; };
$('fileData').onchange = (e) => { if (e.target.files[0]) openData(e.target.files[0]); e.target.value = ''; };
$('modeFlat').onclick = () => set360(false);
$('mode360').onclick = () => set360(true);
$('btnResetView').onclick = () => player.resetView();
$('btnLock').onclick = () => player.setLocked(!player.locked);
$('btnPlay').onclick = togglePlay;
$('btnBack').onclick = (e) => stepVideo(e.shiftKey ? -1 : -frameDur);
$('btnFwd').onclick = (e) => stepVideo(e.shiftKey ? 1 : frameDur);
$('seek').addEventListener('input', (e) => { seeking = true; media.currentTime = +e.target.value; });
$('seek').addEventListener('change', () => { seeking = false; });
$('speed').onchange = (e) => { media.playbackRate = +e.target.value; };
$('btnMute').onclick = () => {
  video.muted = !video.muted;
  if (insv) insv.muted = video.muted;
  $('btnMute').textContent = video.muted ? '🔇' : '🔊';
};
$('xMode').onchange = (e) => chart.setMode(e.target.value);
$('btnSync').onclick = toggleSync;
$('nudgeMinus').onclick = (e) => nudge(e.shiftKey ? -0.1 : -frameDur);
$('nudgePlus').onclick = (e) => nudge(e.shiftKey ? 0.1 : frameDur);
$('selTime').onchange = () => { $('selTimeUnit').value = String(guessTimeUnit(raw.cols[+$('selTime').value])); rebuild(); };
$('selTimeUnit').onchange = rebuild;
$('selDist').onchange = rebuild;
$('chanFilter').oninput = () => raw && renderChannelList();
$('btnColumns').onclick = async () => {
  if (!raw || !(await editColumns(raw, dataName))) return;
  const tv = $('selTime').value, dv = $('selDist').value;
  populateSelectors();
  $('selTime').value = tv;
  $('selDist').value = dv;
  rebuild();
};

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if ((tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'SELECT') return;
  if (e.target.closest && e.target.closest('aside.side')) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); stepVideo(e.shiftKey ? -1 : -frameDur); break;
    case 'ArrowRight': e.preventDefault(); stepVideo(e.shiftKey ? 1 : frameDur); break;
    case 's': case 'S': toggleSync(); break;
    case 'l': case 'L': if (player.is360) player.setLocked(!player.locked); break;
    case 'k': case 'K': if (editMode() && player.is360) addKeyframe(); else return; break;
    case 'i': case 'I': if (editMode()) setTrimPoint('in'); else return; break;
    case 'o': case 'O': if (editMode()) setTrimPoint('out'); else return; break;
    case '[': nudge(-frameDur); break;
    case ']': nudge(frameDur); break;
    case '{': nudge(-0.1); break;
    case '}': nudge(0.1); break;
    default: return;
  }
});

// splitter
$('splitter').addEventListener('pointerdown', (e) => {
  const sp = e.currentTarget;
  sp.setPointerCapture(e.pointerId);
  sp.classList.add('active');
  const move = (ev) => {
    const h = Math.min(Math.max(window.innerHeight - ev.clientY - 30, 120), window.innerHeight - 240);
    document.documentElement.style.setProperty('--chart-h', `${h}px`);
  };
  const up = () => { sp.classList.remove('active'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); };
  sp.addEventListener('pointermove', move);
  sp.addEventListener('pointerup', up);
});

// drag & drop
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|insv|lrv)$/i;
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  for (const f of e.dataTransfer.files) {
    if (/\.360sync$/i.test(f.name)) { pathOf(f).then((p) => p && openProject(p)); return; }
  }
  for (const f of e.dataTransfer.files) {
    if (f.type.startsWith('video/') || VIDEO_EXT.test(f.name)) openVideo(f);
    else openData(f);
  }
});

// ---------- Analyse / Edit modes ----------
// Analyse: video + telemetry chart, overlay without driver tags. Edit: no chart, overlay + driver tags, lap trigger, export.
function setAppMode(m) {
  const edit = m === 'edit';
  document.body.classList.toggle('mode-edit', edit);
  $('appAnalyse').classList.toggle('on', !edit);
  $('appEdit').classList.toggle('on', edit);
  overlay.setNoDriver(!edit);
  localStorage.setItem('appMode', edit ? 'edit' : 'analyse');
}
$('appAnalyse').onclick = () => setAppMode('analyse');
$('appEdit').onclick = () => setAppMode('edit');
setAppMode(localStorage.getItem('appMode') || 'analyse');

// ---------- lap trigger ----------
// laps are saved per video: [{ at: video time (s), time, delta }]
let laps = [], lapsFor = null;
const lapsKey = () => `laps:${videoName}`;
function loadLaps() {
  lapsFor = videoName;
  try { laps = JSON.parse(localStorage.getItem(lapsKey()) || '[]'); } catch { laps = []; }
  if (!Array.isArray(laps)) laps = [];
  autoDeltas();
  overlay.setLaps(laps);
  renderLaps();
  try { pits = JSON.parse(localStorage.getItem(pitsKey()) || '[]'); } catch { pits = []; }
  if (!Array.isArray(pits)) pits = [];
  savePits(false);
  loadKeyframes();
  loadTrim();
}
// lap time as m:ss.mmm
function fmtLap(sec) {
  const ms = Math.round(sec * 1000), m = Math.floor(ms / 60000);
  return `${m}:${((ms - m * 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}
// deltas typed in by hand are kept; the rest are worked out against the fastest lap.
// The fastest lap shows how far ahead of the next best it is (negative, so purple).
function autoDeltas() {
  const secs = laps.map((l) => parseTime(l.time)).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  const sign = (d) => `${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(3)}`;
  for (const l of laps) {
    if (l.manual) continue;
    const t = parseTime(l.time);
    if (!Number.isFinite(t) || t <= 0 || secs.length < 2) { l.delta = ''; continue; }
    l.delta = t === secs[0] ? sign(t - secs[1]) : sign(t - secs[0]);
    if (l.delta === '+0.000' && t === secs[0]) l.delta = '-0.000';
  }
}
function saveLaps() {
  laps.sort((a, b) => a.at - b.at);
  autoDeltas();
  localStorage.setItem(lapsKey(), JSON.stringify(laps));
  overlay.setLaps(laps);
  renderLaps();
}
function renderLaps() {
  const tb = $('lapList');
  tb.replaceChildren();
  laps.forEach((l, i) => {
    const tr = tb.insertRow();
    const neg = /^[-−]/.test(String(l.delta || '').trim());
    [`Lap ${i + 1}`, `@ ${fmtTime(l.at)}`, l.time, l.delta ? String(l.delta) : ''].forEach((t, j) => {
      const td = tr.insertCell(); td.textContent = t;
      if (j === 3 && l.delta) td.className = neg ? 'neg' : 'pos';
    });
    const td = tr.insertCell(); td.style.textAlign = 'right';
    const go = document.createElement('button'); go.textContent = '▶'; go.title = 'Jump to this trigger';
    go.onclick = () => { media.currentTime = Math.max(0, l.at - 0.5); };
    const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Remove';
    del.onclick = () => { laps.splice(i, 1); saveLaps(); };
    td.append(go, ' ', del);
  });
}
$('btnLap').onclick = () => {
  if (lapsFor !== videoName) loadLaps();
  $('lapAt').value = fmtTime(media.currentTime || 0);
  $('lapDialog').showModal();
  overlay.setLapPreview('dialog', true);
};
$('lapDialog').addEventListener('close', () => overlay.setLapPreview('dialog', false));
$('lapNow').onclick = () => { $('lapAt').value = fmtTime(media.currentTime || 0); };
$('lapAdd').onclick = () => {
  const at = parseTime($('lapAt').value), secs = parseTime($('lapTime').value), delta = $('lapDelta').value.trim();
  if (!Number.isFinite(at)) { toast('Enter the trigger time as m:ss.mmm', true); return; }
  if (!Number.isFinite(secs) || secs <= 0) { toast('Enter a lap time, e.g. 132456 for 1:32.456', true); return; }
  if (delta && !/^[-−+]?\s*[\d:.]+s?$/i.test(delta)) { toast('Delta should look like -0.234 or +1.05', true); return; }
  laps.push(delta ? { at, time: fmtLap(secs), delta, manual: true } : { at, time: fmtLap(secs), delta: '' });
  saveLaps();
  $('lapTime').value = ''; $('lapDelta').value = '';
};
$('lapClose').onclick = () => $('lapDialog').close();
// type just the digits: 132456 becomes 1:32.456
$('lapTime').addEventListener('input', (e) => {
  const d = e.target.value.replace(/\D/g, '').slice(0, 6);
  e.target.value = d.length <= 1 ? d : d.length <= 3 ? `${d[0]}:${d.slice(1)}` : `${d[0]}:${d.slice(1, 3)}.${d.slice(3)}`;
});

// ---------- manual pit lane ----------
// zones are saved per video (loaded with the laps): [{ from, to }] in video time (s)
let pits = [];
const pitsKey = () => `pits:${videoName}`;
function savePits(store = true) {
  pits = pits.filter((p) => p && Number.isFinite(p.from) && Number.isFinite(p.to) && p.to > p.from).sort((a, b) => a.from - b.from);
  if (store && videoName) localStorage.setItem(pitsKey(), JSON.stringify(pits));
  overlay.setPitZones(pits);
  $('pitCount').textContent = pits.length ? `(${pits.length})` : '';
  const tb = $('pitList');
  tb.replaceChildren();
  pits.forEach((p, i) => {
    const tr = tb.insertRow();
    [`Pit ${i + 1}`, `${fmtTime(p.from)} → ${fmtTime(p.to)}`, `${(p.to - p.from).toFixed(1)} s`].forEach((t) => { tr.insertCell().textContent = t; });
    const td = tr.insertCell(); td.style.textAlign = 'right';
    const go = document.createElement('button'); go.textContent = '▶'; go.title = 'Jump to the start of this zone';
    go.onclick = () => { media.currentTime = p.from; };
    const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Remove';
    del.onclick = () => { pits.splice(i, 1); savePits(); };
    td.append(go, ' ', del);
  });
}
$('btnPit').onclick = () => {
  if (!videoName) return toast('Open a video first');
  if (lapsFor !== videoName) loadLaps();
  $('pitDialog').showModal();
};
$('pitFromNow').onclick = () => { $('pitFrom').value = fmtTime(media.currentTime || 0); };
$('pitToNow').onclick = () => { $('pitTo').value = fmtTime(media.currentTime || 0); };
$('pitAdd').onclick = () => {
  const from = parseTime($('pitFrom').value), to = parseTime($('pitTo').value);
  if (!Number.isFinite(from) || !Number.isFinite(to)) { toast('Enter From and To as m:ss.mmm', true); return; }
  if (to <= from) { toast('To must be after From', true); return; }
  pits.push({ from, to });
  savePits();
  $('pitFrom').value = ''; $('pitTo').value = '';
};
$('pitClose').onclick = () => $('pitDialog').close();

// ---------- 360 view keyframes ----------
// saved per video (loaded with the laps): [{ at: video time (s), lon, lat, fov }]
let kfs = [], kfLastT = NaN, kfDrag = null;
const kfKey = () => `kf:${videoName}`;
const editMode = () => document.body.classList.contains('mode-edit');
const kfOn = () => player.is360 && kfs.length > 0 && editMode();
function loadKeyframes() {
  try { kfs = JSON.parse(localStorage.getItem(kfKey()) || '[]'); } catch { kfs = []; }
  if (!Array.isArray(kfs)) kfs = [];
  saveKeyframes(false);
}
function saveKeyframes(store = true) {
  kfs = kfs.filter((k) => k && ['at', 'lon', 'lat', 'fov'].every((p) => Number.isFinite(k[p]))).sort((a, b) => a.at - b.at);
  keyframesChanged();
  if (store && videoName) {
    if (kfs.length) localStorage.setItem(kfKey(), JSON.stringify(kfs)); else localStorage.removeItem(kfKey());
  }
  kfLastT = NaN;
  renderKeyframes();
}
function renderKeyframes() {
  const box = $('kfMarks'), dur = media.duration || 0;
  box.replaceChildren();
  if (!player.is360 || !dur) return;
  kfs.forEach((k, i) => {
    const d = document.createElement('i');
    d.style.left = `${(k.at / dur) * 100}%`;
    d.title = `Keyframe ${i + 1} @ ${fmtTime(k.at)} · click to jump, drag to move, right-click to delete`;
    d.dataset.i = i;
    box.append(d);
  });
}
// the view follows the keyframes while playing or after a seek; when paused it's left alone so it can be aimed
function applyKeyframes(now) {
  const at = kfOn() ? keyAt(kfs, now, frameDur) : -1;
  const v = kfOn() ? viewAt(kfs, now) : null;
  if (v && !player.dragging && (!media.paused || now !== kfLastT)) Object.assign(player, v);
  kfLastT = now;
  const off = v && (Math.abs(((player.lon - v.lon + 540) % 360) - 180) > 0.3 || Math.abs(player.lat - v.lat) > 0.3 || Math.abs(player.fov - v.fov) > 0.3);
  const b = $('kfAdd');
  b.classList.toggle('pending', !!off);
  b.classList.toggle('at', at >= 0);
  b.textContent = at >= 0 ? (off ? '◆ Update' : '◆ On keyframe') : '◆ Keyframe';
  $('kfDel').disabled = at < 0;
  for (const d of $('kfMarks').children) d.classList.toggle('at', +d.dataset.i === at);
}
function addKeyframe() {
  if (!player.is360 || !hasMedia()) return;
  if (lapsFor !== videoName) loadLaps();
  const t = media.currentTime || 0, i = keyAt(kfs, t, frameDur);
  const k = { at: i >= 0 ? kfs[i].at : t, lon: Math.round(player.lon * 100) / 100, lat: Math.round(player.lat * 100) / 100, fov: Math.round(player.fov * 100) / 100 };
  if (i >= 0) kfs[i] = k; else kfs.push(k);
  saveKeyframes();
  kfLastT = t;
  if (kfs.length === 1) toast('Keyframe added — move the playhead, aim the view and add another');
}
function deleteKeyframe(i) {
  if (i < 0 || i >= kfs.length) return;
  kfs.splice(i, 1);
  saveKeyframes();
}
function jumpKeyframe(dir) {
  const t = media.currentTime || 0, tol = Math.max(0.01, frameDur / 2);
  const k = dir > 0 ? kfs.find((x) => x.at > t + tol) : [...kfs].reverse().find((x) => x.at < t - tol);
  if (k) { media.pause(); media.currentTime = k.at; }
}
$('kfAdd').onclick = addKeyframe;
$('kfDel').onclick = (e) => {
  if (e.shiftKey) {
    if (kfs.length && confirm(`Delete all ${kfs.length} keyframes?`)) { kfs = []; saveKeyframes(); }
    return;
  }
  deleteKeyframe(keyAt(kfs, media.currentTime || 0, frameDur));
};
$('kfPrev').onclick = () => jumpKeyframe(-1);
$('kfNext').onclick = () => jumpKeyframe(1);
// diamonds: click to jump, drag to retime, right-click to delete
$('kfMarks').addEventListener('pointerdown', (e) => {
  const d = e.target.closest('i');
  if (!d || e.button !== 0) return;
  e.preventDefault();
  d.setPointerCapture(e.pointerId);
  kfDrag = { i: +d.dataset.i, x: e.clientX, moved: false, el: d };
});
$('kfMarks').addEventListener('pointermove', (e) => {
  if (!kfDrag) return;
  if (Math.abs(e.clientX - kfDrag.x) > 3) kfDrag.moved = true;
  if (!kfDrag.moved) return;
  const r = $('kfMarks').getBoundingClientRect(), dur = media.duration || 0;
  const t = Math.min(dur, Math.max(0, ((e.clientX - r.left) / r.width) * dur));
  kfs[kfDrag.i].at = t;
  keyframesChanged();
  kfDrag.el.style.left = `${(t / dur) * 100}%`;
  media.pause();
  media.currentTime = t;
});
const kfDragEnd = () => {
  if (!kfDrag) return;
  const { i, moved } = kfDrag;
  kfDrag = null;
  if (moved) {
    // don't let a dragged keyframe land on top of another
    const k = kfs[i];
    if (kfs.some((x, j) => j !== i && Math.abs(x.at - k.at) < frameDur)) kfs.splice(i, 1);
    saveKeyframes();
  } else { media.pause(); media.currentTime = kfs[i].at; }
};
$('kfMarks').addEventListener('pointerup', kfDragEnd);
$('kfMarks').addEventListener('pointercancel', kfDragEnd);
$('kfMarks').addEventListener('contextmenu', (e) => {
  const d = e.target.closest('i');
  if (!d) return;
  e.preventDefault();
  deleteKeyframe(+d.dataset.i);
});
video.addEventListener('durationchange', renderKeyframes);

// ---------- trim ----------
// saved per video (loaded with the laps): { in, out } in video time (s), either may be null
let trim = { in: null, out: null }, trimDrag = null;
const trimKey = () => `trim:${videoName}`;
const trimRange = () => {
  const dur = media.duration || 0;
  return [trim.in ?? 0, Math.min(dur, trim.out ?? dur)];
};
const isTrimmed = () => trim.in !== null || trim.out !== null;
function loadTrim() {
  let t = null;
  try { t = JSON.parse(localStorage.getItem(trimKey()) || 'null'); } catch { /* ignore */ }
  setTrim(t || {}, false);
}
function setTrim(t, store = true) {
  const num = (x) => (Number.isFinite(x) && x >= 0 ? x : null);
  trim = { in: num(t.in), out: num(t.out) };
  if (trim.in !== null && trim.out !== null && trim.out <= trim.in + 0.1) trim.out = null;
  if (store && videoName) {
    if (isTrimmed()) localStorage.setItem(trimKey(), JSON.stringify(trim)); else localStorage.removeItem(trimKey());
  }
  renderTrim();
}
function renderTrim() {
  const box = $('trimMarks'), dur = media.duration || 0;
  box.hidden = !dur || !isTrimmed();
  $('trimClear').disabled = !isTrimmed();
  if (box.hidden) return;
  const [a, b] = trimRange(), pa = (a / dur) * 100, pb = (b / dur) * 100;
  const [sl, sr, hi, ho] = box.children;
  sl.style.width = `calc(${pa}% + 8px)`;
  sr.style.width = `calc(${100 - pb}% + 8px)`;
  hi.style.left = `${pa}%`; hi.hidden = trim.in === null;
  ho.style.left = `${pb}%`; ho.hidden = trim.out === null;
  hi.title = `Start ${fmtTime(a)} · drag to move`;
  ho.title = `End ${fmtTime(b)} · drag to move`;
}
function setTrimPoint(which) {
  if (!hasMedia() || !media.duration) return;
  if (lapsFor !== videoName) loadLaps();
  const t = media.currentTime || 0;
  if (which === 'in') setTrim({ in: t, out: trim.out !== null && trim.out > t + 0.1 ? trim.out : null });
  else setTrim({ in: trim.in !== null && trim.in < t - 0.1 ? trim.in : null, out: t });
  toast(`${which === 'in' ? 'Start' : 'End'} set at ${fmtTime(t)}`);
}
// in Edit, playback stays inside the trimmed clip
function enforceTrim(now) {
  if (!editMode() || !isTrimmed() || media.paused || !media.duration) return;
  const [a, b] = trimRange();
  if (now >= b - 0.01) { media.pause(); media.currentTime = b; }
  else if (now < a - 0.05) media.currentTime = a;
}
function playFromTrim() {
  if (!editMode() || !isTrimmed() || !media.paused) return;
  const [a, b] = trimRange(), t = media.currentTime || 0;
  if (t < a || t >= b - frameDur) media.currentTime = a;
}
$('trimIn').onclick = () => setTrimPoint('in');
$('trimOut').onclick = () => setTrimPoint('out');
$('trimClear').onclick = () => { setTrim({}); toast('Trim cleared'); };
$('trimMarks').addEventListener('pointerdown', (e) => {
  const h = e.target.closest('b');
  if (!h || e.button !== 0) return;
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  trimDrag = h.classList.contains('in') ? 'in' : 'out';
  media.pause();
});
$('trimMarks').addEventListener('pointermove', (e) => {
  if (!trimDrag) return;
  const r = $('trimMarks').getBoundingClientRect(), dur = media.duration || 0;
  let t = Math.min(dur, Math.max(0, ((e.clientX - r.left) / r.width) * dur));
  if (trimDrag === 'in' && trim.out !== null) t = Math.min(t, trim.out - 0.2);
  if (trimDrag === 'out' && trim.in !== null) t = Math.max(t, trim.in + 0.2);
  trim[trimDrag] = t;
  renderTrim();
  media.currentTime = t;
});
const trimDragEnd = () => { if (trimDrag) { trimDrag = null; setTrim(trim); } };
$('trimMarks').addEventListener('pointerup', trimDragEnd);
$('trimMarks').addEventListener('pointercancel', trimDragEnd);
video.addEventListener('durationchange', renderTrim);

// ---------- export ----------
function parseTime(str) {
  const p = String(str).trim().split(':').map(Number);
  if (!p.length || p.some((x) => !Number.isFinite(x))) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
}

// where the picture sits in the stage, and the overlay relative to it (so the export matches the screen)
function exportGeometry() {
  const A = overlay.aspect(), { x: vx, y: vy, w: vw, h: vh } = overlay.pic();
  let rect = null, tagRect = null;
  // a stage canvas's box as fractions of the picture
  const box = (c) => {
    const cs = c.style;
    const ow = parseFloat(cs.width), oh = parseFloat(cs.height);
    const rw = Math.min(1, ow / vw), rh = Math.min(1, oh / vh);
    return {
      x: Math.min(1 - rw, Math.max(0, (parseFloat(cs.left) - vx) / vw)),
      y: Math.min(1 - rh, Math.max(0, (parseFloat(cs.top) - vy) / vh)),
      w: rw,
    };
  };
  if (overlay.visible) rect = box(overlay.canvas);
  if (overlay.tagOn) tagRect = box(overlay.tagCv);
  const lapRect = overlay.lapsOn ? box(overlay.lapCv) : null;
  // the picture's height on screen in device pixels: the app draws the overlay at this resolution
  return { A, rect, tagRect, lapRect, previewH: Math.round(vh * devicePixelRatio) };
}

const even = (x) => Math.max(2, Math.round(x / 2) * 2);
let exporting = null;

function dataRange() {
  if (!synced || !session) return null;
  const dur = media.duration || 0;
  const a = Math.max(0, session.t[0] + offset), b = Math.min(dur, session.t[session.t.length - 1] + offset);
  return b > a ? [a, b] : null;
}

function setRange(kind) {
  const dur = media.duration || 0;
  const lapsMode = kind === 'laps';
  $('expTimes').hidden = lapsMode;
  $('expLaps').hidden = !lapsMode;
  if (lapsMode) renderExpLaps();
  const r = kind === 'data' ? dataRange() : kind === 'all' ? [0, dur] : kind === 'trim' ? trimRange() : null;
  if (r) { $('expStart').value = fmtTime(r[0]); $('expEnd').value = fmtTime(r[1]); }
}

// each lap trigger ends a lap: it runs back from the trigger by its lap time (or to the previous trigger if the time won't parse)
function lapSpans() {
  if (lapsFor !== videoName) loadLaps();
  const dur = media.duration || 0;
  return laps.map((l, i) => {
    const lt = parseTime(l.time);
    const a = Math.max(0, Number.isFinite(lt) && lt > 0 ? l.at - lt : i > 0 ? laps[i - 1].at : 0);
    return { n: i + 1, lap: l, a, b: l.at, ok: l.at > a + 1 && l.at <= dur + 0.05 };
  });
}

function renderExpLaps() {
  const box = $('expLapList');
  box.replaceChildren();
  const cell = (t, c) => { const s = document.createElement('span'); s.textContent = t; if (c) s.className = c; return s; };
  for (const s of lapSpans()) {
    const lb = document.createElement('label');
    if (!s.ok) lb.className = 'bad';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = s.ok; cb.disabled = !s.ok; cb.dataset.n = s.n;
    cb.onchange = updateExportEstimate;
    const d = String(s.lap.delta || '').trim();
    lb.append(cb, cell(`Lap ${s.n}`), cell(s.ok ? `${s.lap.time} · ${fmtTime(s.a)} – ${fmtTime(s.b)}` : `${s.lap.time} · outside the video`, 'muted'),
      cell(d, /^[-−]/.test(d) ? 'neg' : d ? 'pos' : ''));
    box.append(lb);
  }
}

// the ticked laps as clips, with the lead-in and run-out added
function lapJobs() {
  const dur = media.duration || 0;
  const lead = Math.max(0, Number($('expLead').value) || 0), run = Math.max(0, Number($('expRunout').value) || 0);
  const on = new Set([...$('expLapList').querySelectorAll('input:checked')].map((c) => Number(c.dataset.n)));
  return lapSpans().filter((s) => s.ok && on.has(s.n)).map((s) => ({ n: s.n, start: Math.max(0, s.a - lead), end: Math.min(dur, s.b + run) }));
}

function openExport() {
  if (!hasMedia() || !media.duration) return toast('Open a video first');
  const { A, previewH } = exportGeometry();
  exportPreviewH = previewH;
  const opts = [];
  if (!player.is360 && !insv && video.videoHeight) opts.push([video.videoWidth, video.videoHeight, 'Source']);
  // full-resolution unwrapped 360 (5.7K) needs H.265
  for (const h of A >= 1.99 ? [720, 1080, 1440, 2160, 2880] : [720, 1080, 1440, 2160]) opts.push([even(h * A), h, `${h}p`]);
  const sel = $('expRes');
  // first time: the smallest size at least as sharp as the preview
  const fit = [720, 1080, 1440, 2160].find((h) => h >= previewH * 0.95) || 2160;
  const prev = localStorage.getItem('exportRes') || `${fit}p`;
  sel.replaceChildren(...opts.map(([w, h, n]) => option(`${w}x${h}`, `${n} · ${w} × ${h}`)));
  const pick = opts.find((o) => o[2] === prev) || opts.find((o) => o[2] === '1080p');
  sel.value = `${pick[0]}x${pick[1]}`;
  $('expQuality').value = localStorage.getItem('exportQuality') || 'high';
  $('expCodec').value = localStorage.getItem('exportCodec') || 'avc';
  hevcSupported().then((ok) => {
    const o = $('expCodec').querySelector('option[value=hevc]');
    o.disabled = !ok;
    o.textContent = ok ? 'H.265 / HEVC (sharper)' : 'H.265 / HEVC (not available on this PC)';
    if (!ok) $('expCodec').value = 'avc';
    updateExportEstimate();
  });
  const dr = dataRange();
  if (lapsFor !== videoName) loadLaps();
  const lo = $('expRange').querySelector('option[value=laps]');
  lo.disabled = !laps.length;
  lo.textContent = laps.length ? `Each lap (${laps.length} separate clip${laps.length > 1 ? 's' : ''})` : 'Each lap (add lap triggers first)';
  $('expLead').value = localStorage.getItem('exportLead') || '2';
  $('expRunout').value = localStorage.getItem('exportRunout') || '11';
  $('expRange').querySelector('option[value=data]').disabled = !dr;
  const to = $('expRange').querySelector('option[value=trim]');
  to.hidden = to.disabled = !isTrimmed();
  if (isTrimmed()) { const [a, b] = trimRange(); to.textContent = `Trimmed clip (${fmtTime(a)} – ${fmtTime(b)})`; }
  $('expRange').value = isTrimmed() ? 'trim' : dr ? 'data' : 'all';
  setRange($('expRange').value);
  $('expSrc').textContent = videoName;
  const notes = [];
  if (!overlay.visible) notes.push('The overlay is off, so only the video will be exported.');
  else if (!synced) notes.push('Not synced: the overlay will hold the chart cursor’s values.');
  if (player.is360) notes.push('360 video is exported as the current view.');
  $('expInfo').textContent = notes.join(' ');
  $('expForm').hidden = false;
  $('expProgress').hidden = true;
  $('expGo').textContent = 'Export…';
  $('expGo').onclick = startExport;
  $('expCancel').textContent = 'Cancel';
  updateExportEstimate();
  if (!$('expDialog').open) $('expDialog').showModal();
}

let exportPreviewH = 0;
// sizes the chosen codec can't carry are disabled; shows the bitrate and roughly how big the file will be
function updateExportEstimate() {
  const codec = $('expCodec').value, sel = $('expRes');
  for (const o of sel.options) {
    const [w, h] = o.value.split('x').map(Number), fits = maxFrame(codec, w, h);
    o.disabled = !fits;
    o.textContent = o.textContent.replace(/ \(H\.265 only\)$/, '') + (fits ? '' : ' (H.265 only)');
  }
  if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) {
    const ok = [...sel.options].filter((o) => !o.disabled);
    if (ok.length) sel.value = ok[ok.length - 1].value;
  }
  const [W, H] = sel.value.split('x').map(Number);
  const fps = 1 / frameDur;
  const bps = exportBitrate(W, H, fps, codec, $('expQuality').value);
  const lapsMode = $('expRange').value === 'laps', jobs = lapsMode ? lapJobs() : null;
  const secs = lapsMode ? jobs.reduce((s, j) => s + j.end - j.start, 0) : parseTime($('expEnd').value) - parseTime($('expStart').value);
  const mb = Number.isFinite(secs) && secs > 0 ? (bps * secs) / 8 / 1e6 : NaN;
  const size = !Number.isFinite(mb) ? '' : mb >= 1000 ? ` · about ${(mb / 1000).toFixed(1)} GB` : ` · about ${Math.max(1, Math.round(mb))} MB`;
  const clips = lapsMode ? ` · ${jobs.length} clip${jobs.length === 1 ? '' : 's'}` : '';
  $('expEst').textContent = `${(bps / 1e6).toFixed(0)} Mbit/s · ${Math.round(fps * 100) / 100} fps${clips}${size}`;
  const soft = H > 0 && exportPreviewH > H * 1.15;
  $('expSharp').hidden = !soft;
  if (soft) $('expSharp').textContent = `At ${H}p the overlay has fewer pixels than in the app (${exportPreviewH} px tall on your screen), so it will look softer full screen. ${H < 2160 ? 'Pick a higher resolution for a crisp overlay.' : ''}`;
  $('expGo').disabled = !!exporting || !(W > 0) || (lapsMode && !jobs.length);
}

async function startExport() {
  const [W, H] = $('expRes').value.split('x').map(Number);
  const dur = media.duration || 0;
  const lapsMode = $('expRange').value === 'laps';
  let jobs;
  if (lapsMode) {
    jobs = lapJobs();
    if (!jobs.length) return toast('Tick at least one lap', true);
  } else {
    const start = parseTime($('expStart').value), end = parseTime($('expEnd').value);
    if (!(start >= 0 && end > start && start < dur)) return toast('Check the start and end times', true);
    jobs = [{ start, end: Math.min(end, dur) }];
  }
  localStorage.setItem('exportRes', $('expRes').selectedOptions[0].textContent.split(' ·')[0]);
  localStorage.setItem('exportQuality', $('expQuality').value);
  localStorage.setItem('exportCodec', $('expCodec').value);
  if (lapsMode) { localStorage.setItem('exportLead', $('expLead').value); localStorage.setItem('exportRunout', $('expRunout').value); }
  const base = videoName.replace(/\.[^.]+$/, '');
  const path = await window.native.saveDialog(lapsMode ? `${base}_Lap.mp4` : `${base}_360Sync.mp4`);
  if (!path) return;
  const stem = path.replace(/\.mp4$/i, '');
  for (const j of jobs) j.path = lapsMode ? `${stem}${String(j.n).padStart(2, '0')}.mp4` : path;

  const { rect, tagRect, lapRect } = exportGeometry();
  const ctrl = new AbortController();
  const wasT = media.currentTime;
  media.pause();
  if (insv) insv.suspend();
  player.exporting = true;
  exporting = ctrl;
  $('expForm').hidden = true;
  $('expProgress').hidden = false;
  $('expBar').style.width = '0%';
  $('expStatus').textContent = 'Starting…';
  $('expGo').disabled = true;
  $('expGo').textContent = 'Exporting…';
  const cursor = chart.cursorT;
  const t0 = performance.now();
  const totalFrames = jobs.reduce((s, j) => s + Math.max(1, Math.round((j.end - j.start) / frameDur)), 0);
  let res = null, error = null, saved = 0, framesBefore = 0, frames = 0, current = jobs[0];
  try {
    for (const [k, j] of jobs.entries()) {
      current = j;
      const tag = lapsMode ? `Lap ${j.n} (${k + 1} of ${jobs.length}) · ` : '';
      res = await exportVideo({
        file: videoFile, insv, video, frameDur, player, overlay,
        usePano: player.is360 || !!insv, is360: player.is360,
        view: { lon: player.lon, lat: player.lat, fov: player.fov },
        viewAt: player.is360 && kfs.length ? (t) => viewAt(kfs, t) : null,
        width: W, height: H, codec: $('expCodec').value, quality: $('expQuality').value,
        start: j.start, end: j.end, audio: $('expAudio').checked,
        dataTime: (t) => (synced ? t - offset : cursor),
        rect, tagRect, lapRect, path: j.path, signal: ctrl.signal,
        onProgress: (p) => {
          const done = framesBefore + p.done, total = Math.max(totalFrames, done);
          $('expBar').style.width = `${(lapsMode ? (done / total) * 100 : p.frac * 100).toFixed(1)}%`;
          const left = p.fps > 0 ? ((lapsMode ? total : p.total) - (lapsMode ? done : p.done)) / p.fps : 0;
          $('expStatus').textContent = `${tag}Frame ${p.done} / ${p.total} · ${p.fps.toFixed(1)} fps · ${Math.ceil(left)} s left`;
        },
      });
      saved++;
      frames += res.frames;
      framesBefore += Math.max(1, Math.round((j.end - j.start) / frameDur));
    }
  } catch (e) { error = e; }
  exporting = null;
  player.restore();
  media.currentTime = wasT;
  $('expCancel').textContent = 'Close';
  if (error) {
    const cancelled = error.name === 'AbortError';
    const kept = lapsMode && saved ? ` ${saved} lap clip${saved > 1 ? 's were' : ' was'} saved before that.` : '';
    $('expBar').style.width = '0%';
    $('expStatus').textContent = (cancelled ? 'Export cancelled.' : `Export failed${lapsMode ? ` on Lap ${current.n}` : ''}: ${String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`) + kept;
    $('expGo').textContent = 'Back';
    $('expGo').disabled = false;
    $('expGo').onclick = openExport;
    if (!cancelled) console.error(error);
    return;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const how = `${res.codec === 'hevc' ? 'H.265' : 'H.264'} ${(res.bitrate / 1e6).toFixed(0)} Mbit/s`;
  $('expBar').style.width = '100%';
  $('expStatus').textContent = lapsMode
    ? `Saved ${saved} lap clip${saved > 1 ? 's' : ''}, ${frames} frames (${how})${res.audio ? ' with audio' : ''} in ${secs} s — ${jobs.map((j) => j.path.split(/[\\/]/).pop()).join(', ')}`
    : `Saved ${res.frames} frames (${how})${res.audio ? ' with audio' : ''} in ${secs} s — ${path}`;
  $('expGo').textContent = 'Show in folder';
  $('expGo').disabled = false;
  $('expGo').onclick = () => window.native.reveal(jobs[0].path);
}

$('btnExport').onclick = openExport;
$('expRange').onchange = (e) => { setRange(e.target.value); updateExportEstimate(); };
for (const id of ['expStart', 'expEnd']) $(id).addEventListener('input', () => { $('expRange').value = 'custom'; updateExportEstimate(); });
for (const id of ['expRes', 'expQuality', 'expCodec']) $(id).addEventListener('change', updateExportEstimate);
for (const id of ['expLead', 'expRunout']) $(id).addEventListener('input', updateExportEstimate);
$('expCancel').onclick = () => { if (exporting) exporting.abort(); else $('expDialog').close(); };
$('expDialog').addEventListener('cancel', (e) => { if (exporting) { e.preventDefault(); exporting.abort(); } });

// ---------- projects ----------
// A .360sync file: where the video and data live, plus everything set up around them (sync, view, overlay, laps).
function setProject(p, name) {
  projectPath = p;
  projectName = name || '';
  document.title = projectName ? `${projectName.replace(/\.360sync$/i, '')} — 360Sync` : '360Sync';
  updateFiles();
}

function projectState() {
  if (videoName && lapsFor !== videoName) loadLaps();
  return {
    app: '360Sync', version: 1, saved: new Date().toISOString(),
    video: videoFile ? { path: videoPath, name: videoName } : null,
    data: raw ? {
      path: dataPath, name: dataName, names: raw.names, units: raw.units,
      time: +$('selTime').value, timeUnit: +$('selTimeUnit').value, dist: $('selDist').value, channels: selected, xMode: $('xMode').value,
    } : null,
    sync: { on: synced, offset },
    view: { is360: player.is360, lon: player.lon, lat: player.lat, fov: player.fov, locked: player.locked },
    stitch: insv ? stitchPanel.get() : null,
    overlay: overlayPanel.getConfig(),
    laps: videoName ? laps.map((l) => ({ ...l })) : [],
    pits: videoName ? pits.map((p) => ({ ...p })) : [],
    keyframes: videoName ? kfs.map((k) => ({ ...k })) : [],
    trim: videoName && isTrimmed() ? { ...trim } : null,
    mode: document.body.classList.contains('mode-edit') ? 'edit' : 'analyse',
    position: media.currentTime || 0,
    cursor: chart.cursorT,
  };
}

async function saveProject(as = false) {
  if (!videoFile && !raw) return toast('Open a video or data file first');
  if (videoFile && !videoPath) videoPath = await pathOf(videoFile);
  if (raw && !dataPath && dataFile) dataPath = await pathOf(dataFile);
  if ((videoFile && !videoPath) || (raw && !dataPath)) return toast('Can’t tell where the video or data file is on disk, so it can’t go in a project', true);
  let p = projectPath;
  if (as || !p) {
    const base = (projectName || videoName || dataName || 'project').replace(/\.[^.]+$/, '');
    p = await window.native.projectSaveDialog(`${base}.360sync`);
    if (!p) return;
  }
  try {
    await window.native.projectWrite(p, projectState());
  } catch (e) {
    return toast(`Could not save the project: ${e.message}`, true);
  }
  setProject(p, p.split(/[\\/]/).pop());
  toast(`Project saved — ${projectName}`);
}

async function openProject(p) {
  if (exporting) return;
  if (!p) {
    p = await window.native.projectOpenDialog();
    if (!p) return;
  }
  let r;
  try {
    r = await window.native.projectRead(p);
  } catch (e) {
    return toast(`Could not open the project: ${e.message}`, true);
  }
  const { proj, found } = r;
  // media that has moved: ask where it is now
  for (const k of ['video', 'data']) {
    if (proj[k] && !found[k]) {
      toast(`Can’t find ${proj[k].name} — please locate it`, true);
      found[k] = await window.native.locateFile(proj[k].name, k);
    }
  }
  loadingProject = true;
  try {
    if (found.video) await openVideo(new DiskFile(found.video));
    if (found.data) await openData(new DiskFile(found.data), proj.data || {});
    if (proj.view) {
      set360(!!proj.view.is360);
      player.setView(proj.view);
    }
    if (insv && proj.stitch) stitchPanel.set(proj.stitch);
    if (proj.overlay) overlayPanel.setConfig(proj.overlay);
    // per-video settings only belong to the project's own video (not whatever was open before)
    const own = !!(found.video && videoName);
    if (videoName) loadLaps();
    if (own && Array.isArray(proj.laps)) {
      laps = proj.laps.filter((l) => l && Number.isFinite(l.at)).map((l) => ({ at: l.at, time: String(l.time || ''), delta: String(l.delta || ''), ...(l.manual ? { manual: true } : {}) }));
      saveLaps();
    }
    if (own && Array.isArray(proj.pits)) {
      pits = proj.pits.filter(Boolean).map((p) => ({ from: +p.from, to: +p.to })).filter((p) => Number.isFinite(p.from) && Number.isFinite(p.to));
      savePits();
    }
    if (own && Array.isArray(proj.keyframes)) {
      kfs = proj.keyframes.filter(Boolean).map((k) => ({ at: +k.at, lon: +k.lon, lat: +k.lat, fov: +k.fov })).filter((k) => [k.at, k.lon, k.lat, k.fov].every(Number.isFinite));
      saveKeyframes();
    }
    if (own && 'trim' in proj) setTrim(proj.trim || {});
    setAppMode(proj.mode === 'edit' ? 'edit' : 'analyse');
    if (own && proj.sync && Number.isFinite(proj.sync.offset)) offset = proj.sync.offset;
    if (own && media.duration && Number.isFinite(proj.position)) media.currentTime = Math.min(Math.max(0, proj.position), media.duration);
    if (session && own && proj.sync && proj.sync.on) {
      localStorage.setItem(syncKey(), String(offset));
      setSynced(true);
    } else if (session && Number.isFinite(proj.cursor)) chart.setCursor(proj.cursor);
  } finally {
    loadingProject = false;
  }
  setProject(p, r.name);
  const missing = ['video', 'data'].filter((k) => proj[k] && !found[k]);
  if (missing.length) toast(`Opened ${r.name} without its ${missing.join(' and ')} file`, true);
  else toast(`Opened ${r.name}`);
}

const menu = $('projectMenu');
const closeMenu = () => { menu.hidden = true; $('btnProject').classList.remove('on'); };
$('btnProject').onclick = (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('btnProject').classList.toggle('on', !menu.hidden);
};
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.menuWrap')) closeMenu(); });
$('pmOpen').onclick = () => { closeMenu(); openProject(); };
$('pmSave').onclick = () => { closeMenu(); saveProject(false); };
$('pmSaveAs').onclick = () => { closeMenu(); saveProject(true); };
$('pmAbout').onclick = async () => {
  closeMenu();
  const i = await window.native.appInfo().catch(() => null);
  $('aboutVer').textContent = i ? `v${i.version}` : '';
  $('aboutTech').textContent = i ? `Electron ${i.electron} · Chromium ${i.chrome}` : '';
  $('aboutDialog').showModal();
};
$('aboutClose').onclick = () => $('aboutDialog').close();
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); saveProject(e.shiftKey); }
  else if (k === 'o') { e.preventDefault(); openProject(); }
});
window.native.onProjectOpen((p) => openProject(p));
window.native.projectInitial().then((p) => { if (p) openProject(p); });