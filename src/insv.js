// Native Insta360 .insv playback: demux the MP4, decode both fisheye streams with WebCodecs
// (hardware HEVC/H.264) and hand matching frame pairs to the Pano stitcher.
// Exposes a small <video>-like API (currentTime, duration, paused, play, pause, playbackRate, muted).
import { demux, readInstaMeta } from './mp4.js';
import { rangeReader } from './fileread.js';
import { lensUniforms, GENERIC_LENSES } from './pano.js';

const AHEAD = 6;       // decoded frames kept ahead of the playhead, per lens
const MAX_LAG = 45;    // frames behind the clock before we skip ahead to a keyframe

export class InsvSource extends EventTarget {
  static async open(file) {
    if (!('VideoDecoder' in window)) throw new Error('WebCodecs is not available');
    const read = rangeReader(file);
    const [tracks, meta] = await Promise.all([demux(read, file.size), readInstaMeta(read, file.size).catch(() => null)]);
    const vids = tracks.filter((t) => t.handler === 'vide' && t.n > 1);
    let layout;
    if (vids.length >= 2 && vids[0].width === vids[1].width) layout = 'tracks';
    else if (vids.length >= 1 && Math.abs(vids[0].width / vids[0].height - 2) < 0.05) layout = 'sbs';
    else if (vids.length === 1) throw new Error('This .insv holds only one lens (the other is in the matching _10_ file). Re-record in a single-file mode or export from Insta360 Studio.');
    else throw new Error('No Insta360 video tracks found');
    const use = layout === 'tracks' ? vids.slice(0, 2) : vids.slice(0, 1);
    const cfg = use.map((t) => ({ codec: t.codec, codedWidth: t.width, codedHeight: t.height, description: t.description, hardwareAcceleration: 'prefer-hardware' }));
    const sup = await VideoDecoder.isConfigSupported(cfg[0]);
    if (!sup.supported) throw new Error(`This PC can't decode ${use[0].codec} at ${use[0].width}×${use[0].height} (needs hardware HEVC support)`);
    const atrack = tracks.find((t) => t.handler === 'soun' && t.n > 0 && t.codec);
    return new InsvSource(file, read, use, cfg, layout, meta, atrack);
  }

  constructor(file, read, tracks, cfg, layout, meta, atrack) {
    super();
    this.atrack = atrack || null;
    this.file = file;
    this.read = read;
    this.tracks = tracks;
    this.cfg = cfg;
    this.layout = layout;
    this.model = (meta && meta.model) || 'Insta360';
    this.calibrated = !!(meta && meta.lenses);
    const t0 = tracks[0];
    this.width = t0.width;
    this.height = t0.height;
    this.lensU = lensUniforms(this.calibrated ? meta.lenses : GENERIC_LENSES, t0.width, t0.height, layout);
    this.n = Math.min(...tracks.map((t) => t.n));
    this.ts = t0.timescale;
    this.dts = t0.dts;
    const d = this.dts[1] - this.dts[0];
    this.frameDur = d / this.ts;
    this.duration = (this.dts[this.n - 1] + d) / this.ts;
    this.keys = [];
    for (let i = 0; i < this.n; i++) if (tracks.every((t) => t.key[i])) this.keys.push(i);
    if (!this.keys.length || this.keys[0] !== 0) this.keys.unshift(0);

    this._t = 0;
    this._rate = 1;
    this.playing = false;
    this.q = tracks.map(() => []);
    this.shownIdx = -1;
    this.pos = 0;
    this.gen = 0;
    this.needReset = true;
    this.closed = false;
    this.decs = tracks.map((_, k) => this.makeDecoder(k));

    this.url = URL.createObjectURL(file);
    this.initAudio();
    this.pump();
  }

  makeDecoder(k) {
    const dec = new VideoDecoder({
      output: (f) => {
        const i = f.timestamp;
        // paused: only frames at/after the seek target matter; playing: anything newer than what's on screen
        const stale = this.playing ? i <= this.shownIdx : i < this.targetIdx();
        if (this.closed || stale) { f.close(); return; }
        this.q[k].push(f);
        this.wake();
      },
      error: () => { this.needReset = true; this.wake(); },
    });
    dec.configure(this.cfg[k]);
    dec.addEventListener('dequeue', () => this.wake());
    return dec;
  }

  // Audio: AAC decoded with WebCodecs and scheduled on an AudioContext, whose clock is also the master clock
  // (falls back to performance.now if there is no audio).
  initAudio() {
    this.sources = new Set();
    this.agen = 0;
    try {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.ctx.onstatechange = () => {
        if (!this.playing || this.closed || this.clkCtx === (this.ctx.state === 'running')) return;
        const t = this.currentTime;
        this.startClock(t);
        this.startAudio();
      };
    } catch { this.ctx = null; return; }
    const at = this.atrack;
    if (!at || !at.codec || !('AudioDecoder' in window)) return;
    this.acfg = { codec: at.codec, sampleRate: at.sampleRate, numberOfChannels: at.channels, description: at.description };
    AudioDecoder.isConfigSupported(this.acfg).then((s) => {
      if (!s.supported || this.closed) return;
      this.adec = new AudioDecoder({ output: (d) => this.scheduleAudio(d), error: () => { this.adec = null; } });
      this.adec.configure(this.acfg);
      if (this.playing) this.startAudio();
    }).catch(() => {});
  }

  // the AudioContext clock while it runs, else performance.now; startClock picks one and sticks with it
  // (mixing them would freeze or jump the time), and a statechange restarts the clock on the other
  clock() {
    if (this.clkCtx && this.ctx) {
      const ts = this.ctx.getOutputTimestamp();
      if (ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      return this.ctx.currentTime;
    }
    return performance.now() / 1000;
  }

  startClock(t) {
    this._t = this.base = t;
    this.clkCtx = !!(this.ctx && this.ctx.state === 'running');
    this.c0 = this.clock();
  }

  startAudio() {
    this.stopAudio();
    if (!this.adec || !this.playing || !this.clkCtx || this._rate > 4) return;
    const at = this.atrack;
    const v = this.base * at.timescale;
    let lo = 0, hi = at.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (at.dts[m] <= v) lo = m; else hi = m - 1; }
    this.apos = Math.max(0, lo - 2);   // AAC needs a couple of frames of pre-roll
    this.aEnd = 0;
    this.audioPump(this.agen);
  }

  stopAudio() {
    this.agen++;
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    this.sources.clear();
    if (this.adec && this.adec.state === 'configured') { this.adec.reset(); this.adec.configure(this.acfg); }
  }

  async audioPump(gen) {
    const at = this.atrack;
    while (gen === this.agen && this.playing && !this.closed && this.adec && this.apos < at.n) {
      if (this.aEnd - this.ctx.currentTime > 1.0 || this.adec.decodeQueueSize > 64) { await new Promise((r) => setTimeout(r, 200)); continue; }
      const i0 = this.apos, cnt = Math.min(48, at.n - i0);
      this.apos += cnt;
      const lo = at.offset[i0], hi = at.offset[i0 + cnt - 1] + at.size[i0 + cnt - 1];
      let buf = null;
      if (hi - lo < 4 << 20) { try { buf = await this.read(lo, hi - lo); } catch { /* retry below */ } }
      for (let i = i0; i < i0 + cnt && gen === this.agen; i++) {
        const o = at.offset[i] - lo;
        const data = buf && o >= 0 && o + at.size[i] <= buf.length ? buf.subarray(o, o + at.size[i]) : await this.read(at.offset[i], at.size[i]);
        if (gen !== this.agen || !this.adec) break;
        this.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((at.dts[i] / at.timescale) * 1e6), data }));
      }
      // keep the decoder producing: it holds output until more input or a flush
      if (this.apos >= at.n && gen === this.agen && this.adec) this.adec.flush().catch(() => {});
    }
  }

  scheduleAudio(d) {
    const ctx = this.ctx;
    if (!this.playing || this.closed || !ctx) { d.close(); return; }
    const rate = this._rate, now = ctx.currentTime;
    const dur = d.numberOfFrames / d.sampleRate;
    let when = this.c0 + (d.timestamp / 1e6 - this.base) / rate;
    if (when + dur / rate <= now + 0.005) { d.close(); return; }
    const ab = ctx.createBuffer(d.numberOfChannels, d.numberOfFrames, d.sampleRate);
    const tmp = new Float32Array(d.numberOfFrames);
    for (let c = 0; c < d.numberOfChannels; c++) {
      d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      ab.copyToChannel(tmp, c);
    }
    d.close();
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.playbackRate.value = rate;
    src.connect(this.gain);
    let off = 0;
    if (when < now) { off = (now - when) * rate; when = now; }
    src.start(when, off);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    this.aEnd = Math.max(this.aEnd, when + (dur - off) / rate);
  }

  // ---- <video>-like API ----
  get src() { return this.url; }
  get paused() { return !this.playing; }
  get currentTime() {
    if (!this.playing) return this._t;
    return Math.min(this.duration, this.base + Math.max(0, this.clock() - this.c0) * this._rate);
  }
  set currentTime(t) { this.seek(t); }
  get playbackRate() { return this._rate; }
  set playbackRate(r) {
    const t = this.currentTime;
    this._rate = r;
    if (this.playing) { this.startClock(t); this.startAudio(); }
  }
  get muted() { return !!this._muted; }
  set muted(m) {
    this._muted = !!m;
    if (this.gain) this.gain.gain.value = m ? 0 : 1;
  }

  play() {
    if (this.playing) return;
    if (this._t >= this.duration - this.frameDur) this.seek(0);
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    this.playing = true;
    this.startClock(this._t);
    this.startAudio();
    this.dispatchEvent(new Event('play'));
    this.wake();
  }

  pause() {
    if (!this.playing) return;
    this._t = this.currentTime;
    this.playing = false;
    this.stopAudio();
    // snap to the frame on screen so stepping/sync are frame-exact
    if (this.shownIdx >= 0) this._t = this.dts[this.shownIdx] / this.ts;
    this.dispatchEvent(new Event('pause'));
  }

  seek(t) {
    t = Math.min(Math.max(+t || 0, 0), this.duration);
    this._t = t;
    if (this.playing) { this.startClock(t); this.startAudio(); }
    const idx = this.indexAt(t);
    // short forward hops (frame stepping, normal scrubbing) continue the current decode run
    if (!(idx >= this.shownIdx && idx <= this.pos + 15)) this.needReset = true;
    this.wake();
  }

  // decode the current frame again (e.g. after something else used the stitcher's textures)
  refresh() {
    this.suspended = false;
    this.needReset = true;
    this.wake();
  }

  // free the hardware decoders while an export runs its own; refresh() resumes
  suspend() {
    this.pause();
    this.suspended = true;
    for (const d of this.decs) if (d.state !== 'closed') d.close();
    for (const q of this.q) for (const f of q.splice(0)) f.close();
  }

  close() {
    this.closed = true;
    this.wake();
    this.stopAudio();
    for (const d of [...this.decs, this.adec]) if (d && d.state !== 'closed') d.close();
    for (const q of this.q) for (const f of q.splice(0)) f.close();
    if (this.ctx) this.ctx.close().catch(() => {});
    URL.revokeObjectURL(this.url);
  }
  // ---- internals ----
  indexAt(t) {
    const v = Math.round(t * this.ts + 1);
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.dts[m] <= v) lo = m; else hi = m - 1; }
    return lo;
  }
  targetIdx() { return this.indexAt(this.currentTime); }

  keyAtOrBefore(i) {
    let lo = 0, hi = this.keys.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.keys[m] <= i) lo = m; else hi = m - 1; }
    return this.keys[lo];
  }
  keyAtOrAfter(i) {
    const k = this.keys.find((x) => x >= i);
    return k === undefined ? this.keyAtOrBefore(i) : k;
  }

  wake() { const w = this._wake; this._wake = null; if (w) w(); }
  sleep(ms) { return new Promise((r) => { this._wake = r; setTimeout(r, ms); }); }

  reset() {
    this.gen++;
    this.needReset = false;
    this.decs = this.decs.map((d, k) => {
      if (d.state === 'closed') return this.makeDecoder(k);
      d.reset();
      d.configure(this.cfg[k]);
      return d;
    });
    for (const q of this.q) for (const f of q.splice(0)) f.close();
    this.shownIdx = -1;
    const tgt = this.targetIdx();
    // while playing, restart at a keyframe just ahead of the clock so the picture resumes as soon as possible
    this.pos = this.playing ? this.keyAtOrAfter(tgt + Math.round((0.2 * this._rate) / this.frameDur)) : this.keyAtOrBefore(tgt);
  }

  async pump() {
    while (!this.closed) {
      if (this.suspended) { await this.sleep(100); continue; }
      if (this.needReset) this.reset();
      const tgt = this.targetIdx();
      if (this.playing && tgt - Math.max(this.pos, this.shownIdx) > MAX_LAG) { this.needReset = true; continue; }
      // throttle on frames buffered/in flight rather than index distance (after a skip, pos may be ahead of the clock)
      const buffered = Math.max(...this.decs.map((d, k) => d.decodeQueueSize + this.q[k].length));
      if (this.pos >= this.n || buffered > AHEAD) { await this.sleep(30); continue; }
      const i0 = this.pos, cnt = Math.min(4, AHEAD + 1 - buffered, this.n - i0), gen = this.gen;
      this.pos += cnt;
      let data;
      try {
        data = await this.readBatch(i0, cnt);
      } catch { await this.sleep(100); continue; }
      if (gen !== this.gen || this.closed) continue;
      for (let j = 0; j < cnt; j++) {
        const i = i0 + j;
        data[j].forEach((buf, k) => {
          try {
            this.decs[k].decode(new EncodedVideoChunk({ type: this.tracks[k].key[i] ? 'key' : 'delta', timestamp: i, data: buf }));
          } catch { this.needReset = true; }
        });
      }
    }
  }

  // Read samples [i0, i0+cnt) of every track; interleaved samples usually sit together, so use one read.
  async readBatch(i0, cnt) {
    let lo = Infinity, hi = 0, sum = 0;
    for (const tr of this.tracks) for (let i = i0; i < i0 + cnt; i++) {
      lo = Math.min(lo, tr.offset[i]); hi = Math.max(hi, tr.offset[i] + tr.size[i]); sum += tr.size[i];
    }
    if (hi - lo <= sum * 1.25 + 65536) {
      const blob = await this.read(lo, hi - lo);
      return Array.from({ length: cnt }, (_, j) => this.tracks.map((tr) => blob.subarray(tr.offset[i0 + j] - lo, tr.offset[i0 + j] - lo + tr.size[i0 + j])));
    }
    const out = [];
    for (let j = 0; j < cnt; j++) out.push(await Promise.all(this.tracks.map((tr) => this.read(tr.offset[i0 + j], tr.size[i0 + j]))));
    return out;
  }

  // Called once per animation frame. Uploads the newest frame pair at/before the clock; returns true if changed.
  update(pano) {
    if (this.playing && this.currentTime >= this.duration) {
      this._t = this.duration;
      this.playing = false;
      this.stopAudio();
      this.dispatchEvent(new Event('pause'));
    }
    const tgt = this.targetIdx();
    let best = -1;
    for (const f of this.q[0]) {
      const i = f.timestamp;
      if (i <= tgt && i > best && this.q.every((q) => q.some((g) => g.timestamp === i))) best = i;
    }
    let changed = false;
    if (best >= 0 && best !== this.shownIdx) {
      this.q.forEach((q, k) => {
        while (q.length && q[0].timestamp < best) q.shift().close();
        const f = q.shift();
        pano.upload(k, f);
        f.close();
      });
      this.shownIdx = best;
      changed = true;
    }
    // drop anything older than what's on screen
    for (const q of this.q) while (q.length && q[0].timestamp <= this.shownIdx) q.shift().close();
    this.wake();
    return changed;
  }
}
