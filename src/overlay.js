// F1-style telemetry dial drawn over the video, driven by the chart cursor time.
import { interp, nearestIndex, guessSpeedCol } from './telemetry.js';
import { FLAGS, FLAGS_READY, drawFlag } from './flags.js';

const $ = (id) => document.getElementById(id);
const KEY = 'overlay';
const TPL_KEY = 'overlayTemplates';
const DEG = Math.PI / 180;

// gauges the user can point a channel at
const SLOTS = [
  { key: 'speed', label: 'Speed', re: null },
  { key: 'rpm', label: 'RPM', re: /rpm|engine.?speed|nmot|n_?eng/i },
  { key: 'throttle', label: 'Throttle', re: /throttle|tps|pedal|aps|accel/i },
  { key: 'brake', label: 'Brake', re: /brake|bps|pbrake/i },
  { key: 'clutch', label: 'Clutch', re: /clutch/i },
  { key: 'gear', label: 'Gear', re: /gear/i },
  { key: 'drs', label: 'DRS', re: /drs|rear.?flap|wing.?open/i },
  { key: 'pit', label: 'Pit limiter', re: /pit.?lim|limiter|pit.?lane|pit.?sw/i },
];
const DEFAULTS = {
  show: true, style: 'dial', speedMax: 0, size: 0.42, opacity: 1, x: 0.86, y: 0.7, map: {},
  pitLimit: 80, driver: false, name: '', number: '', flag: '', flagImg: '', accent: '#e10600',
  lapShow: true, lapSize: 0.42,
};

const C = { disc: '#1b1b1d', rim: '#232326', track: '#3a3a3e', speed: '#1a9cc9', throttle: '#43a83f', brake: '#d23a2e', text: '#ffffff', muted: '#9a9aa0' };
const FONT = '"Segoe UI", "Titillium Web", system-ui, sans-serif';
const CFONT = 'Arial, "Segoe UI", sans-serif';
const PIT = '#ffb300', PIT_DIM = '#8a6100', PIT_OVER = '#ff3b30';
const CAP = 0.36; // half cap-height of FONT as a fraction of the font size
const TRACE_W = 540, TRACE_H = 130, TRACE_SECS = 5;
// arc angles (canvas: 0 = right, clockwise); throttle and brake mirror each other
const SPD_A0 = 135, SPD_SWEEP = 270;
const THR_A0 = 142, THR_A1 = 262;
const BRK_A0 = 38, BRK_A1 = -82;

// McLaren pod palette and speedmark (used in place of the car number on its driver tag)
const POD = { P: '#FF8000', W: '#F4F4F4', G: '#8B929C', THR: '#2FD27A', BRK: '#FF3B3B', BLU: '#3FC8FF', PUR: '#B04BFF', AMB: '#FFB000', F: 'Bahnschrift, "Segoe UI", sans-serif' };
const MARK = new Image();
MARK.src = new URL('./assets/speedmark.png', import.meta.url).href;
let carbonTile;
// pod drawing box (logical units) and its driver tag, which is a separate, separately movable canvas
const POD_BOX = [21, 17, 379, 375], POD_U = 368;
const TAG_W = 380, TAG_H = 42, TAG_M = 6, TAG_CW = TAG_W + 2 * TAG_M, TAG_CH = TAG_H + 2 * TAG_M;
// default tag spot under the pod, in pod units from the pod canvas centre
const TAG_DX = TAG_W / 2 - (POD_BOX[0] + POD_BOX[2]) / 2, TAG_DY = 390 + TAG_H / 2 - (POD_BOX[1] + POD_BOX[3]) / 2;
// lap time box: wipes in at the trigger, holds, wipes out (seconds of video time)
const LAP_HOLD = 10, LAP_OUT = 0.6, LAP_DUR = LAP_HOLD + LAP_OUT;
const LAP_TILE = 132;

// shared pod drawing helpers for a context drawn at scale s (for glow sizes)
function podKit(ctx, s) {
  const glow = (col, b) => { ctx.shadowColor = col; ctx.shadowBlur = b * s; };
  const noGlow = () => { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; };
  const txt = (str, x, y, size, weight, color, align = 'center', sp = 0, stretch = 'normal') => {
    ctx.font = `${weight} ${size}px ${POD.F}`; ctx.fontStretch = stretch; ctx.letterSpacing = `${sp}px`;
    ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = color; ctx.fillText(str, x, y);
    ctx.letterSpacing = '0px'; ctx.fontStretch = 'normal';
  };
  const chamfer = (x, y, w, h, tl = 0, br = 0) => {
    ctx.beginPath(); ctx.moveTo(x + tl, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h - br);
    ctx.lineTo(x + w - br, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + tl); ctx.closePath();
  };
  // carbon-weave fill with a top-down sheen for the current path
  const panel = (y0, h) => {
    if (!carbonTile) {
      const t = (carbonTile = document.createElement('canvas')); t.width = t.height = 8; const x = t.getContext('2d');
      x.fillStyle = '#121418'; x.fillRect(0, 0, 8, 8);
      x.fillStyle = '#1b1e23'; x.fillRect(0, 0, 4, 4); x.fillRect(4, 4, 4, 4);
      x.fillStyle = 'rgba(255,255,255,0.035)'; x.fillRect(0, 0, 4, 1); x.fillRect(4, 4, 1, 4);
    }
    ctx.save(); ctx.clip();
    ctx.globalAlpha = 0.93; ctx.fillStyle = ctx.createPattern(carbonTile, 'repeat'); ctx.fillRect(-50, -50, 600, 600);
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, 'rgba(40,44,52,0.55)'); g.addColorStop(0.5, 'rgba(10,11,14,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(-50, -50, 600, 600);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1.5; ctx.stroke();
  };
  return { glow, noGlow, txt, chamfer, panel };
}

// drag to move (get/set position as fractions of the video picture), scroll to resize
function draggable(cv, ov, get, set, sizeKey = 'size') {
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (ov.cfg.locked) return;
    e.stopPropagation();
    cv.setPointerCapture(e.pointerId);
    const [cx, cy] = get();
    drag = { x: e.clientX, y: e.clientY, cx, cy, p: ov.pic() };
    cv.classList.add('dragging');
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    set(drag.cx + (e.clientX - drag.x) / drag.p.w, drag.cy + (e.clientY - drag.y) / drag.p.h);
    ov.layout();
  });
  const end = () => { if (drag && ov.onChange) ov.onChange(); drag = null; cv.classList.remove('dragging'); };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('lostpointercapture', end);
  cv.addEventListener('wheel', (e) => {
    if (ov.cfg.locked) return;
    e.preventDefault();
    e.stopPropagation();
    ov.cfg[sizeKey] = Math.min(1, Math.max(0.15, (ov.cfg[sizeKey] || ov.cfg.size) * Math.exp(-e.deltaY * 0.001)));
    ov.layout();
    if (ov.onChange) ov.onChange();
  }, { passive: false });
}

const niceStep = (m) => [5, 10, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200].find((s) => m / s <= 7) || 250;
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

function percentile(col, p) {
  const step = Math.max(1, Math.floor(col.length / 5000)), a = [];
  for (let i = 0; i < col.length; i += step) if (Number.isFinite(col[i])) a.push(col[i]);
  if (!a.length) return 0;
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

export class Overlay {
  constructor(stage) {
    this.stage = stage;
    this.session = null;
    this.idx = {};         // slot -> column index (or -1)
    this.scale = {};       // per-slot ranges
    this.cfg = { ...DEFAULTS };
    this.last = '';
    // aspect ratio of the video picture (set by the app); overlays are placed and sized relative to it
    this.getAspect = () => 16 / 9;
    const cv = (this.canvas = document.createElement('canvas'));
    cv.className = 'overlay';
    cv.title = 'Drag to move · scroll to resize';
    stage.appendChild(cv);
    this.ctx = cv.getContext('2d');
    draggable(cv, this, () => this.ovPos || [this.cfg.x, this.cfg.y], (x, y) => { this.cfg.x = x; this.cfg.y = y; });
    cv.addEventListener('dblclick', (e) => e.stopPropagation());

    // McLaren pod driver tag: its own canvas, moved independently; double-click snaps it back under the pod
    const tc = (this.tagCv = document.createElement('canvas'));
    tc.className = 'overlay';
    tc.title = 'Drag to move · scroll to resize · double-click to put back under the pod';
    stage.appendChild(tc);
    draggable(tc, this, () => this.tagPos || [this.cfg.x, this.cfg.y], (x, y) => { this.cfg.tagX = x; this.cfg.tagY = y; });
    tc.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      delete this.cfg.tagX; delete this.cfg.tagY;
      this.layout();
      if (this.onChange) this.onChange();
    });

    // lap time box: its own canvas, shown while a lap trigger is playing out (and as a preview while it's being placed)
    this.laps = [];
    this.vt = NaN;
    const lc = (this.lapCv = document.createElement('canvas'));
    lc.className = 'overlay';
    lc.title = 'Drag to move · scroll to resize · double-click to reset its position';
    stage.appendChild(lc);
    draggable(lc, this, () => this.lapPos || [0.5, 0.1], (x, y) => { this.cfg.lapX = x; this.cfg.lapY = y; }, 'lapSize');
    this.lapPreview = new Set();
    lc.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      delete this.cfg.lapX; delete this.cfg.lapY;
      this.layout();
      if (this.onChange) this.onChange();
    });
    new ResizeObserver(() => this.layout()).observe(stage);
    MARK.decode().then(() => this.layout(), () => {});
    FLAGS_READY.then(() => this.layout(), () => {});
  }

  setConfig(cfg) {
    this.cfg = cfg;
    if (!cfg.flagImg) this.flagImg = null;
    else if (!this.flagImg || this.flagImg.src !== cfg.flagImg) {
      this.flagImg = new Image();
      this.flagImg.onload = () => this.layout();
      this.flagImg.src = cfg.flagImg;
    }
    this.resolve();
    this.layout();
  }

  setSession(s) {
    this.session = s;
    this.resolve();
    this.layout();
  }

  // map slot -> column index using the saved channel names, falling back to a guess by name
  resolve() {
    const s = this.session;
    this.idx = {};
    if (!s) return;
    const used = new Set();
    for (const sl of SLOTS) {
      const want = this.cfg.map[sl.key];
      let i = -1;
      if (want === '') i = -1;
      else if (want !== undefined && s.names.includes(want)) i = s.names.indexOf(want);
      else if (sl.key === 'speed') i = guessSpeedCol({ ...s, names: s.origNames || s.names });
      else i = (s.origNames || s.names).findIndex((n, k) => sl.re.test(n) && !used.has(k));
      if (i >= 0) used.add(i);
      this.idx[sl.key] = i;
    }
    const col = (k) => (this.idx[k] >= 0 ? s.cols[this.idx[k]] : null);
    const unit = (k) => (this.idx[k] >= 0 ? (s.units[this.idx[k]] || '').toLowerCase() : '');
    const su = unit('speed');
    this.speedK = su.includes('m/s') ? 3.6 : 1;
    this.speedUnit = su.includes('mph') ? 'MPH' : 'KMH';
    const sp = col('speed');
    const smax = this.cfg.speedMax > 0 ? this.cfg.speedMax : sp ? percentile(sp, 0.999) * this.speedK : 300;
    const step = niceStep(smax);
    this.scale.speed = { max: Math.max(step, Math.ceil(smax / step) * step), step };
    const th = col('throttle');
    this.scale.throttle = th && percentile(th, 0.999) <= 1.05 ? 1 : 100;
    const cl = col('clutch');
    this.scale.clutch = cl && percentile(cl, 0.999) <= 1.05 ? 1 : 100;
    const br = col('brake');
    this.scale.brake = br ? Math.max(1e-6, percentile(br, 0.995)) : 1;
    const rp = col('rpm');
    this.scale.rpm = Math.max(1000, Math.ceil((rp ? percentile(rp, 0.999) : 8000) / 1000) * 1000);
    // classic gauge starts just below the lowest regular rpm, like a race car's tacho
    this.scale.rpmMin = rp ? Math.min(this.scale.rpm - 8000, Math.max(0, Math.floor(percentile(rp, 0.02) / 1000) - 1) * 1000) : 0;
    if (this.scale.rpmMin < 0) this.scale.rpmMin = 0;
    this.last = '';
  }

  // driver plate: as configured, but never in Analyse mode
  get driverOn() { return !!this.cfg.driver && !this.noDriver; }
  setNoDriver(on) { this.noDriver = !!on; this.layout(); }
  get visible() { return !!(this.cfg.show && this.session); }

  // Export: draw the overlay for data time t (clock = nowMs, for flashing/animation) at W px wide onto an offscreen canvas.
  renderAt(t, nowMs, W) {
    const trace = this.cfg.style === 'trace';
    W = Math.max(8, Math.round(W));
    const H = trace ? Math.round(W * TRACE_H / TRACE_W) : W;
    const cv = this.exportCv || (this.exportCv = document.createElement('canvas'));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const keep = [this.canvas, this.ctx, this.t, this.gt, this.gpos];
    // the export has its own gear-roll animation state, separate from the live view's
    [this.gt, this.gpos] = this.expAnim || [0, NaN];
    this.canvas = cv;
    this.ctx = cv.getContext('2d');
    this.nowMs = nowMs;
    this.last = '';
    try { this.update(t); } finally {
      this.expAnim = [this.gt, this.gpos];
      [this.canvas, this.ctx, this.t, this.gt, this.gpos] = keep;
      this.nowMs = null;
      this.last = '';
    }
    return cv;
  }

  // channels currently resolved, for the panel

  get tagOn() { return this.visible && (this.cfg.style === 'pod' || this.cfg.style === 'trace') && this.driverOn; }

  // ---- lap trigger box ----
  // laps: [{ at: video time (s), time: 'm:ss.mmm', delta: '-0.234' }]
  setLaps(laps) { this.laps = (laps || []).slice().sort((a, b) => a.at - b.at); this.lapKey = null; this.layout(); }
  get lapsOn() { return this.cfg.lapShow !== false && this.laps.length > 0; }

  // manual pit lane zones, for data without a pit limiter channel: [{ from, to }] in video time (s)
  setPitZones(z) { this.pitZones = (z || []).filter((p) => p.to > p.from); this.last = ''; }
  inPitZone(vt) { return Number.isFinite(vt) && (this.pitZones || []).some((p) => vt >= p.from && vt <= p.to); }
  // show the box in full while the overlay panel / lap dialog is open, so it can be placed
  setLapPreview(src, on) {
    if (on) this.lapPreview.add(src); else this.lapPreview.delete(src);
    this.lapKey = null;
    this.setVideoTime(this.vt);
  }

  // the lap whose box is on screen at video time vt: { lap, n, u = seconds since its trigger }
  lapAt(vt, preview = false) {
    // placement preview between triggers, only while paused and unlocked: always in the lap dialog, but from the
    // overlay panel only until laps exist (then scrubbing shows the real in/out timing). Shows the most recent lap.
    const src = this.lapPreview.has('dialog') || (this.lapPreview.has('panel') && !this.laps.length);
    const pv = preview && src && this.cfg.lapShow !== false && !this.playing && !this.cfg.locked;
    const sample = () => {
      if (!pv) return null;
      if (!this.laps.length) return { lap: { time: '1:32.456', delta: '-0.234' }, n: 1, u: 2, preview: true };
      let i = 0;
      if (Number.isFinite(vt)) for (let j = 0; j < this.laps.length && this.laps[j].at <= vt; j++) i = j;
      return { lap: this.laps[i], n: i + 1, u: 2, preview: true };
    };
    if (!this.lapsOn || !Number.isFinite(vt)) return sample();
    for (let i = this.laps.length - 1; i >= 0; i--) {
      const u = vt - this.laps[i].at;
      if (u >= 0 && u < LAP_DUR) return { lap: this.laps[i], n: i + 1, u };
      if (u >= LAP_DUR) break;
    }
    return sample();
  }

  setVideoTime(vt) {
    this.vt = vt;
    if (this.aspect() !== this.lastA) { this.layout(); return; }
    const a = this.lapAt(vt, true), lc = this.lapCv;
    const key = a ? `${a.n}|${Math.min(Math.round(a.u * 60), 9999)}|${lc.width}|${a.preview ? 'p' : ''}` : '';
    if (key === this.lapKey) return;
    this.lapKey = key;
    lc.style.display = a ? 'block' : 'none';
    // green dotted outline marks the placement preview (screen only, not exported)
    lc.classList.toggle('lap-preview', !!(a && a.preview));
    if (a) this.drawLap(lc, a);
  }

  // export: the lap box at video time vt, W px wide, or null when none is showing
  renderLap(vt, W) {
    const a = this.lapAt(vt);
    if (!a) return null;
    W = Math.max(8, Math.round(W));
    const cv = this.exportLapCv || (this.exportLapCv = document.createElement('canvas'));
    const H = Math.round(W * TAG_CH / TAG_CW);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    this.drawLap(cv, a);
    return cv;
  }

  layoutLap(w, h) {
    const D = Math.round(Math.max(8, Math.min(w, h) * (this.cfg.lapSize || this.cfg.size)));
    const lc = this.lapCv, s = D / POD_U, TW = Math.min(w, Math.round(TAG_CW * s)), TH = Math.round(TW * TAG_CH / TAG_CW), p = this.pic();
    let x = this.cfg.lapX, y = this.cfg.lapY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0.5; y = 0.1; }
    x = Math.min(1 - TW / 2 / w, Math.max(TW / 2 / w, x));
    y = Math.min(1 - TH / 2 / h, Math.max(TH / 2 / h, y));
    this.lapPos = [x, y];
    const cs = lc.style;
    cs.width = `${TW}px`; cs.height = `${TH}px`;
    cs.left = `${Math.round(p.x + x * w - TW / 2)}px`;
    cs.top = `${Math.round(p.y + y * h - TH / 2)}px`;
    const pw = Math.round(TW * devicePixelRatio), ph = Math.round(TH * devicePixelRatio);
    if (lc.width !== pw || lc.height !== ph) { lc.width = pw; lc.height = ph; }
    this.lapKey = null;
    this.setVideoTime(this.vt);
  }

  // name-plate styled lap box: LAP n blade, lap time plate, purple (faster) / red (slower) delta tile.
  // In: blade snaps in, a papaya edge wipes the plate open, time rises in, delta tile flashes in. Out: wipes back.
  drawLap(cv, { lap, n, u }) {
    const ctx = cv.getContext('2d'), s = cv.width / TAG_CW, { P, W, G, PUR, BRK } = POD;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, TAG_M * s, TAG_M * s);
    const { panel, txt, glow, noGlow } = podKit(ctx, s);
    const x = 0, y = 0, w = TAG_W, h = TAG_H, k = h * 0.35;
    const ease = (t) => 1 - Math.pow(1 - clamp01(t), 3);
    const back = (t) => { t = clamp01(t); const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
    const o = u - LAP_HOLD; // > 0 while leaving
    const inn = (a, b) => (u - a) / (b - a), out = (a, b) => 1 - ease((o - a) / (b - a));
    const blade = Math.min(back(inn(0, 0.35)), out(0.3, 0.6));
    const wipe = ease(inn(0.15, 0.6)) * out(0.05, 0.4);
    const text = ease(inn(0.4, 0.75)) * out(0, 0.15);
    const tile = ease(inn(0.6, 0.9)) * out(0, 0.2);

    const delta = String(lap.delta || '').trim();
    const neg = /^[-−]/.test(delta), dcol = neg ? PUR : BRK;
    const dtxt = delta ? (neg ? '-' : '+') + delta.replace(/^[-−+\s]+/, '').replace(/s$/i, '') + 's' : '';
    const fh = h - 3, kb = k * fh / h, fx = x + w - LAP_TILE;
    const slant = (x0, x1) => { ctx.beginPath(); ctx.moveTo(x0 + k, y); ctx.lineTo(x1 + k, y); ctx.lineTo(x1, y + h); ctx.lineTo(x0, y + h); ctx.closePath(); };

    // plate, revealed by a slanted wipe with a glowing papaya leading edge
    if (wipe > 0) {
      const ex = 70 + (w - 70) * wipe;
      ctx.save();
      slant(60, ex); ctx.clip();
      const plate = () => { ctx.beginPath(); ctx.moveTo(x + 70 + k, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - k, y + h); ctx.lineTo(x + 70, y + h); ctx.closePath(); };
      plate(); panel(y, h);
      ctx.fillStyle = P; ctx.fillRect(x + 70, y + h - 3, w - 70 - k, 3);
      if (delta && tile > 0) {
        ctx.save();
        ctx.beginPath(); ctx.moveTo(fx, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - kb, y + fh); ctx.lineTo(fx - kb, y + fh); ctx.closePath(); ctx.clip();
        slant(fx - kb - k, fx - kb + (LAP_TILE + kb) * tile); ctx.clip();
        const g = ctx.createLinearGradient(0, y, 0, y + fh);
        g.addColorStop(0, neg ? '#c56bff' : '#ff6060'); g.addColorStop(0.5, dcol); g.addColorStop(1, neg ? '#6f22b0' : '#b01818');
        ctx.fillStyle = g; ctx.fillRect(fx - kb, y, LAP_TILE + kb, fh);
        if (tile < 1) { ctx.fillStyle = `rgba(255,255,255,${(1 - tile) * 0.85})`; ctx.fillRect(fx - kb, y, LAP_TILE + kb, fh); }
        ctx.globalAlpha = text;
        txt(dtxt, fx - kb / 2 + LAP_TILE / 2, y + fh * 0.5 + 8 + (1 - text) * 10, 22, 700, W, 'center', 1, 'condensed');
        ctx.restore();
        ctx.beginPath(); ctx.moveTo(fx, y); ctx.lineTo(fx - kb, y + fh); ctx.lineWidth = 2.5; ctx.strokeStyle = P; ctx.stroke();
      }
      // lap time rises into place
      ctx.save(); plate(); ctx.clip();
      ctx.globalAlpha = text;
      const avail = (delta ? fx - kb - 12 : x + w - k - 16) - (x + 88 + k);
      let size = 26;
      ctx.font = `700 ${size}px ${POD.F}`; ctx.fontStretch = 'condensed'; ctx.letterSpacing = '2px';
      const tw = ctx.measureText(String(lap.time || '')).width;
      ctx.letterSpacing = '0px'; ctx.fontStretch = 'normal';
      if (tw > avail) size *= avail / tw;
      txt(String(lap.time || ''), x + 88 + k, y + h * 0.5 + size * 0.36 + (1 - text) * 14, size, 700, W, 'left', 2, 'condensed');
      ctx.restore();
      ctx.restore();
      if (wipe < 1) {
        ctx.beginPath(); ctx.moveTo(ex + k, y); ctx.lineTo(ex, y + h);
        ctx.lineWidth = 4; ctx.strokeStyle = P; glow(P, 14); ctx.stroke(); noGlow();
      }
    }

    // LAP n blade, snapping in from the left
    if (blade > 0.001) {
      ctx.save();
      ctx.globalAlpha = clamp01(blade);
      ctx.translate(-(1 - blade) * 80, 0);
      ctx.beginPath(); ctx.moveTo(x + k, y); ctx.lineTo(x + 64 + k, y); ctx.lineTo(x + 64, y + h); ctx.lineTo(x, y + h); ctx.closePath();
      panel(y, h); ctx.fillStyle = P; ctx.fillRect(x, y + h - 3, 64, 3);
      txt('LAP', x + 32 + k / 2, y + 14, 9, 600, G, 'center', 3);
      txt(String(n), x + 32 + k / 3, y + 35, 20, 700, W, 'center', 0, 'condensed');
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // pod driver tag at W px wide onto an offscreen canvas (export)
  renderTag(W) {
    W = Math.max(8, Math.round(W));
    const cv = this.exportTagCv || (this.exportTagCv = document.createElement('canvas'));
    const H = Math.round(W * TAG_CH / TAG_CW);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    this.drawTag(cv);
    return cv;
  }

  drawTag(cv) {
    const ctx = cv.getContext('2d'), s = cv.width / TAG_CW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, TAG_M * s, TAG_M * s);
    this.podTag(ctx, 0, 0, TAG_W, TAG_H, podKit(ctx, s));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  layoutTag(w, h, D, OW, OH) {
    const tc = this.tagCv;
    if (!this.tagOn) { tc.style.display = 'none'; this.tagPos = null; return; }
    const s = D / POD_U, TW = Math.min(w, Math.round(TAG_CW * s)), TH = Math.round(TW * TAG_CH / TAG_CW), p = this.pic();
    const [ox, oy] = this.ovPos || [this.cfg.x, this.cfg.y];
    let x = this.cfg.tagX, y = this.cfg.tagY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (this.cfg.style === 'trace' && OW) { x = ox + (TW - OW) / 2 / w; y = oy + (OH + TH) / 2 / h; }
      else { x = ox + TAG_DX * s / w; y = oy + TAG_DY * s / h; }
    }
    x = Math.min(1 - TW / 2 / w, Math.max(TW / 2 / w, x));
    y = Math.min(1 - TH / 2 / h, Math.max(TH / 2 / h, y));
    this.tagPos = [x, y];
    const cs = tc.style;
    cs.display = 'block';
    cs.width = `${TW}px`; cs.height = `${TH}px`;
    cs.left = `${Math.round(p.x + x * w - TW / 2)}px`;
    cs.top = `${Math.round(p.y + y * h - TH / 2)}px`;
    cs.opacity = this.cfg.opacity;
    const pw = Math.round(TW * devicePixelRatio), ph = Math.round(TH * devicePixelRatio);
    if (tc.width !== pw || tc.height !== ph) { tc.width = pw; tc.height = ph; }
    this.drawTag(tc);
  }

  layout() {
    const on = !!(this.cfg.show && this.session);
    const p = this.pic(), w = p.w, h = p.h;
    this.lastA = this.aspect();
    for (const c of [this.canvas, this.tagCv, this.lapCv]) c.classList.toggle('locked', !!this.cfg.locked);
    const D = Math.round(Math.max(8, Math.min(w, h) * this.cfg.size));
    this.layoutLap(w, h);
    this.canvas.style.display = on ? 'block' : 'none';
    if (!on) { this.ovPos = null; this.layoutTag(); return; }
    const trace = this.cfg.style === 'trace';
    const W = trace ? Math.min(w, D * 1.8) : Math.min(D, w, h), H = trace ? Math.round(W * TRACE_H / TRACE_W) : W;
    // clamp inside the picture without changing the saved position, so resizing the window never moves it
    const x = Math.min(1 - W / 2 / w, Math.max(W / 2 / w, this.cfg.x)), y = Math.min(1 - H / 2 / h, Math.max(H / 2 / h, this.cfg.y));
    this.ovPos = [x, y];
    const cs = this.canvas.style;
    cs.width = `${W}px`; cs.height = `${H}px`;
    cs.left = `${Math.round(p.x + x * w - W / 2)}px`;
    cs.top = `${Math.round(p.y + y * h - H / 2)}px`;
    cs.opacity = this.cfg.opacity;
    const pw = Math.round(W * devicePixelRatio), ph = Math.round(H * devicePixelRatio);
    if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; }
    this.layoutTag(w, h, D, W, H);
    this.last = '';
    this.update(this.t);
  }

  aspect() { const A = this.getAspect(); return Number.isFinite(A) && A > 0 ? A : 16 / 9; }

  // the video picture inside the stage (letterboxed), in CSS px
  pic() {
    const sw = Math.max(1, this.stage.clientWidth), sh = Math.max(1, this.stage.clientHeight);
    const A = this.aspect(), w = Math.min(sw, sh * A), h = w / A;
    return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
  }

  value(k, t) {
    const i = this.idx[k];
    if (!(i >= 0) || !Number.isFinite(t)) return NaN;
    const s = this.session;
    if (k === 'gear' || k === 'drs' || k === 'pit') return s.cols[i][nearestIndex(s.t, t)];
    return interp(s.t, s.cols[i], t);
  }

  // highest rpm over the last 2 s, held only near the limiter (like the sim HUDs' shift needle)
  rpmPeak(t, rpm) {
    const i = this.idx.rpm;
    if (!(i >= 0) || !Number.isFinite(t) || !Number.isFinite(rpm)) return rpm;
    const s = this.session, col = s.cols[i], k0 = this.scale.rpmMin || 0, hold = k0 + 0.8 * (this.scale.rpm - k0);
    let m = rpm;
    for (let j = nearestIndex(s.t, t); j >= 0 && s.t[j] >= t - 2; j--) if (s.t[j] <= t && col[j] > m) m = col[j];
    return m >= hold ? m : rpm;
  }

  update(t) {
    this.t = t;
    if (!this.session || !this.cfg.show) return;
    const v = {
      speed: this.value('speed', t) * this.speedK,
      rpm: this.value('rpm', t),
      throttle: this.value('throttle', t) / this.scale.throttle,
      clutch: this.value('clutch', t) / this.scale.clutch,
      brake: this.value('brake', t) / this.scale.brake,
      gear: Math.round(this.value('gear', t)),
      drs: this.value('drs', t),
      pit: this.value('pit', t) > 0.5 || this.inPitZone(this.nowMs != null ? this.nowMs / 1000 : this.vt),
    };
    // pit limiter warnings flash
    const now = this.nowMs ?? performance.now();
    v.blink = v.pit && Math.floor(now / 350) % 2 === 1;
    v.peak = this.rpmPeak(t, v.rpm);
    // gear counter rolls to the new gear over ~0.15 s
    const dt = Math.min(0.1, (now - (this.gt || now)) / 1000);
    this.gt = now;
    if (Number.isFinite(v.gear)) {
      if (!Number.isFinite(this.gpos) || Math.abs(v.gear - this.gpos) > 3) this.gpos = v.gear;
      const d = v.gear - this.gpos;
      this.gpos = Math.abs(d) < 0.01 ? v.gear : this.gpos + d * Math.min(1, dt * 18);
    }
    v.gpos = this.gpos;
    const key = [Math.round(v.peak), Math.round(v.speed * 10), Math.round(v.rpm), Math.round(v.throttle * 400), Math.round(v.brake * 400), v.gear, v.drs, v.pit, v.blink, this.cfg.pitLimit, Math.round(v.clutch * 400), this.cfg.style === 'trace' ? Math.round(t * 60) : 0, Math.round(v.gpos * 100)].join();
    if (key === this.last) return;
    this.last = key;
    this.draw(v);
  }

  draw(v) {
    if (this.cfg.style === 'trace') { this.drawTrace(v); return; }
    const ctx = this.ctx, P = this.canvas.width, R = P / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, P, P);
    ctx.translate(R, R);
    ctx.scale(R, R); // unit circle coordinates
    const has = (k) => this.idx[k] >= 0;
    const arc = (r, w, a0, a1, color, ccw = false, cap = 'round') => {
      ctx.beginPath();
      ctx.arc(0, 0, r, a0 * DEG, a1 * DEG, ccw);
      ctx.lineWidth = w; ctx.lineCap = cap; ctx.strokeStyle = color; ctx.stroke();
    };
    if (this.cfg.style === 'classic') { this.drawClassic(v, has); return; }
    if (this.cfg.style === 'modern') { this.drawModern(v, has); return; }
    if (this.cfg.style === 'pod') { this.drawPod(v, has); return; }

    ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, 2 * Math.PI); ctx.fillStyle = C.disc; ctx.fill();
    // outer speed band runs from the first to the last scale badge; the badges sit on it
    const sc = this.scale.speed, fs = has('speed') ? clamp01(v.speed / sc.max) : 0;
    const RS = 0.918, WS = 0.15;
    // pit limiter: speed band turns amber, with a marker at the limit (drawn after the badges)
    const SPC = v.pit ? PIT : C.speed;
    arc(RS, WS, SPD_A0, SPD_A0 + SPD_SWEEP, C.track, false, 'round');
    if (has('speed') && fs > 0) {
      arc(RS, WS, SPD_A0, SPD_A0 + SPD_SWEEP * fs, SPC, false, 'butt');
      ctx.beginPath(); ctx.arc(Math.cos(SPD_A0 * DEG) * RS, Math.sin(SPD_A0 * DEG) * RS, WS / 2, 0, 2 * Math.PI); ctx.fillStyle = SPC; ctx.fill();
    }

    if (v.pit) this.pitMarker();
    // scale badges around the edge
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let s = 0; s <= sc.max + 1e-9; s += sc.step) {
      const f = s / sc.max, a = (SPD_A0 + SPD_SWEEP * f) * DEG, x = Math.cos(a) * RS, y = Math.sin(a) * RS;
      const lit = has('speed') && f <= fs + 1e-6;
      ctx.beginPath(); ctx.arc(x, y, 0.07, 0, 2 * Math.PI);
      ctx.fillStyle = C.disc; ctx.fill();
      ctx.lineWidth = 0.012; ctx.strokeStyle = lit ? '#7fd3ef' : '#55555b'; ctx.stroke();
      const txt = String(s);
      ctx.font = `600 ${txt.length > 2 ? 0.05 : 0.06}px ${FONT}`;
      ctx.fillStyle = lit ? C.text : C.muted;
      ctx.fillText(txt, x, y + 0.004);
    }

    // throttle (left/top) and brake (right) arcs with their names written inside
    const RI = 0.665, WI = 0.2;
    const ft = clamp01(v.throttle), fb = clamp01(v.brake);
    if (has('throttle')) {
      arc(RI, WI, THR_A0, THR_A1, C.track, false, 'butt');
      const end = THR_A0 + (THR_A1 - THR_A0) * ft;
      if (ft > 0.003) arc(RI, WI, THR_A0, end, C.throttle, false, 'butt');
      ctx.font = `700 ${0.11}px ${FONT}`;
      this.arcText('THROTTLE', RI, (THR_A0 + THR_A1) / 2, (a) => (a <= end ? C.text : C.muted));
    }
    if (has('brake')) {
      arc(RI, WI, BRK_A1, BRK_A0, C.track, false, 'butt');
      const end = BRK_A0 + (BRK_A1 - BRK_A0) * fb;
      if (fb > 0.003) arc(RI, WI, end, BRK_A0, C.brake, false, 'butt');
      ctx.font = `700 ${0.11}px ${FONT}`;
      this.arcText('BRAKE', RI, (BRK_A0 + BRK_A1) / 2, (a) => (a >= end ? C.text : C.muted));
    }

    const num = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '?');
    // centre stack: DRS, gear, rpm, speed - evenly spaced and centred on cap height
    const oy = has('drs') ? 0 : -0.05;
    if (has('drs')) {
      const on = v.drs > 0.5, bw = 0.32, bh = 0.11, cy = -0.45;
      ctx.beginPath(); ctx.roundRect(-bw / 2, cy - bh / 2, bw, bh, 0.022);
      ctx.fillStyle = on ? C.throttle : C.track; ctx.fill();
      this.spaced('DRS', 0, cy, 0.075, 700, on ? C.text : C.muted, 0.012);
    }
    // rolling gear counter: current gear big, neighbours smaller and faded, all on one centre line
    const gy = -0.2 + oy;
    if (has('gear') && Number.isFinite(v.gpos)) {
      ctx.save();
      ctx.beginPath(); ctx.rect(-0.44, gy - 0.18, 0.88, 0.36); ctx.clip();
      for (let k = Math.floor(v.gpos) - 2; k <= Math.ceil(v.gpos) + 2; k++) {
        const d = Math.abs(k - v.gpos), e = Math.min(1, d);
        const alpha = Math.max(0, 1 - 0.6 * e - 0.4 * Math.max(0, d - 1));
        if (alpha <= 0.02) continue;
        ctx.globalAlpha = alpha;
        this.ctext(k === 0 ? 'N' : k < 0 ? 'R' : String(k), (k - v.gpos) * 0.2 * (1 + 0.3 * e), gy, 0.36 - 0.17 * e, d < 0.5 ? 700 : 500, d < 0.5 ? C.text : C.muted);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    if (v.pit) this.pitDial(v, oy);
    else if (has('rpm')) {
      this.ctext(num(v.rpm), 0, 0.07 + oy, 0.15, 500, C.text);
      this.spaced('RPM', 0, 0.19 + oy, 0.072, 600, C.muted, 0.018);
    }
    this.ctext(has('speed') ? num(Math.max(0, v.speed)) : '?', 0, 0.43 + oy, 0.34, 700, this.pitColor(v, C.text));
    this.spaced(this.speedUnit === 'MPH' ? 'MPH' : 'KM/H', 0, 0.645 + oy, 0.072, 600, C.muted, 0.018);

    if (this.driverOn) this.plate(0, 0.8, 1.0);
  }

  // analog rev counter with Gear/Throttle/Brake boxes and a segmented speed bar (sim HUD, drawn in its 353x500 layout)
  drawClassic(v, has) {
    const ctx = this.ctx, drv = this.driverOn;
    const s = drv ? 2 / 560 : 2 / 500, k = (this.canvas.width / 2) * s;
    ctx.save();
    ctx.scale(s, s); ctx.translate(-176.5, drv ? -280 : -250);
    const BOX = '"Segoe UI", Arial, sans-serif';
    const shadow = (on) => {
      ctx.shadowColor = on ? 'rgba(0,0,0,.9)' : 'transparent';
      ctx.shadowOffsetX = ctx.shadowOffsetY = on ? 1.7 * k : 0; ctx.shadowBlur = on ? 1.2 * k : 0;
    };
    const label = (t, x, y, size, align = 'center') => {
      ctx.font = `700 ${size}px ${CFONT}`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
      shadow(true); ctx.fillStyle = '#fff'; ctx.fillText(t, x, y + size * 0.36); shadow(false);
      return ctx.measureText(t).width;
    };
    const BACK = 'rgba(0,0,0,.4)';

    // dark backing: rev dial (open in the centre, cut away under the boxes) and the J-shaped speed track
    const GX = 178, GY = 176;
    ctx.save();
    ctx.beginPath(); ctx.rect(-10, -10, 196, 520); ctx.rect(186, -10, 180, 232); ctx.clip();
    ctx.beginPath(); ctx.arc(GX, GY, 175, 0, 2 * Math.PI); ctx.arc(GX, GY, 80, 0, 2 * Math.PI, true);
    ctx.fillStyle = BACK; ctx.fill();
    ctx.restore();
    const SX = 184, SY = 332, RI = 71, RO = 116;
    ctx.beginPath();
    ctx.moveTo(SX + 61, 303); ctx.lineTo(SX + 167, 303); ctx.lineTo(SX + 167, SY);
    ctx.arc(SX, SY, 167, 0, Math.PI / 2); ctx.lineTo(0, 499); ctx.lineTo(0, 393); ctx.lineTo(SX, 393);
    ctx.arc(SX, SY, 61, Math.PI / 2, 0, true); ctx.closePath();
    ctx.fillStyle = BACK; ctx.fill();

    // rings, ticks and numbers: lowest rpm at the bottom, clockwise round to the right
    const k0 = (this.scale.rpmMin || 0) / 1000, k1 = this.scale.rpm / 1000, span = Math.max(1, k1 - k0);
    const ga = (f) => (90 + 270 * f) * DEG;
    ctx.strokeStyle = '#fff'; ctx.lineCap = 'butt';
    for (const [r, w] of [[92, 10], [103.5, 3], [112.5, 4.5]]) { ctx.beginPath(); ctx.arc(GX, GY, r, ga(0), ga(1)); ctx.lineWidth = w; ctx.stroke(); }
    const lstep = span <= 16 ? 1 : span <= 32 ? 2 : 5;
    for (let t = 0; t <= span + 1e-9; t += lstep) {
      const a = ga(t / span), c = Math.cos(a), sn = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(GX + c * 112, GY + sn * 112); ctx.lineTo(GX + c * 128, GY + sn * 128); ctx.lineWidth = 3; ctx.stroke();
      label(String(Math.round(k0 + t)), GX + c * 151, GY + sn * 151, 21);
    }

    // needles: red one holds the recent peak, white one shows the current rpm
    const fr = (x) => (has('rpm') ? clamp01((x / 1000 - k0) / span) : 0);
    const needle = (f, draw) => { ctx.save(); ctx.translate(GX, GY); ctx.rotate(ga(f)); draw(); ctx.restore(); };
    needle(fr(v.peak), () => { ctx.fillStyle = '#d40000'; ctx.fillRect(-30, -2, 147, 4); });
    needle(fr(v.rpm), () => {
      shadow(true);
      const bl = ctx.createLinearGradient(0, -8, 0, 8); bl.addColorStop(0, '#ffffff'); bl.addColorStop(0.55, '#f2f2f2'); bl.addColorStop(1, '#bdbdbd');
      ctx.beginPath(); ctx.moveTo(10, -8); ctx.lineTo(113, -1.2); ctx.lineTo(113, 1.2); ctx.lineTo(10, 8); ctx.closePath(); ctx.fillStyle = bl; ctx.fill();
      const tl = ctx.createLinearGradient(0, -12, 0, 12); tl.addColorStop(0, '#e8e8e8'); tl.addColorStop(0.5, '#ffffff'); tl.addColorStop(1, '#a8a8a8');
      ctx.beginPath(); ctx.moveTo(-8, -10); ctx.lineTo(-43, -12); ctx.lineTo(-43, 12); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fillStyle = tl; ctx.fill();
      const hb = ctx.createRadialGradient(-6, -6, 2, 0, 0, 20); hb.addColorStop(0, '#ffffff'); hb.addColorStop(0.6, '#e4e4e4'); hb.addColorStop(1, '#9a9a9a');
      ctx.beginPath(); ctx.arc(0, 0, 19, 0, 2 * Math.PI); ctx.fillStyle = hb; ctx.fill();
      shadow(false);
    });

    // Gear / Throttle / Brake boxes on the right
    const BX = 208, BW = 145;
    const gb = ctx.createLinearGradient(0, 183, 0, 223);
    gb.addColorStop(0, '#fdfdfd'); gb.addColorStop(0.78, '#eeeeee'); gb.addColorStop(0.86, '#c4c4c4'); gb.addColorStop(1, '#7a7a7a');
    ctx.fillStyle = gb; ctx.fillRect(BX, 183, BW, 40);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
    ctx.font = `600 27px ${BOX}`; ctx.textAlign = 'left'; ctx.fillText('Gear', 232, 212);
    const g = has('gear') && Number.isFinite(v.gear) ? (v.gear === 0 ? 'N' : v.gear < 0 ? 'R' : String(v.gear)) : '-';
    ctx.font = `700 27px ${CFONT}`; ctx.textAlign = 'center'; ctx.fillText(g, 329, 212);
    const box = (lbl, y, frac, c) => {
      ctx.fillStyle = BACK; ctx.fillRect(BX, y, BW, 40);
      if (frac > 0.003) {
        const gr = ctx.createLinearGradient(0, y, 0, y + 40);
        gr.addColorStop(0, c[0]); gr.addColorStop(0.1, c[0]); gr.addColorStop(0.16, c[1]); gr.addColorStop(0.82, c[1]); gr.addColorStop(1, c[2]);
        ctx.fillStyle = gr; ctx.fillRect(BX, y, BW * frac, 40);
      }
      ctx.font = `600 27px ${BOX}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      shadow(true); ctx.fillStyle = '#fff'; ctx.fillText(lbl, BX + BW / 2, y + 30); shadow(false);
    };
    box('Throttle', 223, has('throttle') ? clamp01(v.throttle) : 0, ['#7be87b', '#0ccc22', '#078a14']);
    box('Brake', 263, has('brake') ? clamp01(v.brake) : 0, ['#e88080', '#dc0000', '#8e0000']);

    // speed bar: 10 green bars along the bottom, 8 round the curve, 2 straight up the side
    const sc = this.scale.speed, N = 20, lit = has('speed') ? clamp01(v.speed / sc.max) * N : 0;
    const col = (i) => (i < 10 ? '0,236,46' : i < 13 ? '255,215,2' : i < 17 ? '254,153,14' : '234,0,0');
    for (let i = 0; i < N; i++) {
      ctx.fillStyle = `rgba(${col(i)},${i < Math.round(lit) ? 1 : 0.3})`;
      ctx.beginPath();
      if (i < 10) ctx.rect(16 + 17 * i, SY + RI, 12, RO - RI);
      else if (i < 18) {
        const j = i - 10, gp = 2.2, a0 = (90 - 11.25 * j - gp) * DEG, a1 = (90 - 11.25 * (j + 1) + gp) * DEG;
        ctx.arc(SX, SY, RO, a0, a1, true); ctx.arc(SX, SY, RI, a1, a0); ctx.closePath();
      } else ctx.rect(SX + RI, SY - 13 * (i - 18) - 11, RO - RI, 11);
      ctx.fill();
    }
    // scale numbers round the outside of the curve, live speed at the start of the bar
    let st = sc.step;
    while ((st / sc.max) * N < 2.4) st *= 2;
    for (let sp = st; sp <= sc.max + 1e-9; sp += st) {
      const idx = (sp / sc.max) * N;
      if (idx < 10) continue;
      if (idx <= 18) { const a = (90 - (idx - 10) * 11.25) * DEG; label(String(sp), SX + Math.cos(a) * 141, SY + Math.sin(a) * 141, 21); }
      else label(String(sp), SX + RO + 8, SY - 13 * (idx - 18), 21, 'left');
    }
    const w = label(has('speed') ? String(Math.round(Math.max(0, v.speed))) : '0', 16, 472, 24, 'left');
    label(this.speedUnit === 'MPH' ? 'mph' : 'km/h', 16 + w + 7, 472, 24, 'left');
    if (v.pit) this.pitClassic(v, shadow, BOX);
    ctx.restore();

    if (drv) this.classicTag(-176.5 * s, (508 - 280) * s, 353 * s, 40 * s);
  }

  // steering-wheel style display (drawn in its 320x320 layout): rev arc, yellow speed, rolling gears, pedal bars
  drawModern(v, has) {
    const ctx = this.ctx, drv = this.driverOn;
    const MF = 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif';
    const s = (drv ? 0.87 : 1) / 160;
    ctx.save();
    if (drv) ctx.translate(0, -0.09);
    ctx.scale(s, s); ctx.translate(-160, -160);
    const C = 160, A0 = 136, SW = 267.5, RED = 12 / 14;
    const text = (t, x, base, size, color, weight = 400, align = 'center') => {
      ctx.font = `${weight} ${size}px ${MF}`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = color; ctx.fillText(t, x, base);
    };

    // translucent black face and bezel, with a glossy grey band over the top of the bezel
    ctx.beginPath(); ctx.arc(C, C, 160, 0, 2 * Math.PI); ctx.arc(C, C, 135.5, 0, 2 * Math.PI, true); ctx.fillStyle = 'rgba(0,0,0,.8)'; ctx.fill();
    ctx.beginPath(); ctx.arc(C, C, 135.5, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(0,0,0,.76)'; ctx.fill();
    const hl = () => { ctx.beginPath(); ctx.arc(C, C, 158.5, 176 * DEG, 347.5 * DEG); ctx.arc(C, C, 136.5, 347.5 * DEG, 176 * DEG, true); ctx.closePath(); };
    ctx.globalCompositeOperation = 'destination-out'; hl(); ctx.fillStyle = '#000'; ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const cg = ctx.createConicGradient(176 * DEG, C, C);
    cg.addColorStop(0, 'rgba(88,88,88,.86)'); cg.addColorStop(86 / 360, 'rgba(32,32,32,.82)'); cg.addColorStop(171.5 / 360, 'rgba(104,104,104,.87)'); cg.addColorStop(1, 'rgba(88,88,88,.86)');
    hl(); ctx.fillStyle = cg; ctx.fill();

    // darker band behind the gear numbers, deepest in the middle
    ctx.save(); ctx.beginPath(); ctx.arc(C, C, 135.5, 0, 2 * Math.PI); ctx.clip();
    const gbd = ctx.createLinearGradient(0, 0, 320, 0);
    gbd.addColorStop(0.15, 'rgba(0,0,0,0)'); gbd.addColorStop(0.5, 'rgba(0,0,0,.72)'); gbd.addColorStop(0.85, 'rgba(0,0,0,0)');
    ctx.fillStyle = gbd; ctx.fillRect(0, 159, 320, 64);
    ctx.restore();

    // rev arc: fades inward from the rim; blue, red over the last seventh. Held at the peak near the limiter
    const k0 = (this.scale.rpmMin || 0) / 1000, k1 = this.scale.rpm / 1000, span = Math.max(1, k1 - k0);
    const fr = (x) => (has('rpm') ? clamp01((x / 1000 - k0) / span) : 0);
    const band = (f0, f1, rgb) => {
      if (f1 <= f0) return;
      const gr = ctx.createRadialGradient(C, C, 107, C, C, 134.5);
      gr.addColorStop(0, `rgba(${rgb},0)`); gr.addColorStop(1, `rgba(${rgb},1)`);
      ctx.beginPath(); ctx.arc(C, C, 134.5, (A0 + SW * f0) * DEG, (A0 + SW * f1) * DEG); ctx.arc(C, C, 107, (A0 + SW * f1) * DEG, (A0 + SW * f0) * DEG, true); ctx.closePath();
      ctx.fillStyle = gr; ctx.fill();
    };
    const fa = fr(Math.max(v.peak, v.rpm));
    band(0, Math.min(fa, RED), '0,73,207');
    band(RED, fa, '219,0,0');
    if (has('rpm')) {
      const a = (A0 + SW * fr(v.rpm)) * DEG;
      ctx.beginPath(); ctx.moveTo(C + Math.cos(a) * 107, C + Math.sin(a) * 107); ctx.lineTo(C + Math.cos(a) * 135, C + Math.sin(a) * 135);
      ctx.lineWidth = 3; ctx.lineCap = 'butt'; ctx.strokeStyle = '#dc0000'; ctx.stroke();
    }
    // white scale ring with inward ticks; numbers on the bezel
    ctx.beginPath(); ctx.arc(C, C, 135.5, A0 * DEG, (A0 + SW) * DEG); ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff'; ctx.stroke();
    const lstep = span <= 8 ? 1 : span <= 16 ? 2 : 5;
    for (let t = 0; t <= span + 1e-9; t += lstep) {
      const a = (A0 + SW * (t / span)) * DEG, c = Math.cos(a), sn = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(C + c * 120.5, C + sn * 120.5); ctx.lineTo(C + c * 136, C + sn * 136); ctx.lineWidth = 2; ctx.stroke();
      text(String(Math.round(k0 + t)), C + c * 147.5, C + sn * 147.5 + 7, 20, 'rgba(255,255,255,.55)');
    }

    // speed and unit
    text(has('speed') ? String(Math.round(Math.max(0, v.speed))) : '-', C, 122, 60, this.pitColor(v, '#f5ed3d'));
    text(this.speedUnit === 'MPH' ? 'mph' : 'km/h', C, 152, 21, 'rgba(255,255,255,.8)');

    // rolling gear numbers: current gear big and white, neighbours smaller and fading
    if (has('gear') && Number.isFinite(v.gpos)) {
      const lerp = (pts, d) => { const i = Math.min(pts.length - 2, Math.floor(d)), f = d - i; return pts[i] + (pts[i + 1] - pts[i]) * f; };
      ctx.save(); ctx.beginPath(); ctx.arc(C, C, 134, 0, 2 * Math.PI); ctx.clip();
      for (let g = Math.floor(v.gpos) - 3; g <= Math.ceil(v.gpos) + 3; g++) {
        const o = g - v.gpos, d = Math.min(3, Math.abs(o));
        const al = lerp([1, 0.7, 0.25, 0], d);
        if (al <= 0.01) continue;
        const size = lerp([66, 46, 40, 36], d);
        ctx.globalAlpha = al;
        text(g === 0 ? 'N' : g < 0 ? 'R' : String(g), C + Math.sign(o) * lerp([0, 43, 83, 120], d), 192 + size * 0.35, size, '#fff');
      }
      ctx.globalAlpha = 1; ctx.restore();
    }

    // glossy throttle / brake bars; text turns white where the bar is lit
    const pedal = (lbl, y, frac, off, on, gloss, dimText) => {
      const x = 100, w = 120, h = 27;
      const shape = () => { ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); };
      shape(); ctx.fillStyle = '#000'; ctx.fill();
      ctx.save(); shape(); ctx.clip();
      const og = ctx.createLinearGradient(0, y, 0, y + h); off.forEach((c, i) => og.addColorStop(i / (off.length - 1), c));
      ctx.fillStyle = og; ctx.fillRect(x, y, w, h);
      const lw = w * frac;
      if (lw > 0.3) {
        const lg = ctx.createLinearGradient(0, y, 0, y + h); on.forEach((c, i) => lg.addColorStop(i / (on.length - 1), c));
        ctx.fillStyle = lg; ctx.fillRect(x, y, lw, h);
      }
      // curved sheen across the top-left
      ctx.beginPath(); ctx.ellipse(x + w * 0.62, y - h * 1.15, w * 0.75, h * 1.9, 0, 0, 2 * Math.PI); ctx.fillStyle = gloss; ctx.fill();
      text(lbl, x + w / 2, y + 21, 20, dimText);
      ctx.beginPath(); ctx.rect(x, y, lw, h); ctx.clip();
      text(lbl, x + w / 2, y + 21, 20, '#fff');
      ctx.restore();
      shape(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.stroke();
    };
    if (has('throttle')) pedal('THROTTLE', 228, clamp01(v.throttle), ['#0d0d0d', '#000', '#000'], ['#2a7a24', '#026800', '#025e00', '#012b00'], 'rgba(255,255,255,.09)', '#959595');
    if (v.pit) this.pitModern(v, text);
    else if (has('brake')) pedal('BRAKE', 255, clamp01(v.brake), ['#1a0202', '#0a0000', '#000'], ['#7a0000', '#8c0000', '#6a0000', '#260000'], 'rgba(255,80,80,.12)', '#918080');
    ctx.restore();
    if (drv) this.classicTag(-0.68, 0.79, 1.36, 0.15, true);
  }

  // McLaren pod: carbon face, papaya rev ring, shift dots, pedal arcs, big centre gear and a papaya speed tile (drawn in its ~400 px layout)
  drawPod(v, has) {
    const ctx = this.ctx, { P, W, G, THR, BRK, BLU, PUR, AMB } = POD;
    const PX = this.canvas.width;
    // fit the pod into the square canvas (its driver tag is a separate canvas)
    const [bx0, by0, bx1, by1] = POD_BOX;
    const s = PX / POD_U;
    ctx.setTransform(s, 0, 0, s, PX / 2 - s * (bx0 + bx1) / 2, PX / 2 - s * (by0 + by1) / 2);
    const { glow, noGlow, txt, chamfer, panel } = podKit(ctx, s);
    const gs = (g) => (g < 0 ? 'R' : g === 0 ? 'N' : String(g));

    const cx = 200, cy = 196, R = 172, pit = v.pit, A0 = Math.PI * 0.75, SW = Math.PI * 1.5;
    const k0 = this.scale.rpmMin || 0, k1 = this.scale.rpm, f = has('rpm') ? clamp01((v.rpm - k0) / Math.max(1, k1 - k0)) : 0;
    const RED = 0.875;

    // bezel, carbon face
    ctx.beginPath(); ctx.arc(cx, cy, R + 7, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(6,7,9,0.92)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, R - 1, 0, 2 * Math.PI); panel(cy - R, 2 * R);

    // rev ring: papaya -> white -> blue, amber on the limiter
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(cx, cy, R - 14, A0, A0 + SW); ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke();
    if (f > 0) {
      let g = AMB;
      if (!pit) { g = ctx.createConicGradient(A0, cx, cy); g.addColorStop(0, P); g.addColorStop(0.6, P); g.addColorStop(0.68, W); g.addColorStop(0.75, BLU); g.addColorStop(1, BLU); }
      ctx.beginPath(); ctx.arc(cx, cy, R - 14, A0, A0 + SW * f); ctx.strokeStyle = g; glow(pit ? AMB : P, 14); ctx.stroke(); noGlow();
    }

    // ticks every 500 rpm, numbers (thousands) on a readable step
    const span = (k1 - k0) / 1000, lstep = span <= 8 ? 1 : span <= 16 ? 2 : 5;
    for (let t = 0; t <= span + 1e-9; t += 0.5) {
      const fr = t / span, a = A0 + SW * fr, major = Math.abs(t - Math.round(t)) < 1e-6;
      const r1 = R - 24, r2 = R - (major ? 35 : 29), c = Math.cos(a), sn = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(cx + c * r1, cy + sn * r1); ctx.lineTo(cx + c * r2, cy + sn * r2);
      ctx.strokeStyle = fr >= RED - 1e-6 ? BRK : 'rgba(255,255,255,0.35)'; ctx.lineWidth = major ? 2 : 1; ctx.stroke();
      if (major && Math.round(t) % lstep === 0) txt(String(Math.round(k0 / 1000 + t)), cx + c * (R - 48), cy + sn * (R - 48) + 5, 14, 600, fr >= 0.8 ? W : G, 'center', 0, 'condensed');
    }

    // shift lights across the top: 3 green, 3 red, 3 purple (all amber, flashing, on the limiter)
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (1.355 + 0.29 * i / 8), x = cx + Math.cos(a) * (R - 74), y = cy + Math.sin(a) * (R - 74);
      const on = pit ? !v.blink : has('rpm') && f >= 0.76 + i * 0.025, col = pit ? AMB : i < 3 ? THR : i < 6 ? BRK : PUR;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fillStyle = on ? col : 'rgba(255,255,255,0.1)';
      if (on) glow(col, 10);
      ctx.fill(); noGlow();
    }

    // pedal arcs filling from the bottom up
    const pr = R - 74;
    const ped = (from, to, val, col) => {
      val = clamp01(val);
      ctx.lineWidth = 8; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.arc(cx, cy, pr, Math.min(from, to), Math.max(from, to)); ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke();
      if (val > 0) {
        ctx.beginPath();
        if (to > from) ctx.arc(cx, cy, pr, from, from + (to - from) * val); else ctx.arc(cx, cy, pr, from - (from - to) * val, from);
        ctx.strokeStyle = col; glow(col, 8); ctx.stroke(); noGlow();
      }
    };
    if (has('throttle')) ped(Math.PI * 0.8, Math.PI * 1.3, v.throttle, THR);
    if (has('brake')) ped(Math.PI * 2.2, Math.PI * 1.7, v.brake, BRK);

    // rpm on top, rolling gear in the middle (neighbours ghosted either side)
    txt(has('rpm') ? String(Math.round(Math.max(0, v.rpm))) : '-', cx, cy - 62, 24, 600, W, 'center', 1, 'condensed');
    txt('RPM', cx, cy - 46, 10, 600, P, 'center', 4);
    if (has('gear') && Number.isFinite(v.gpos)) {
      const lerp = (a, b, t) => a + (b - a) * t;
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, pr - 6, 0, 2 * Math.PI); ctx.clip();
      for (let g = Math.floor(v.gpos) - 2; g <= Math.ceil(v.gpos) + 2; g++) {
        const o = g - v.gpos, d = Math.abs(o);
        if (d >= 2) continue;
        const t = Math.min(1, d), al = d <= 1 ? lerp(1, 0.22, t) : lerp(0.22, 0, d - 1);
        ctx.globalAlpha = al;
        txt(gs(g), cx + Math.sign(o) * (52 * t + 40 * Math.max(0, d - 1)), lerp(cy + 50, cy + 30, t), lerp(112, 40, t), 700, W, 'center', 0, 'condensed');
      }
      ctx.globalAlpha = 1; ctx.restore();
    }
    // speed in the open space at the bottom of the face (amber in the pit lane, red over the limit)
    txt(has('speed') ? String(Math.round(Math.max(0, v.speed))) : '-', cx, cy + 120, 46, 700, this.pitColor(v, W), 'center', 1, 'condensed');
    txt(this.speedUnit === 'MPH' ? 'MPH' : 'KM/H', cx + 2, cy + 137, 10, 600, P, 'center', 4);
    if (pit) {
      chamfer(cx - 36, cy + 144, 72, 18, 5, 5); ctx.fillStyle = v.blink ? '#6b4a00' : AMB;
      if (!v.blink) glow(AMB, 12);
      ctx.fill(); noGlow();
      txt('PIT ' + this.cfg.pitLimit, cx + 1, cy + 157, 12, 700, '#111', 'center', 3);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // pod driver tag: carbon blade with the speedmark, carbon name plate, flag filling the slanted right end, papaya underlines
  podTag(ctx, x, y, w, h, kit) {
    const { P, W } = POD, k = h * 0.35, { panel, txt } = kit, cfg = this.cfg;
    ctx.beginPath(); ctx.moveTo(x + k, y); ctx.lineTo(x + 64 + k, y); ctx.lineTo(x + 64, y + h); ctx.lineTo(x, y + h); ctx.closePath();
    panel(y, h); ctx.fillStyle = P; ctx.fillRect(x, y + h - 3, 64, 3);
    if (MARK.complete && MARK.naturalWidth) {
      const mw = 38, mh = mw * 283 / 505;
      ctx.drawImage(MARK, 0, 112, 505, 283, x + 32 + k / 2 - mw / 2, y + (h - 3) / 2 - mh / 2, mw, mh);
    }
    const plate = () => { ctx.beginPath(); ctx.moveTo(x + 70 + k, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - k, y + h); ctx.lineTo(x + 70, y + h); ctx.closePath(); };
    plate(); panel(y, h);
    ctx.fillStyle = P; ctx.fillRect(x + 70, y + h - 3, w - 70 - k, 3);

    // flag fills the right end of the plate, cut on the same slant as the plate
    const img = cfg.flag === 'IMG' && this.flagImg && this.flagImg.complete && this.flagImg.naturalWidth ? this.flagImg : null;
    const hasFlag = img || FLAGS[cfg.flag];
    const FW = 60, fh = h - 3, kb = k * fh / h, fx = x + w - FW;
    if (hasFlag) {
      ctx.save();
      ctx.beginPath(); ctx.moveTo(fx, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - kb, y + fh); ctx.lineTo(fx - kb, y + fh); ctx.closePath(); ctx.clip();
      const bx = fx - kb, bw = FW + kb;
      if (img) {
        const sc = Math.max(bw / img.naturalWidth, fh / img.naturalHeight), iw = img.naturalWidth * sc, ih = img.naturalHeight * sc;
        ctx.fillStyle = '#fff'; ctx.fillRect(bx, y, bw, fh);
        ctx.drawImage(img, bx + (bw - iw) / 2, y + (fh - ih) / 2, iw, ih);
      } else drawFlag(ctx, cfg.flag, bx, y, bw, fh);
      // blend into the carbon: soft shade from the left edge and a top sheen
      const lg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      lg.addColorStop(0, 'rgba(0,0,0,0.55)'); lg.addColorStop(0.35, 'rgba(0,0,0,0.1)'); lg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lg; ctx.fillRect(bx, y, bw, fh);
      const vg = ctx.createLinearGradient(0, y, 0, y + fh);
      vg.addColorStop(0, 'rgba(255,255,255,0.18)'); vg.addColorStop(0.45, 'rgba(255,255,255,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.3)');
      ctx.fillStyle = vg; ctx.fillRect(bx, y, bw, fh);
      ctx.restore();
      // papaya slanted divider between name and flag
      ctx.beginPath(); ctx.moveTo(fx, y); ctx.lineTo(fx - kb, y + fh); ctx.lineWidth = 2.5; ctx.strokeStyle = P; ctx.stroke();
      plate(); ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    const nx = x + 88 + k, avail = (hasFlag ? fx - kb - 12 : x + w - k - 16) - nx;
    const name = String(cfg.name || '').trim().toUpperCase() || 'DRIVER';
    let size = h * 0.5;
    ctx.font = `600 ${size}px ${POD.F}`; ctx.fontStretch = 'semi-condensed'; ctx.letterSpacing = '3px';
    const tw = ctx.measureText(name).width;
    ctx.letterSpacing = '0px'; ctx.fontStretch = 'normal';
    if (tw > avail) size *= avail / tw;
    txt(name, nx, y + h * 0.5 + size * 0.38, size, 600, W, 'left', 3 * size / (h * 0.5), 'semi-condensed');
  }

  // McLaren pedal trace (540 x 130 layout): carbon blade with the speedmark, slanted carbon plate with a rolling
  // throttle/brake/clutch trace and slanted pedal bars, and a round pod badge (rev ring, shift lights, gear, speed)
  drawTrace(v) {
    const ctx = this.ctx, k = this.canvas.width / TRACE_W, t = this.t, has = (key) => this.idx[key] >= 0;
    const { P, W, G, THR, BRK, BLU, PUR, AMB } = POD, CLU = '#FFD21F', pit = v.pit;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const { glow, noGlow, txt, panel } = podKit(ctx, k);
    const SL = 0.35, Y0 = 16, Y1 = 114, off = SL * (Y1 - Y0), CX = 474, CY = 65, CR = 58;
    const para = (xb, y0, y1, w) => {
      const o = SL * (y1 - y0);
      ctx.beginPath(); ctx.moveTo(xb + o, y0); ctx.lineTo(xb + o + w, y0); ctx.lineTo(xb + w, y1); ctx.lineTo(xb, y1); ctx.closePath();
    };

    // plate (its right end runs under the badge)
    const PL = 0;
    ctx.beginPath(); ctx.moveTo(PL + off, Y0); ctx.lineTo(CX, Y0); ctx.lineTo(CX, Y1); ctx.lineTo(PL, Y1); ctx.closePath();
    panel(Y0, Y1 - Y0);
    ctx.fillStyle = P; ctx.fillRect(PL, Y1 - 3, CX - PL, 3);

    // trace window: slanted left edge and slanted grid
    const TY0 = 24, TY1 = 104, XL = PL + 10, X1 = 308, wo = SL * (TY1 - TY0);
    ctx.save();
    ctx.beginPath(); ctx.moveTo(XL + wo, TY0); ctx.lineTo(X1, TY0); ctx.lineTo(X1, TY1); ctx.lineTo(XL, TY1); ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.32)'; ctx.fill(); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = XL; x <= X1 + wo; x += 24) { ctx.moveTo(x + wo, TY0); ctx.lineTo(x, TY1); }
    for (let i = 1; i < 4; i++) { const y = Math.round(TY0 + (TY1 - TY0) * i / 4) + 0.5; ctx.moveTo(XL, y); ctx.lineTo(X1, y); }
    ctx.stroke();
    const N = 160, sess = this.session, yOf = (val) => TY1 - 4 - val * (TY1 - TY0 - 8);
    // min: samples below this are left out (clutch under 1% is hidden)
    const trace = (key, sc, color, min = -1) => {
      if (!has(key) || !Number.isFinite(t)) return null;
      ctx.beginPath();
      let pen = false, last = null;
      for (let i = 0; i <= N; i++) {
        const tt = t - TRACE_SECS + (TRACE_SECS * i) / N;
        if (tt < sess.t[0] || tt > sess.t[sess.t.length - 1]) { pen = false; continue; }
        const val = clamp01(this.value(key, tt) / sc);
        if (val < min) { pen = false; if (i === N) last = null; continue; }
        const x = XL + ((X1 - XL) * i) / N, y = yOf(val);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
        if (i === N) last = y;
      }
      ctx.lineWidth = 2.6; ctx.lineJoin = ctx.lineCap = 'round'; ctx.strokeStyle = color; glow(color, 6); ctx.stroke(); noGlow();
      return last;
    };
    const ends = [
      [trace('clutch', this.scale.clutch, CLU, 0.01), CLU],
      [trace('brake', this.scale.brake, BRK), BRK],
      [trace('throttle', this.scale.throttle, THR), THR],
    ];
    ctx.restore();
    // pit limiter: flashing amber PIT tag in the top-left of the trace window
    if (pit) {
      const px = XL + wo + 4, py = TY0 + 4, pw = 64, phh = 17;
      para(px - SL * phh, py, py + phh, pw);
      ctx.fillStyle = v.blink ? '#6b4a00' : AMB; if (!v.blink) glow(AMB, 10); ctx.fill(); noGlow();
      txt('PIT ' + this.cfg.pitLimit, px - SL * phh / 2 + pw / 2, py + phh / 2 + 4.5, 13, 700, '#111', 'center', 1, 'condensed');
    }
    // live dots at the right edge of the trace
    for (const [y, c] of ends) {
      if (y == null) continue;
      ctx.beginPath(); ctx.arc(X1, y, 3.4, 0, 2 * Math.PI); ctx.fillStyle = c; glow(c, 8); ctx.fill(); noGlow();
    }

    // slanted pedal bars: clutch, brake, throttle with their % on top
    const bar = (key, frac, x, color) => {
      const by0 = 36, by1 = 106, bw = 17, on = has(key) && Number.isFinite(frac);
      para(x, by0, by1, bw); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
      const p = on ? Math.round(clamp01(frac) * 100) : 0;
      if (p > 0) {
        const top = by1 - (by1 - by0) * clamp01(frac);
        ctx.save(); para(x, by0, by1, bw); ctx.clip();
        const g = ctx.createLinearGradient(0, by1, 0, top);
        g.addColorStop(0, color); g.addColorStop(1, color);
        ctx.fillStyle = g; glow(color, 8); ctx.fillRect(x - 5, top, bw + 40, by1 - top); noGlow();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x - 5, top, bw + 40, 1.5);
        ctx.restore();
      }
      txt(on ? String(p) : '-', x + bw / 2 + SL * (by1 - by0), 31, 13, 600, p > 0 ? W : G, 'center', 0, 'condensed');
    };
    bar('clutch', v.clutch, 316, CLU);
    bar('brake', v.brake, 340, BRK);
    bar('throttle', v.throttle, 364, THR);

    // badge
    ctx.beginPath(); ctx.arc(CX, CY, CR + 4, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(6,7,9,0.94)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(CX, CY, CR - 1, 0, 2 * Math.PI); panel(CY - CR, 2 * CR);
    const A0 = Math.PI * 0.75, SW = Math.PI * 1.5, k0 = this.scale.rpmMin || 0;
    const f = has('rpm') ? clamp01((v.rpm - k0) / Math.max(1, this.scale.rpm - k0)) : 0;
    ctx.lineCap = 'butt'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(CX, CY, CR - 8, A0, A0 + SW); ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke();
    if (f > 0) {
      let g = AMB;
      if (!pit) { g = ctx.createConicGradient(A0, CX, CY); g.addColorStop(0, P); g.addColorStop(0.6, P); g.addColorStop(0.68, W); g.addColorStop(0.75, BLU); g.addColorStop(1, BLU); }
      ctx.beginPath(); ctx.arc(CX, CY, CR - 8, A0, A0 + SW * f); ctx.strokeStyle = g; glow(pit ? AMB : P, 10); ctx.stroke(); noGlow();
    }
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (1.33 + 0.34 * i / 8), x = CX + Math.cos(a) * (CR - 20), y = CY + Math.sin(a) * (CR - 20);
      const on = pit ? !v.blink : has('rpm') && f >= 0.76 + i * 0.025, col = pit ? AMB : i < 3 ? THR : i < 6 ? BRK : PUR;
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 2 * Math.PI); ctx.fillStyle = on ? col : 'rgba(255,255,255,0.1)';
      if (on) glow(col, 6);
      ctx.fill(); noGlow();
    }
    const gr = has('gear') && Number.isFinite(v.gear) ? (v.gear === 0 ? 'N' : v.gear < 0 ? 'R' : String(v.gear)) : '-';
    txt(gr, CX, CY + 16, 50, 700, W, 'center', 0, 'condensed');
    txt(has('speed') ? String(Math.round(Math.max(0, v.speed))) : '-', CX, CY + 40, 19, 700, this.pitColor(v, W), 'center', 0, 'condensed');
    txt(this.speedUnit === 'MPH' ? 'MPH' : 'KM/H', CX + 1, CY + 50, 7, 600, P, 'center', 2.5);
  }
  // ---- pit limiter ----
  // speed colour: amber in the pit lane, red when over the limit
  pitColor(v, normal) {
    if (!v.pit) return normal;
    return Number.isFinite(v.speed) && v.speed > this.cfg.pitLimit + 0.5 ? PIT_OVER : PIT;
  }

  // dial: white marker on the speed ring at the limit (under the badges)
  pitMarker() {
    const ctx = this.ctx, lim = this.cfg.pitLimit;
    const a = (SPD_A0 + SPD_SWEEP * clamp01(lim / this.scale.speed.max)) * DEG, c = Math.cos(a), sn = Math.sin(a);
    ctx.beginPath(); ctx.moveTo(c * 0.83, sn * 0.83); ctx.lineTo(c, sn); ctx.lineWidth = 0.022; ctx.lineCap = 'butt'; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.save(); ctx.translate(c * 0.79, sn * 0.79); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0.04, 0); ctx.lineTo(-0.03, -0.035); ctx.lineTo(-0.03, 0.035); ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
  }

  // dial: PIT LIMITER / LIMIT n in place of rpm
  pitDial(v, oy) {
    const lim = this.cfg.pitLimit;
    this.spaced('PIT LIMITER', 0, 0.06 + oy, 0.075, 700, v.blink ? PIT_DIM : PIT, 0.016);
    this.spaced('LIMIT ' + lim, 0, 0.17 + oy, 0.062, 600, C.muted, 0.016);
  }

  // amber box in place of the Throttle box, flashing while the limiter is on
  pitClassic(v, shadow, BOX) {
    const ctx = this.ctx, y = 223, gr = ctx.createLinearGradient(0, y, 0, y + 40);
    const c = v.blink ? ['#d9b45c', '#a87400', '#5e4100'] : ['#ffe08a', '#ffb300', '#b07800'];
    gr.addColorStop(0, c[0]); gr.addColorStop(0.1, c[0]); gr.addColorStop(0.16, c[1]); gr.addColorStop(0.82, c[1]); gr.addColorStop(1, c[2]);
    ctx.fillStyle = gr; ctx.fillRect(208, y, 145, 40);
    ctx.font = `600 27px ${BOX}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    shadow(true); ctx.fillStyle = '#fff'; ctx.fillText('Pit Limiter', 280.5, y + 30); shadow(false);
  }

  // glossy amber bar in place of the Brake bar, flashing while the limiter is on
  pitModern(v, text) {
    const ctx = this.ctx, x = 100, y = 255, w = 120, h = 27;
    const shape = () => { ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); };
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    (v.blink ? ['#5c4200', '#4a3500', '#3a2900', '#1c1400'] : ['#ffc94a', '#ffb300', '#e09a00', '#7a5200']).forEach((c, i) => g.addColorStop(i / 3, c));
    ctx.save(); shape(); ctx.fillStyle = g; ctx.fill(); ctx.clip();
    ctx.beginPath(); ctx.ellipse(x + w * 0.62, y - h * 1.15, w * 0.75, h * 1.9, 0, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fill();
    ctx.restore();
    shape(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.stroke();
    text('PIT LIMITER', x + w / 2, y + 21, 19, v.blink ? '#ffb300' : '#111');
  }

  // the chosen flag (built-in or custom image) in a small framed box; false if there's no flag
  flagBox(fx, fy, fw, fh) {
    const ctx = this.ctx, cfg = this.cfg;
    const img = cfg.flag === 'IMG' && this.flagImg && this.flagImg.complete && this.flagImg.naturalWidth ? this.flagImg : null;
    if (!img && !FLAGS[cfg.flag]) return false;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(fx, fy, fw, fh, 0.008); ctx.clip();
    if (img) {
      ctx.fillStyle = '#fff'; ctx.fillRect(fx, fy, fw, fh);
      const k = Math.max(fw / img.naturalWidth, fh / img.naturalHeight), iw = img.naturalWidth * k, ih = img.naturalHeight * k;
      ctx.drawImage(img, fx + (fw - iw) / 2, fy + (fh - ih) / 2, iw, ih);
    } else drawFlag(ctx, cfg.flag, fx, fy, fw, fh);
    ctx.restore();
    ctx.lineWidth = 0.005; ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.roundRect(fx, fy, fw, fh, 0.008); ctx.stroke();
    return true;
  }

  // driver tag for the classic gauge, styled like its Gear/Throttle/Brake tags
  classicTag(x0, y0, W, H, modern = false) {
    const ctx = this.ctx, cfg = this.cfg, acc = cfg.accent || DEFAULTS.accent;
    ctx.beginPath(); ctx.roundRect(x0, y0, W, H, modern ? 0.03 : 0.012);
    if (modern) {
      const g = ctx.createLinearGradient(0, y0, 0, y0 + H); g.addColorStop(0, '#26262b'); g.addColorStop(1, '#0a0a0c');
      ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 0.014; ctx.strokeStyle = '#4a4a50'; ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
      ctx.lineWidth = 0.008; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.stroke();
    }
    ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y0, W, H, 0.012); ctx.clip();
    ctx.fillStyle = acc; ctx.fillRect(x0, y0, modern ? 0.04 : 0.03, H);
    ctx.restore();
    const cy = y0 + H / 2;
    let x = x0 + 0.05;
    const num = String(cfg.number || '').trim();
    if (num) {
      ctx.font = `700 0.09px ${CFONT}`;
      const bw = Math.max(0.11, ctx.measureText(num).width + 0.05), bh = H - 0.04;
      ctx.beginPath(); ctx.roundRect(x, cy - bh / 2, bw, bh, 0.01); ctx.fillStyle = '#f2f2f2'; ctx.fill();
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(num, x + bw / 2, cy + CAP * 0.09);
      x += bw + 0.03;
    }
    const fh = H - 0.05, fw = fh * 1.5;
    if (this.flagBox(x, cy - fh / 2, fw, fh)) x += fw + 0.03;
    let name = String(cfg.name || '').trim() || 'Driver';
    if (modern) name = name.toUpperCase();
    const avail = x0 + W - 0.04 - x;
    let size = 0.1;
    ctx.font = `700 ${size}px ${CFONT}`;
    const w0 = ctx.measureText(name).width;
    if (w0 > avail) { size *= avail / w0; ctx.font = `700 ${size}px ${CFONT}`; }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 0.012 * this.canvas.width / 2;
    ctx.fillText(name, x, cy + CAP * size);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  }

  // text centred on (x, yc) by its cap height
  ctext(text, x, yc, size, weight, color) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(text, x, yc + CAP * size);
  }

  // letter-spaced label centred on (x, yc); returns its width
  spaced(text, x, yc, size, weight, color, sp, align = 'center', italic = false) {
    const ctx = this.ctx;
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    const ws = [...text].map((ch) => ctx.measureText(ch).width);
    const tw = ws.reduce((a, b) => a + b, 0) + sp * (ws.length - 1);
    let px = align === 'center' ? x - tw / 2 : x;
    [...text].forEach((ch, i) => { ctx.fillText(ch, px, yc + CAP * size); px += ws[i] + sp; });
    return tw;
  }

  // slanted name plate across the bottom of the dial: accent stripe, number, flag, name
  plate(pcx, cy, W) {
    const ctx = this.ctx, cfg = this.cfg, acc = cfg.accent || DEFAULTS.accent;
    const h = 0.17, sl = 0.055, x0 = pcx - W / 2 - sl, x1 = pcx + W / 2 - sl, y0 = cy - h / 2, y1 = cy + h / 2;
    const para = (a, b) => { ctx.beginPath(); ctx.moveTo(a + sl, y0); ctx.lineTo(b + sl, y0); ctx.lineTo(b - sl, y1); ctx.lineTo(a - sl, y1); ctx.closePath(); };
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 0.04 * this.canvas.width / 2; ctx.shadowOffsetY = 0.01 * this.canvas.width / 2;
    para(x0, x1);
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#2a2a2e'); g.addColorStop(1, '#141416');
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
    ctx.save();
    para(x0, x1); ctx.clip();
    // accent stripes on the left and a thin accent line along the bottom
    para(x0 - 0.02, x0 + 0.035); ctx.fillStyle = acc; ctx.fill();
    para(x0 + 0.05, x0 + 0.065); ctx.fill();
    ctx.fillRect(x0 - sl, y1 - 0.012, W + 2 * sl, 0.012);
    ctx.restore();
    ctx.lineWidth = 0.006; ctx.strokeStyle = 'rgba(255,255,255,.12)'; para(x0, x1); ctx.stroke();

    let x = x0 + 0.11;
    const num = String(cfg.number || '').trim();
    if (num) {
      ctx.font = `italic 800 0.13px ${FONT}`;
      const w = Math.max(0.08, ctx.measureText(num).width);
      ctx.fillStyle = acc; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(num, x, cy + CAP * 0.13);
      x += w + 0.035;
    }
    const fh = 0.09, fw = fh * 1.5;
    if (this.flagBox(x, cy - fh / 2, fw, fh)) {
      x += fw + 0.035;
    }
    const name = String(cfg.name || '').trim().toUpperCase() || 'DRIVER';
    const avail = x1 - 0.06 - x;
    let size = 0.1;
    ctx.font = `italic 800 ${size}px ${FONT}`;
    const meas = (sz) => { ctx.font = `italic 800 ${sz}px ${FONT}`; return [...name].reduce((a, ch) => a + ctx.measureText(ch).width, 0) + sz * 0.12 * (name.length - 1); };
    const w0 = meas(size);
    if (w0 > avail) size *= avail / w0;
    const tw = meas(size);
    // centre the name in the space that's left
    this.spaced(name, x + Math.max(0, (avail - tw) / 2), cy, size, 800, C.text, size * 0.12, 'left', true);
  }

  // text running clockwise along an arc, centred on angle `at` (deg), letter tops facing outwards
  arcText(text, r, at, color) {
    const ctx = this.ctx;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const sp = 0.008, widths = [...text].map((ch) => ctx.measureText(ch).width + sp);
    let a = at * DEG - widths.reduce((x, y) => x + y, 0) / r / 2;
    [...text].forEach((ch, i) => {
      const da = widths[i] / r, m = a + da / 2;
      ctx.fillStyle = color(m / DEG);
      ctx.save();
      ctx.translate(Math.cos(m) * r, Math.sin(m) * r);
      ctx.rotate(m + Math.PI / 2);
      ctx.fillText(ch, 0, 0.004);
      ctx.restore();
      a += da;
    });
  }
}

// side panel: channel pickers and display options. Settings are remembered.
export function initOverlayPanel(overlay) {
  let cfg = { ...DEFAULTS };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }
  cfg.map = { ...(cfg.map || {}) };
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));
  overlay.onChange = () => { save(); render(); };

  const panel = $('overlayPanel'), btn = $('btnOverlay');
  const show = (on) => {
    panel.hidden = !on;
    btn.classList.toggle('on', on);
    overlay.setLapPreview('panel', on);
  };
  btn.addEventListener('click', () => show(panel.hidden));

  const box = $('ovChannels');
  for (const sl of SLOTS) {
    const lab = document.createElement('label');
    lab.className = 'ch';
    lab.append(sl.label);
    const sel = document.createElement('select');
    sel.id = `ov_${sl.key}`;
    sel.addEventListener('change', () => {
      cfg.map[sl.key] = sel.value === '-1' ? '' : overlay.session.names[+sel.value];
      apply();
    });
    lab.append(sel);
    box.append(lab);
  }

  const render = () => {
    $('ovShow').checked = cfg.show;
    $('ovStyle').value = cfg.style || 'dial';
    $('ovSize').value = Math.round(cfg.size * 100);
    $('ovSizeV').textContent = `${Math.round(cfg.size * 100)}%`;
    $('ovOpacity').value = Math.round(cfg.opacity * 100);
    $('ovOpacityV').textContent = `${Math.round(cfg.opacity * 100)}%`;
    $('ovSpeedMax').value = cfg.speedMax > 0 ? cfg.speedMax : '';
    $('ovSpeedMax').placeholder = `Auto (${overlay.scale.speed ? overlay.scale.speed.max : '–'})`;
    $('ovPitLimit').value = cfg.pitLimit;
    $('ovDriver').checked = cfg.driver;
    $('ovDriverBox').classList.toggle('off', !cfg.driver);
    if (document.activeElement !== $('ovName')) $('ovName').value = cfg.name;
    if (document.activeElement !== $('ovNum')) $('ovNum').value = cfg.number;
    $('ovAccent').value = cfg.accent;
    $('ovFlag').value = cfg.flag === 'IMG' && !cfg.flagImg ? '' : cfg.flag;
    $('ovLap').checked = cfg.lapShow !== false;
    $('ovLapSize').value = Math.round((cfg.lapSize || cfg.size) * 100);
    $('ovLapSizeV').textContent = `${Math.round((cfg.lapSize || cfg.size) * 100)}%`;
    const lk = !!cfg.locked;
    $('ovLock').checked = lk;
    for (const id of ['ovSize', 'ovLapSize', 'ovLapPos', 'ovReset']) $(id).disabled = lk;
    $('ovDragHint').textContent = lk ? 'Locked: unlock to move or resize the overlay.' : 'Drag the dial to move it, scroll over it to resize.';
    renderTemplates();
  };
  // templates: the look, positions, sizes, driver details and lock (not the channel mapping, which depends on the data file)
  const loadTpls = () => { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}'); } catch { return {}; } };
  const renderTemplates = () => {
    const tpls = loadTpls(), names = Object.keys(tpls).sort((a, b) => a.localeCompare(b));
    const sel = $('ovTpl');
    sel.replaceChildren(new Option(names.length ? '(choose…)' : '(none saved)', ''), ...names.map((n) => new Option(n, n)));
    sel.value = names.includes(cfg.template) ? cfg.template : '';
    $('ovTplDel').disabled = $('ovTplExport').disabled = !sel.value;
    if (document.activeElement !== $('ovTplName')) $('ovTplName').value = sel.value;
  };
  const fillSelects = () => {
    const s = overlay.session, idx = overlay.idx;
    for (const sl of SLOTS) {
      const sel = $(`ov_${sl.key}`);
      const opts = [new Option('(none)', '-1')];
      if (s) s.names.forEach((n, i) => opts.push(new Option(s.units[i] ? `${n} [${s.units[i]}]` : n, String(i))));
      sel.replaceChildren(...opts);
      sel.value = String(s && idx[sl.key] >= 0 ? idx[sl.key] : -1);
      sel.disabled = !s;
    }
  };
  const apply = () => {
    save();
    overlay.setConfig(cfg);
    fillSelects();
    render();
  };

  $('ovStyle').addEventListener('change', (e) => { cfg.style = e.target.value; apply(); });
  $('ovShow').addEventListener('change', (e) => { cfg.show = e.target.checked; apply(); });
  $('ovSize').addEventListener('input', (e) => { cfg.size = +e.target.value / 100; apply(); });
  $('ovOpacity').addEventListener('input', (e) => { cfg.opacity = +e.target.value / 100; apply(); });
  $('ovSpeedMax').addEventListener('change', (e) => { cfg.speedMax = Math.max(0, +e.target.value || 0); apply(); });
  $('ovPitLimit').addEventListener('change', (e) => { cfg.pitLimit = +e.target.value > 0 ? +e.target.value : 80; apply(); });
  $('ovLap').addEventListener('change', (e) => { cfg.lapShow = e.target.checked; apply(); });
  $('ovLapSize').addEventListener('input', (e) => { cfg.lapSize = +e.target.value / 100; apply(); });
  $('ovLapPos').addEventListener('click', () => { delete cfg.lapX; delete cfg.lapY; apply(); });
  $('ovLock').addEventListener('change', (e) => { cfg.locked = e.target.checked; apply(); });
  $('ovTpl').addEventListener('change', (e) => {
    const name = e.target.value, t = loadTpls()[name];
    if (!t) { render(); return; }
    // a template replaces the look and layout and locks it, so each export comes out the same
    cfg = { ...DEFAULTS, ...t, map: cfg.map, template: name, locked: true };
    apply();
  });
  const saveTpl = () => {
    const name = $('ovTplName').value.trim();
    if (!name) { $('ovTplName').focus(); return; }
    const tpls = loadTpls();
    const { map, template, ...look } = cfg;
    tpls[name] = JSON.parse(JSON.stringify(look));
    localStorage.setItem(TPL_KEY, JSON.stringify(tpls));
    cfg.template = name;
    $('ovTplName').blur();
    apply();
  };
  $('ovTplSave').addEventListener('click', saveTpl);
  $('ovTplName').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') saveTpl(); });
  $('ovTplDel').addEventListener('click', () => {
    const name = $('ovTpl').value;
    if (!name || !confirm(`Delete the overlay template "${name}"?`)) return;
    const tpls = loadTpls();
    delete tpls[name];
    localStorage.setItem(TPL_KEY, JSON.stringify(tpls));
    delete cfg.template;
    apply();
  });
  // template files: { "360SyncTemplates": 1, templates: { name: look } }
  $('ovTplExport').addEventListener('click', async () => {
    const name = $('ovTpl').value, t = loadTpls()[name];
    if (!t) return;
    const text = JSON.stringify({ '360SyncTemplates': 1, templates: { [name]: t } }, null, 1);
    await window.native.saveText(`${name.replace(/[\\/:*?"<>|]+/g, '_')}.360tpl`, '360Sync overlay template', '360tpl', text).catch((e) => alert(`Couldn't save the template: ${e.message}`));
  });
  $('ovTplImport').addEventListener('click', () => $('ovTplFile').click());
  $('ovTplFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let got;
    try {
      const j = JSON.parse(await f.text());
      got = j && j['360SyncTemplates'] && j.templates;
      if (!got || typeof got !== 'object') throw new Error('not a 360Sync template file');
    } catch (err) { alert(`Couldn't import ${f.name}: ${err.message}`); return; }
    const tpls = loadTpls(), added = [];
    for (const [name, look] of Object.entries(got)) {
      if (!look || typeof look !== 'object' || Array.isArray(look)) continue;
      if (tpls[name] && !confirm(`A template called "${name}" already exists. Replace it?`)) continue;
      const { map, template, ...clean } = look;
      tpls[name] = clean;
      added.push(name);
    }
    if (!added.length) return;
    localStorage.setItem(TPL_KEY, JSON.stringify(tpls));
    // apply it straight away when the file held a single template
    if (added.length === 1) { const s = $('ovTpl'); renderTemplates(); s.value = added[0]; s.dispatchEvent(new Event('change')); }
    else { render(); alert(`Imported ${added.length} templates: ${added.join(', ')}`); }
  });
  $('ovReset').addEventListener('click', () => {
    // keep the driver details, they're not display settings
    const { driver, name, number, flag, flagImg, accent } = cfg;
    cfg = { ...DEFAULTS, map: {}, driver, name, number, flag, flagImg, accent };
    apply();
  });

  const flagSel = $('ovFlag');
  const opts = [new Option('(none)', ''), new Option('Custom image', 'IMG')];
  Object.entries(FLAGS).sort((a, b) => a[1][0].localeCompare(b[1][0])).forEach(([k, [n]]) => opts.push(new Option(n, k)));
  flagSel.replaceChildren(...opts);
  $('ovDriver').addEventListener('change', (e) => { cfg.driver = e.target.checked; apply(); });
  $('ovName').addEventListener('input', (e) => { cfg.name = e.target.value; apply(); });
  $('ovNum').addEventListener('input', (e) => { cfg.number = e.target.value; apply(); });
  $('ovAccent').addEventListener('input', (e) => { cfg.accent = e.target.value; apply(); });
  flagSel.addEventListener('change', () => {
    if (flagSel.value === 'IMG' && !cfg.flagImg) { $('ovFlagFile').click(); render(); return; }
    cfg.flag = flagSel.value; apply();
  });
  $('ovFlagImg').addEventListener('click', () => $('ovFlagFile').click());
  $('ovFlagFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    // shrink to a small PNG so it fits comfortably in saved settings
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => {
      const k = Math.min(1, 120 / img.naturalHeight), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cfg.flagImg = cv.toDataURL('image/png'); cfg.flag = 'IMG';
      apply();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  });
  apply();
  show(false);

  return {
    // new telemetry file loaded
    setSession(s) { overlay.setSession(s); fillSelects(); render(); },
    // projects
    getConfig: () => JSON.parse(JSON.stringify(cfg)),
    setConfig(c) { cfg = { ...DEFAULTS, ...(c || {}) }; cfg.map = { ...(cfg.map || {}) }; apply(); },
  };
}
