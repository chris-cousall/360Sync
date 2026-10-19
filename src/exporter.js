// MP4 export: decode the source frame by frame, render it exactly like the player (stitched / 360 view / flat),
// draw the telemetry overlay on top, encode H.264 with WebCodecs and mux to an .mp4 streamed to disk.
// Audio (AAC) is copied straight from the source when it can be read.
import { Muxer, StreamTarget } from './vendor/mp4-muxer.mjs';
import { demux } from './mp4.js';
import { rangeReader } from './fileread.js';

const AHEAD = 6;

// Frames decoded in order with WebCodecs from the file's own sample tables (MP4/MOV/INSV).
// Several tracks (Insta360 lenses) are decoded side by side and handed out as matching sets.
class SeqSource {
  constructor(read, tracks, cfgs, atrack) {
    this.read = read;
    this.tracks = tracks;
    this.atrack = atrack && atrack.codec && /^mp4a/.test(atrack.codec) && atrack.n ? atrack : null;
    const t0 = tracks[0];
    this.ts = t0.timescale;
    this.n = Math.min(...tracks.map((t) => t.n));
    let m = Infinity;
    for (let i = 0; i < this.n; i++) m = Math.min(m, t0.pts[i]);
    this.pts0 = m;
    this.frameDur = this.n > 1 ? (t0.dts[this.n - 1] - t0.dts[0]) / (this.n - 1) / this.ts : 1 / 30;
    this.keys = [];
    for (let i = 0; i < this.n; i++) if (tracks.every((t) => t.key[i])) this.keys.push(i);
    if (!this.keys.length || this.keys[0] !== 0) this.keys.unshift(0);
    this.q = tracks.map(() => []);
    this.decs = cfgs.map((c, k) => {
      const d = new VideoDecoder({
        output: (f) => {
          if (this.closed || f.timestamp < this.minUs) { f.close(); return; }
          this.q[k].push(f);
          this.wake();
        },
        error: (e) => { this.err = e; this.wake(); },
      });
      d.configure(c);
      d.addEventListener('dequeue', () => this.wake());
      return d;
    });
  }

  time(i) { return (this.tracks[0].pts[i] - this.pts0) / this.ts; }
  wake() { const w = this._w; this._w = null; if (w) w(); }
  sleep() { return new Promise((r) => { this._w = r; setTimeout(r, 50); }); }

  start(t0, t1) {
    const tol = this.frameDur / 2;
    let first = 0;
    while (first < this.n - 1 && this.time(first) < t0 - tol) first++;
    let k = 0;
    for (const x of this.keys) if (x <= first) k = x;
    this.pos = k;
    this.t1 = t1;
    this.minUs = Math.round((t0 - tol) * 1e6);
    this.endUs = Math.round((t1 - tol) * 1e6);
  }

  async next() {
    for (;;) {
      if (this.err) throw this.err;
      if (this.q.every((q) => q.length)) {
        const ts = this.q.map((q) => q[0].timestamp), mx = Math.max(...ts);
        if (ts.some((x) => x < mx)) { this.q.forEach((q) => { if (q[0].timestamp < mx) q.shift().close(); }); continue; }
        const frames = this.q.map((q) => q.shift());
        if (frames[0].timestamp >= this.endUs) { frames.forEach((f) => f.close()); return null; }
        return { t: frames[0].timestamp / 1e6, frames };
      }
      if (this.flushed) return null;
      if (this.pos < this.n) {
        const busy = Math.max(...this.decs.map((d, k) => d.decodeQueueSize + this.q[k].length));
        if (busy < AHEAD || this.q.some((q) => !q.length)) {
          const i = this.pos++;
          const bufs = await Promise.all(this.tracks.map((tr) => this.read(tr.offset[i], tr.size[i])));
          if (this.closed) return null;
          const ts = Math.round(this.time(i) * 1e6);
          bufs.forEach((b, k) => this.decs[k].decode(new EncodedVideoChunk({ type: this.tracks[k].key[i] ? 'key' : 'delta', timestamp: ts, data: b })));
          // B-frames only reorder over a few frames, so stop reading a little past the end
          if (this.time(i) > this.t1 + 1) this.pos = this.n;
          continue;
        }
      } else if (!this.flushing) {
        this.flushing = Promise.all(this.decs.map((d) => d.flush()))
          .then(() => { this.flushed = true; this.wake(); }, (e) => { if (!this.closed) this.err = e; this.wake(); });
      }
      await this.sleep();
    }
  }

  close() {
    this.closed = true;
    for (const d of this.decs) if (d.state !== 'closed') d.close();
    for (const q of this.q) for (const f of q.splice(0)) f.close();
    this.wake();
  }
}

// Fallback for files we can't demux (WebM/MKV…): seek the <video> element frame by frame. No audio.
class SeekSource {
  constructor(video, frameDur) {
    this.video = video;
    this.frameDur = frameDur;
    this.atrack = null;
  }
  start(t0, t1) { this.t0 = t0; this.t1 = Math.min(t1, this.video.duration); this.k = 0; }
  async next() {
    const t = this.t0 + this.k * this.frameDur;
    if (t >= this.t1 - this.frameDur / 2) return null;
    this.k++;
    const v = this.video;
    await new Promise((res) => {
      const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
      const to = setTimeout(done, 5000);
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
    return { t, frames: [v], borrowed: true };
  }
  close() {}
}

async function openSource(o) {
  if (o.insv) {
    const s = o.insv;
    return new SeqSource(s.read, s.tracks, s.cfg, s.atrack);
  }
  if (o.file && /\.(mp4|m4v|mov)$/i.test(o.file.name) && 'VideoDecoder' in window) {
    try {
      const read = rangeReader(o.file);
      const tracks = await demux(read, o.file.size);
      const vt = tracks.find((t) => t.handler === 'vide' && t.n > 1 && t.codec);
      if (vt) {
        const cfg = { codec: vt.codec, codedWidth: vt.width, codedHeight: vt.height, description: vt.description, hardwareAcceleration: 'prefer-hardware' };
        if ((await VideoDecoder.isConfigSupported(cfg)).supported) {
          return new SeqSource(read, [vt], [cfg], tracks.find((t) => t.handler === 'soun' && t.n > 0));
        }
      }
    } catch (e) { console.warn('export: demux failed, seeking the video instead', e); }
  }
  return new SeekSource(o.video, o.frameDur);
}

// ---- encoder settings ----
// quality presets, in bits per pixel per frame (H.264; HEVC needs about a third less for the same picture)
const QUALITY = { standard: 0.1, high: 0.2, max: 0.4 };
const CAP = { avc: 160e6, hevc: 120e6 };

export function exportBitrate(W, H, fps, codec = 'avc', quality = 'high') {
  const bpp = (QUALITY[quality] || QUALITY.high) * (codec === 'hevc' ? 0.65 : 1);
  return Math.round(Math.min(CAP[codec] || CAP.avc, Math.max(3e6, W * H * fps * bpp)));
}

// H.264 levels: [level_idc, max macroblocks/s, max frame macroblocks, max kbit/s (High profile allows 1.25×)]
const AVC_LEVELS = [[0x1f, 108000, 3600, 14000], [0x20, 216000, 5120, 20000], [0x28, 245760, 8192, 20000], [0x29, 245760, 8192, 50000],
  [0x2a, 522240, 8704, 50000], [0x32, 589824, 22080, 135000], [0x33, 983040, 36864, 240000], [0x34, 2073600, 36864, 240000]];
// HEVC levels: [level_idc, max luma samples/frame, max luma samples/s, main tier kbit/s, high tier kbit/s]
const HEVC_LEVELS = [[120, 2228224, 66846720, 12000, 30000], [123, 2228224, 133693440, 20000, 50000], [150, 8912896, 267386880, 25000, 100000],
  [153, 8912896, 534773760, 40000, 160000], [156, 8912896, 1069547520, 60000, 240000], [180, 35651584, 1069547520, 60000, 240000],
  [183, 35651584, 2139095040, 120000, 480000], [186, 35651584, 4278190080, 240000, 800000]];

// largest frame each codec can carry (H.264 tops out around 4K, HEVC goes to 8K)
export const maxFrame = (codec, W, H) => (codec === 'hevc' ? W * H <= 35651584 : Math.ceil(W / 16) * Math.ceil(H / 16) <= 36864);

function avcConfigs(W, H, fps, bitrate) {
  const mbs = Math.ceil(W / 16) * Math.ceil(H / 16);
  const out = [];
  for (const [prof, k] of [['6400', 1.25], ['4d00', 1], ['4200', 1]]) {
    const lv = (AVC_LEVELS.find(([, mbps, fs, br]) => mbs <= fs && mbs * fps <= mbps && bitrate <= br * k * 1000) || AVC_LEVELS[AVC_LEVELS.length - 1])[0];
    out.push(`avc1.${prof}${lv.toString(16)}`);
  }
  return out.map((codec) => ({ codec, avc: { format: 'avc' } }));
}

function hevcConfigs(W, H, fps, bitrate) {
  const ps = W * H, sr = ps * fps, kb = bitrate / 1000;
  const fit = HEVC_LEVELS.filter(([, mps, msr]) => ps <= mps && sr <= msr);
  const main = fit.find((l) => kb <= l[3]), high = fit.find((l) => kb <= l[4]);
  const out = [];
  if (main) out.push(`hvc1.1.6.L${main[0]}.B0`);
  if (high) out.push(`hvc1.1.6.H${high[0]}.B0`);
  if (!out.length) out.push('hvc1.1.6.L186.B0');
  return out.map((codec) => ({ codec, hevc: { format: 'hevc' } }));
}

async function pickEncoder(W, H, fps, codec, quality) {
  const bitrate = exportBitrate(W, H, fps, codec, quality);
  const cands = codec === 'hevc' ? hevcConfigs(W, H, fps, bitrate) : avcConfigs(W, H, fps, bitrate);
  for (const c of cands) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { ...c, width: W, height: H, bitrate, bitrateMode: 'variable', latencyMode: 'quality', framerate: fps, hardwareAcceleration: hw };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try the next */ }
    }
  }
  const name = codec === 'hevc' ? 'H.265' : 'H.264';
  throw new Error(`This PC can't encode ${name} at ${W}×${H}. Try a lower resolution${codec === 'hevc' ? ' or H.264' : ''}.`);
}

// whether this PC can encode HEVC at all (needs a hardware encoder), checked once
let hevcOk = null;
export async function hevcSupported() {
  if (hevcOk === null) {
    hevcOk = false;
    if ('VideoEncoder' in window) {
      for (const c of hevcConfigs(1920, 1080, 30, 10e6)) {
        try { if ((await VideoEncoder.isConfigSupported({ ...c, width: 1920, height: 1080, bitrate: 10e6, framerate: 30 })).supported) { hevcOk = true; break; } } catch { /* no */ }
      }
    }
  }
  return hevcOk;
}

/**
 * o: { file, insv, video, frameDur, player, overlay, usePano, is360, view: {lon, lat, fov},
 *      width, height, codec: 'avc' | 'hevc', quality: 'standard' | 'high' | 'max',
 *      start, end, audio, dataTime(videoT) -> data t, rect: {x, y, w} (fractions of the frame),
 *      path, signal, onProgress({ done, total, frac, fps }) }
 */
export async function exportVideo(o) {
  if (!('VideoEncoder' in window)) throw new Error('Video encoding (WebCodecs) is not available');
  if (!window.native) throw new Error('File saving is not available');
  const W = o.width, H = o.height, codec = o.codec === 'hevc' ? 'hevc' : 'avc';
  const src = await openSource(o);
  const fps = Math.round(1 / src.frameDur * 1000) / 1000;
  let fid = null, enc = null, ok = false;
  const pending = [];
  let err = null;
  const fail = (e) => { if (!err) err = e; };
  try {
    const encCfg = await pickEncoder(W, H, fps, codec, o.quality);
    src.start(o.start, o.end);
    fid = await window.native.open(o.path);
    const at = o.audio ? src.atrack : null;
    const muxer = new Muxer({
      target: new StreamTarget({ onData: (d, pos) => pending.push(window.native.write(fid, pos, d).catch(fail)), chunked: true }),
      // frameRate becomes the track timescale and must be an integer; NTSC rates use the default 57600
      video: { codec, width: W, height: H, ...(Number.isInteger(fps) ? { frameRate: fps } : {}) },
      audio: at ? { codec: 'aac', numberOfChannels: at.channels, sampleRate: at.sampleRate } : undefined,
      fastStart: false,
      firstTimestampBehavior: 'cross-track-offset',
    });
    enc = new VideoEncoder({ output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { fail(e); } }, error: fail });
    enc.configure(encCfg);

    // audio samples copied across as they fall due
    let ai = 0, aMeta = at ? { decoderConfig: { codec: at.codec, sampleRate: at.sampleRate, numberOfChannels: at.channels, description: at.description } } : null;
    if (at) while (ai < at.n && at.pts[ai] / at.timescale < o.start) ai++;
    const pushAudio = async (upTo) => {
      if (!at) return;
      upTo = Math.min(upTo, o.end);
      while (ai < at.n) {
        const a = at.pts[ai] / at.timescale;
        if (a >= upTo) break;
        const d = ai + 1 < at.n ? (at.dts[ai + 1] - at.dts[ai]) / at.timescale : 1024 / at.sampleRate;
        const data = await src.read(at.offset[ai], at.size[ai]);
        muxer.addAudioChunkRaw(data, 'key', Math.round((a - o.start) * 1e6), Math.round(d * 1e6), aMeta || undefined);
        aMeta = null;
        ai++;
      }
    };

    // overlays land on even pixels, lining up with the encoder's 2x2 colour blocks (sharper coloured edges)
    const ev2 = (x) => Math.round(x / 2) * 2;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { alpha: false });
    // resampling a 4K/5K source down to the export size: the default filter aliases fine detail
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const pano = o.player.pano;
    if (o.usePano) { pano.cv.width = W; pano.cv.height = H; }
    o.overlay.expAnim = null;
    const total = Math.max(1, Math.round((o.end - o.start) / src.frameDur));
    const gop = Math.max(1, Math.round(fps * 2));
    const t0 = performance.now();
    let done = 0;
    for (;;) {
      if (o.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (err) throw err;
      const fr = await src.next();
      if (!fr) break;
      try {
        if (o.usePano) {
          fr.frames.forEach((f, k) => pano.upload(k, f));
          if (o.insv) { const first = done === 0; for (let k = first ? 3 : 1; k > 0; k--) pano.estimate(first ? 1 : 0.35); }
          const vw = o.viewAt ? o.viewAt(fr.t) : o.view;
          pano.render({ lon: vw.lon, lat: vw.lat, fov: vw.fov, out: o.is360 ? 'view' : 'equirect' });
          ctx.drawImage(pano.cv, 0, 0, W, H);
        } else {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(fr.frames[0], 0, 0, W, H);
        }
      } finally {
        if (!fr.borrowed) fr.frames.forEach((f) => f.close());
      }
      if (o.rect && o.overlay.visible) {
        const dt = o.dataTime(fr.t);
        if (Number.isFinite(dt)) {
          const ov = o.overlay.renderAt(dt, fr.t * 1000, o.rect.w * W);
          ctx.globalAlpha = o.overlay.cfg.opacity;
          ctx.drawImage(ov, ev2(o.rect.x * W), ev2(o.rect.y * H));
          ctx.globalAlpha = 1;
        }
      }
      if (o.tagRect && o.overlay.tagOn) {
        ctx.globalAlpha = o.overlay.cfg.opacity;
        ctx.drawImage(o.overlay.renderTag(o.tagRect.w * W), ev2(o.tagRect.x * W), ev2(o.tagRect.y * H));
        ctx.globalAlpha = 1;
      }
      if (o.lapRect) {
        const lc = o.overlay.renderLap(fr.t, o.lapRect.w * W);
        if (lc) ctx.drawImage(lc, ev2(o.lapRect.x * W), ev2(o.lapRect.y * H));
      }
      const vf = new VideoFrame(cv, { timestamp: Math.max(0, Math.round((fr.t - o.start) * 1e6)), duration: Math.round(src.frameDur * 1e6) });
      enc.encode(vf, { keyFrame: done % gop === 0 });
      vf.close();
      done++;
      while (enc.encodeQueueSize > 4 && !err) await new Promise((r) => { enc.addEventListener('dequeue', r, { once: true }); setTimeout(r, 100); });
      await pushAudio(fr.t + 0.5);
      if (pending.length > 8) await Promise.all(pending.splice(0));
      const el = (performance.now() - t0) / 1000;
      o.onProgress({ done, total, frac: Math.min(1, done / total), fps: done / Math.max(el, 1e-3) });
    }
    if (!done) throw new Error('No video frames in the chosen range');
    await enc.flush();
    if (err) throw err;
    await pushAudio(o.end);
    muxer.finalize();
    await Promise.all(pending.splice(0));
    if (err) throw err;
    ok = true;
    return { frames: done, audio: !!at, codec, bitrate: encCfg.bitrate, hardware: encCfg.hardwareAcceleration === 'prefer-hardware' };
  } finally {
    src.close();
    if (enc && enc.state !== 'closed') enc.close();
    await Promise.all(pending.splice(0)).catch(() => {});
    if (fid !== null) await window.native.close(fid, !ok).catch(() => {});
  }
}
