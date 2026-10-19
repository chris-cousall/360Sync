import { lowerBound, interp, nearestIndex, fmtTime } from './telemetry.js';

const COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4dd0e1', '#f06292', '#aed581', '#90a4ae'];
const AXIS_H = 24;
const RIGHT_W = 60;

function niceStep(span, target) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
}

function fmtVal(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return v.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3);
}

function fmtDist(m) {
  return Math.abs(m) >= 10000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export class Chart {
  constructor(canvas, { onScrub }) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onScrub = onScrub;
    this.s = null;
    this.channels = [];
    this.mode = 'time';
    this.cursorT = 0;
    this.x0 = 0;
    this.x1 = 1;
    this.ranges = new Map();
    this.w = 1;
    this.h = 1;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bind();
  }

  static color(i) { return COLORS[i % COLORS.length]; }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = `${this.w}px`;
    this.cv.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  get pw() { return Math.max(1, this.w - RIGHT_W); }

  xArr() { return this.mode === 'distance' && this.s.dist ? this.s.dist : this.s.t; }
  tToX(t) { return this.mode === 'distance' && this.s.dist ? interp(this.s.t, this.s.dist, t) : t; }
  xToT(x) { return this.mode === 'distance' && this.s.dist ? interp(this.s.dist, this.s.t, x) : x; }
  extent() { const X = this.xArr(); return [X[0], X[X.length - 1]]; }

  setSession(s) {
    this.s = s;
    this.ranges.clear();
    if (this.mode === 'distance' && !s.dist) this.mode = 'time';
    this.fit();
  }

  setChannels(ch) { this.channels = ch; this.requestDraw(); }

  setMode(mode) {
    if (!this.s) { this.mode = mode; return; }
    const ta = this.xToT(this.x0), tb = this.xToT(this.x1);
    this.mode = mode === 'distance' && this.s.dist ? 'distance' : 'time';
    this.x0 = this.tToX(ta);
    this.x1 = this.tToX(tb);
    if (!(this.x1 > this.x0)) this.fit(); else this.requestDraw();
  }

  fit() {
    if (!this.s) return this.requestDraw();
    [this.x0, this.x1] = this.extent();
    if (!(this.x1 > this.x0)) this.x1 = this.x0 + 1;
    this.requestDraw();
  }

  setCursor(t) {
    this.cursorT = t;
    if (this.s && !this.drag) {
      const [a, b] = this.extent();
      const x = this.tToX(t);
      const span = this.x1 - this.x0;
      if ((x > this.x1 || x < this.x0) && x >= a && x <= b) {
        this.x0 = x - span * 0.1;
        this.x1 = this.x0 + span;
      }
    }
    this.requestDraw();
  }

  requestDraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  range(c) {
    let r = this.ranges.get(c);
    if (!r) {
      let mn = Infinity, mx = -Infinity;
      for (const v of this.s.cols[c]) { if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!Number.isFinite(mn)) { mn = 0; mx = 1; }
      const pad = (mx - mn) * 0.08 || 1;
      r = [mn - pad, mx + pad];
      this.ranges.set(c, r);
    }
    return r;
  }

  bind() {
    const cv = this.cv;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (!this.s) return;
      cv.setPointerCapture(e.pointerId);
      const pan = e.button === 1 || e.button === 2 || e.shiftKey;
      this.drag = { pan, sx: e.offsetX, x0: this.x0, x1: this.x1 };
      if (!pan) this.scrubAt(e.offsetX);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      if (this.drag.pan) {
        const dx = ((e.offsetX - this.drag.sx) / this.pw) * (this.drag.x1 - this.drag.x0);
        this.x0 = this.drag.x0 - dx;
        this.x1 = this.drag.x1 - dx;
        this.requestDraw();
      } else this.scrubAt(e.offsetX);
    });
    const end = () => { this.drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
    cv.addEventListener('dblclick', () => this.fit());
    cv.addEventListener('wheel', (e) => {
      if (!this.s) return;
      e.preventDefault();
      const span = this.x1 - this.x0;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dx = (e.deltaX / this.pw) * span;
        this.x0 += dx;
        this.x1 += dx;
      } else {
        const [a, b] = this.extent();
        const xm = this.x0 + (Math.min(e.offsetX, this.pw) / this.pw) * span;
        let ns = span * Math.pow(1.0015, e.deltaY);
        ns = Math.min(Math.max(ns, (b - a) / 1e5, 1e-3), (b - a) * 1.2 || 1);
        this.x0 = xm - (xm - this.x0) * (ns / span);
        this.x1 = this.x0 + ns;
      }
      this.requestDraw();
    }, { passive: false });
  }

  scrubAt(px) {
    const x = this.x0 + (Math.min(Math.max(px, 0), this.pw) / this.pw) * (this.x1 - this.x0);
    const t = this.xToT(x);
    this.cursorT = t;
    this.requestDraw();
    this.onScrub(t);
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#15171c';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '12px Segoe UI, system-ui, sans-serif';
    if (!this.s) {
      ctx.fillStyle = '#6b7280';
      ctx.textAlign = 'center';
      ctx.fillText('Drop a telemetry CSV here, or click “Open Data” (MoTeC i2 / ATLAS / Pi Toolbox CSV export)', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const pw = this.pw;
    const ph = h - AXIS_H;
    const X = this.xArr();
    const { x0, x1 } = this;
    const sx = pw / (x1 - x0);
    const i0 = Math.max(0, lowerBound(X, x0) - 1);
    const i1 = Math.min(X.length - 1, lowerBound(X, x1));
    const isDist = this.mode === 'distance';

    // vertical grid + axis labels
    const step = niceStep(x1 - x0, Math.max(2, pw / 110));
    ctx.strokeStyle = '#242832';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8a90a0';
    ctx.beginPath();
    for (let g = Math.ceil(x0 / step) * step; g <= x1; g += step) {
      const px = Math.round((g - x0) * sx) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, ph);
      ctx.fillText(isDist ? fmtDist(g) : fmtTime(g).replace(/0+$/, '').replace(/\.$/, ''), px + 3, ph + 16);
    }
    ctx.stroke();

    const chans = this.channels;
    const lh = ph / Math.max(1, chans.length);
    const ci = nearestIndex(this.s.t, this.cursorT);

    chans.forEach((c, li) => {
      const top = li * lh;
      const col = this.s.cols[c];
      const [lo, hi] = this.range(c);
      const sy = (lh - 6) / (hi - lo);
      const yOf = (v) => top + 3 + (hi - v) * sy;

      ctx.strokeStyle = '#2c313c';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(top + lh) + 0.5);
      ctx.lineTo(w, Math.round(top + lh) + 0.5);
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, pw, lh);
      ctx.clip();
      ctx.strokeStyle = Chart.color(li);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      if (i1 - i0 > pw * 2) {
        // min/max per pixel column keeps big logs fast and spike-accurate
        const nb = Math.ceil(pw) + 2;
        const mins = new Float64Array(nb).fill(Infinity);
        const maxs = new Float64Array(nb).fill(-Infinity);
        for (let i = i0; i <= i1; i++) {
          const b = Math.min(nb - 1, Math.max(0, Math.floor((X[i] - x0) * sx) + 1));
          const v = col[i];
          if (v < mins[b]) mins[b] = v;
          if (v > maxs[b]) maxs[b] = v;
        }
        let started = false;
        for (let b = 0; b < nb; b++) {
          if (mins[b] === Infinity) continue;
          const px = b - 1;
          if (!started) { ctx.moveTo(px, yOf(mins[b])); started = true; } else ctx.lineTo(px, yOf(mins[b]));
          ctx.lineTo(px, yOf(maxs[b]));
        }
      } else {
        for (let i = i0; i <= i1; i++) {
          const px = (X[i] - x0) * sx;
          if (i === i0) ctx.moveTo(px, yOf(col[i])); else ctx.lineTo(px, yOf(col[i]));
        }
      }
      ctx.stroke();
      ctx.restore();

      const unit = this.s.units[c] ? ` ${this.s.units[c]}` : '';
      const label = `${this.s.names[c]}   ${fmtVal(col[ci])}${unit}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(21,23,28,0.8)';
      ctx.fillRect(4, top + 3, tw + 10, 17);
      ctx.fillStyle = Chart.color(li);
      ctx.fillText(label, 9, top + 16);
      ctx.fillStyle = '#6b7280';
      ctx.fillText(fmtVal(hi), pw + 6, top + 13);
      ctx.fillText(fmtVal(lo), pw + 6, top + lh - 5);
    });

    if (!chans.length) {
      ctx.fillStyle = '#6b7280';
      ctx.textAlign = 'center';
      ctx.fillText('Tick channels on the left to plot them', pw / 2, ph / 2);
      ctx.textAlign = 'left';
    }

    // cursor
    const cx = (this.tToX(this.cursorT) - x0) * sx;
    if (cx >= 0 && cx <= pw) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, 0);
      ctx.lineTo(Math.round(cx) + 0.5, ph);
      ctx.stroke();
      let lbl = fmtTime(this.cursorT);
      if (this.s.dist) lbl += `  ·  ${fmtDist(interp(this.s.t, this.s.dist, this.cursorT))}`;
      const tw = ctx.measureText(lbl).width + 10;
      const lx = Math.min(Math.max(cx - tw / 2, 0), pw - tw);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(lx, ph + 2, tw, AXIS_H - 4);
      ctx.fillStyle = '#111317';
      ctx.fillText(lbl, lx + 5, ph + 16);
    }
  }
}
