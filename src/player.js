import { Pano } from './pano.js';

const DEFAULT_VIEW = { lon: 0, lat: 0, fov: 90 };

// Video display. Sources:
//   <video> element – flat (shown directly) or equirectangular 360 (rendered through Pano)
//   InsvSource      – Insta360 dual fisheye, stitched live; flat mode shows the unwrapped panorama
export class Player {
  constructor(stage, video) {
    this.stage = stage;
    this.video = video;
    this.insv = null;
    this.is360 = false;
    this.viewKey = '';
    this.locked = false;
    this.onLockChange = null;
    Object.assign(this, DEFAULT_VIEW);

    const cv = (this.canvas = document.createElement('canvas'));
    cv.className = 'pano';
    cv.style.display = 'none';
    stage.appendChild(cv);
    this.pano = new Pano(cv);
    this.dirty = true;
    this.lastIdx = -1e9;

    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.is360 || this.locked) return;
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, lon: this.lon, lat: this.lat };
      this.dragging = true;
      cv.classList.add('dragging');
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = this.fov / cv.clientHeight;
      this.lon = drag.lon + (drag.x - e.clientX) * k;
      this.lat = Math.max(-89, Math.min(89, drag.lat + (e.clientY - drag.y) * k));
    });
    const end = () => { if (drag) this.saveView(); drag = null; this.dragging = false; cv.classList.remove('dragging'); };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
    cv.addEventListener('wheel', (e) => {
      if (!this.is360) return;
      e.preventDefault();
      if (this.locked) return;
      this.fov = Math.max(20, Math.min(140, this.fov + e.deltaY * 0.05));
      this.saveView();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { if (!this.locked) this.resetView(); });

    const markVideo = () => { this.vDirty = true; };
    if ('requestVideoFrameCallback' in video) {
      const cb = () => { this.vDirty = true; video.requestVideoFrameCallback(cb); };
      video.requestVideoFrameCallback(cb);
    }
    for (const ev of ['loadeddata', 'seeked', 'timeupdate']) video.addEventListener(ev, markVideo);

    new ResizeObserver(() => this.resize()).observe(stage);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // after an export borrowed the stitcher: put the live picture back
  restore() {
    this.exporting = false;
    this.resize();
    this.vDirty = true;
    this.lastIdx = -1e9;
    if (this.insv) this.insv.refresh();
  }

  setVideo(name) {
    this.insv = null;
    this.pano.setEquirect();
    this.loadView(name);
    this.apply();
  }

  setInsv(src, name) {
    this.insv = src;
    this.lastIdx = -1e9;
    this.pano.setDualFisheye(src.lensU, src.layout === 'sbs');
    this.loadView(name);
    this.apply();
  }

  // stitching / image settings from the side panel
  setStitch(o) {
    this.pano.set(o);
    if (this.insv && this.insv.shownIdx >= 0) for (let k = 0; k < 3; k++) this.pano.estimate(1);
    this.dirty = true;
  }

  set360(on) {
    this.is360 = on;
    this.apply();
  }

  apply() {
    const canvasOn = this.is360 || !!this.insv;
    this.canvas.style.display = canvasOn ? 'block' : 'none';
    this.canvas.classList.toggle('flat', !this.is360);
    this.video.style.visibility = canvasOn ? 'hidden' : 'visible';
    this.vDirty = true;
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.stage.clientWidth), h = Math.max(1, this.stage.clientHeight);
    const cs = this.canvas.style;
    if (this.is360) {
      // the 360 view is a 16:9 picture, letterboxed in the stage
      const vw = Math.min(w, (h * 16) / 9), vh = (vw * 9) / 16;
      Object.assign(cs, { left: `${(w - vw) / 2}px`, top: `${(h - vh) / 2}px`, width: `${vw}px`, height: `${vh}px` });
      this.pano.resize(vw, vh);
    } else {
      Object.assign(cs, { left: '0', top: '0', width: '100%', height: '100%' });
      const pw = Math.min(w, h * 2);
      this.pano.resize(pw, pw / 2);
    }
    this.dirty = true;
  }

  loadView(name) {
    this.viewKey = name ? `view:${name}` : '';
    let v = null;
    // per-file view, else the last view used (cameras tend to stay on the same mount)
    try { v = JSON.parse(localStorage.getItem(this.viewKey) || localStorage.getItem('view:last') || 'null'); } catch { /* ignore */ }
    Object.assign(this, DEFAULT_VIEW, v || {});
    // the lock belongs to the file's own saved view, not the shared last view
    let own = null;
    try { own = JSON.parse(localStorage.getItem(this.viewKey) || 'null'); } catch { /* ignore */ }
    this.locked = !!(own && own.locked);
    this.canvas.classList.toggle('locked', this.locked);
    if (this.onLockChange) this.onLockChange(this.locked);
  }
  // lock the 360 orientation and zoom in place
  setLocked(on) {
    this.locked = !!on;
    this.canvas.classList.toggle('locked', this.locked);
    this.saveView();
    if (this.onLockChange) this.onLockChange(this.locked);
  }
  saveView() {
    const v = JSON.stringify({ lon: this.lon, lat: this.lat, fov: this.fov, locked: this.locked });
    if (this.viewKey) localStorage.setItem(this.viewKey, v);
    localStorage.setItem('view:last', v);
  }
  resetView() {
    if (this.locked) return;
    Object.assign(this, DEFAULT_VIEW);
    this.saveView();
  }
  // restore a saved view (projects)
  setView(v) {
    if (!v) return;
    for (const k of ['lon', 'lat', 'fov']) if (Number.isFinite(v[k])) this[k] = v[k];
    this.setLocked(!!v.locked);
  }

  loop() {
    requestAnimationFrame(this.loop);
    // the exporter drives the stitcher itself while it runs
    if (this.exporting || this.canvas.style.display === 'none') return;
    if (this.insv) {
      if (this.insv.update(this.pano)) {
        // refine the seam stitch on every new frame; jump straight to it when paused or after a seek
        const idx = this.insv.shownIdx;
        const fresh = !this.insv.playing || Math.abs(idx - this.lastIdx) > 2;
        this.lastIdx = idx;
        for (let k = fresh ? 3 : 1; k > 0; k--) this.pano.estimate(fresh ? 1 : 0.35);
        this.dirty = true;
      }
    } else if (this.vDirty && this.video.readyState >= 2) {
      this.vDirty = false;
      this.pano.upload(0, this.video);
      this.dirty = true;
    }
    const view = `${this.lon},${this.lat},${this.fov},${this.is360}`;
    if (!this.dirty && view === this.lastView) return;
    this.dirty = false;
    this.lastView = view;
    this.pano.render({ lon: this.lon, lat: this.lat, fov: this.fov, out: this.is360 ? 'view' : 'equirect' });
  }
}
