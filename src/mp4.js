// Minimal MP4/ISO-BMFF demuxer: enough to read video/audio track sample tables and the
// HEVC/AVC decoder config so WebCodecs can decode tracks directly from a (possibly huge) File.
// reader: async (pos, len) => Uint8Array

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function boxes(b, start, end, cb) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let hl = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hl = 16; } else if (size === 0) size = end - p;
    if (size < hl) break;
    cb(type, p + hl, Math.min(p + size, end), p);
    p += size;
  }
}

function hex(n) { return n.toString(16).toUpperCase(); }

// MPEG-4 descriptors inside esds: find the payload of the first descriptor with the given tag (0x05 = AudioSpecificConfig)
function findDescriptor(b, p, end, want) {
  while (p + 2 <= end) {
    const tag = b[p++];
    let len = 0;
    for (let i = 0; i < 4; i++) { const c = b[p++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
    if (tag === want) return b.slice(p, p + len);
    if (tag === 0x03) { // ES_Descriptor: ES_ID(2) + flags(1) + optional fields, then children
      const f = b[p + 2];
      let q = p + 3;
      if (f & 0x80) q += 2;
      if (f & 0x40) q += 1 + b[q];
      if (f & 0x20) q += 2;
      const r = findDescriptor(b, q, p + len, want);
      if (r) return r;
    } else if (tag === 0x04) { // DecoderConfigDescriptor: 13 fixed bytes, then children
      const r = findDescriptor(b, p + 13, p + len, want);
      if (r) return r;
    }
    p += len;
  }
  return null;
}

function hevcCodecString(c) {
  // hvcC: configurationVersion, profile_space/tier/profile_idc, compat flags(32), constraint(48), level
  const space = c[1] >> 6, tier = (c[1] >> 5) & 1, idc = c[1] & 0x1f;
  let compat = (c[2] << 24 | c[3] << 16 | c[4] << 8 | c[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  rev >>>= 0;
  const cons = [];
  for (let i = 6; i < 12; i++) cons.push(c[i]);
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return `hvc1.${['', 'A', 'B', 'C'][space]}${idc}.${hex(rev)}.${tier ? 'H' : 'L'}${c[12]}${cons.map((x) => '.' + hex(x)).join('')}`;
}

function parseTrak(b, s, e) {
  const tr = { handler: '', timescale: 0, duration: 0 };
  const st = {};
  const walk = (s, e) => boxes(b, s, e, (type, cs, ce) => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (CONTAINERS.has(type)) return walk(cs, ce);
    if (type === 'tkhd') tr.id = dv.getUint32(cs + (b[cs] ? 20 : 12));
    else if (type === 'mdhd') {
      const v = b[cs];
      tr.timescale = dv.getUint32(cs + (v ? 20 : 12));
      tr.duration = v ? Number(dv.getBigUint64(cs + 24)) : dv.getUint32(cs + 16);
    } else if (type === 'hdlr' && !tr.handler) tr.handler = String.fromCharCode(...b.subarray(cs + 8, cs + 12));
    else if (type === 'stsd') {
      const es = cs + 8;
      const fmt = String.fromCharCode(...b.subarray(es + 4, es + 8));
      const esize = dv.getUint32(es);
      tr.format = fmt;
      if (/^(hvc1|hev1|avc1|avc3)$/.test(fmt)) {
        tr.width = dv.getUint16(es + 8 + 24);
        tr.height = dv.getUint16(es + 8 + 26);
        boxes(b, es + 8 + 78, es + esize, (t2, s2, e2) => {
          if (t2 === 'hvcC') { tr.description = b.slice(s2, e2); tr.codec = hevcCodecString(tr.description); }
          if (t2 === 'avcC') {
            tr.description = b.slice(s2, e2);
            tr.codec = `avc1.${[b[s2 + 1], b[s2 + 2], b[s2 + 3]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
          }
        });
      } else if (fmt === 'mp4a') {
        tr.channels = dv.getUint16(es + 8 + 16);
        tr.sampleRate = dv.getUint32(es + 8 + 24) >>> 16;
        boxes(b, es + 36, es + esize, (t2, s2, e2) => {
          if (t2 !== 'esds') return;
          const asc = findDescriptor(b, s2 + 4, e2, 0x05);
          if (asc) { tr.description = asc; tr.codec = `mp4a.40.${asc[0] >> 3}`; }
        });
      }
    } else if (['stts', 'ctts', 'stss', 'stsc', 'stsz', 'stco', 'co64'].includes(type)) st[type] = [cs, ce];
  });
  walk(s, e);
  if (!/^(vide|soun)$/.test(tr.handler) || !st.stsz || !st.stsc || !st.stts || !(st.stco || st.co64)) return tr;

  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const [zs] = st.stsz;
  const fixed = dv.getUint32(zs + 4);
  const n = dv.getUint32(zs + 8);
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[i] = fixed || dv.getUint32(zs + 12 + i * 4);

  const chunkOff = [];
  if (st.stco) { const [p] = st.stco; const c = dv.getUint32(p + 4); for (let i = 0; i < c; i++) chunkOff.push(dv.getUint32(p + 8 + i * 4)); }
  else { const [p] = st.co64; const c = dv.getUint32(p + 4); for (let i = 0; i < c; i++) chunkOff.push(Number(dv.getBigUint64(p + 8 + i * 8))); }

  const offset = new Float64Array(n);
  {
    const [p] = st.stsc;
    const c = dv.getUint32(p + 4);
    const ent = [];
    for (let i = 0; i < c; i++) ent.push([dv.getUint32(p + 8 + i * 12), dv.getUint32(p + 12 + i * 12)]);
    let si = 0;
    for (let k = 0; k < ent.length; k++) {
      const first = ent[k][0] - 1, per = ent[k][1];
      const last = k + 1 < ent.length ? ent[k + 1][0] - 1 : chunkOff.length;
      for (let ch = first; ch < last && si < n; ch++) {
        let o = chunkOff[ch];
        for (let j = 0; j < per && si < n; j++) { offset[si] = o; o += size[si]; si++; }
      }
    }
  }

  const dts = new Float64Array(n);
  {
    const [p] = st.stts;
    const c = dv.getUint32(p + 4);
    let t = 0, si = 0;
    for (let i = 0; i < c; i++) {
      const cnt = dv.getUint32(p + 8 + i * 8), d = dv.getUint32(p + 12 + i * 8);
      for (let j = 0; j < cnt && si < n; j++) { dts[si++] = t; t += d; }
    }
  }
  const pts = Float64Array.from(dts);
  if (st.ctts) {
    const [p] = st.ctts;
    const v = b[p];
    const c = dv.getUint32(p + 4);
    let si = 0;
    for (let i = 0; i < c; i++) {
      const cnt = dv.getUint32(p + 8 + i * 8);
      const off = v ? dv.getInt32(p + 12 + i * 8) : dv.getUint32(p + 12 + i * 8);
      for (let j = 0; j < cnt && si < n; j++) { pts[si] += off; si++; }
    }
  }
  const key = new Uint8Array(n);
  if (st.stss) {
    const [p] = st.stss;
    const c = dv.getUint32(p + 4);
    for (let i = 0; i < c; i++) key[dv.getUint32(p + 8 + i * 4) - 1] = 1;
  } else key.fill(1);

  Object.assign(tr, { n, size, offset, dts, pts, key });
  return tr;
}

export async function demux(reader, fileSize) {
  let pos = 0, moov = null;
  while (pos + 8 <= fileSize) {
    const h = await reader(pos, 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1) size = Number(dv.getBigUint64(8)); else if (size === 0) size = fileSize - pos;
    if (size < 8) break;
    if (type === 'moov') { moov = await reader(pos, size); break; }
    pos += size;
  }
  if (!moov) throw new Error('No moov box found (not an MP4/INSV file?)');
  const tracks = [];
  boxes(moov, 8, moov.length, (type, s, e) => { if (type === 'trak') tracks.push(parseTrak(moov, s, e)); });
  return tracks;
}

// Insta360 trailer: [...records][record: data, format u8, id u8, size u32][32 pad][extraSize u32][version u32][magic 32]
const MAGIC = '8db42d694ccc418790edff439fe026bf';

export async function readInstaMeta(reader, fileSize) {
  const H = 72;
  if (fileSize < H) return null;
  const hdr = await reader(fileSize - H, H);
  if (new TextDecoder().decode(hdr.subarray(40)) !== MAGIC) return null;
  const extra = new DataView(hdr.buffer, hdr.byteOffset).getUint32(32, true);
  let off = H;
  for (let guard = 0; off < extra && guard < 64; guard++) {
    const r = await reader(fileSize - off - 6, 6);
    const id = r[1];
    const size = new DataView(r.buffer, r.byteOffset).getUint32(2, true);
    if (!size || size > extra) break;
    if (id === 1) {
      const meta = await reader(fileSize - off - 6 - size, size);
      return parseInstaInfo(meta);
    }
    off += size + 6;
  }
  return null;
}

function protoStrings(b) {
  // Pull every printable string out of the protobuf blob; enough to find model + calibration.
  const out = [];
  let cur = [];
  for (const c of b) {
    if (c >= 0x20 && c < 0x7f) cur.push(c);
    else { if (cur.length >= 4) out.push(String.fromCharCode(...cur)); cur = []; }
  }
  if (cur.length >= 4) out.push(String.fromCharCode(...cur));
  return out;
}

function parseInstaInfo(b) {
  const strs = protoStrings(b);
  const model = strs.find((s) => /^Insta360/.test(s)) || 'Insta360';
  // offset_v3: "2_" + 21 values per lens (xi, fx, fy, cx, cy, yaw, pitch, roll, tx, ty, tz, k1, k2, k3, p1, p2, w, h, type) + trailing id
  let lenses = null;
  for (const s of strs) {
    const v = s.split('_').map(Number);
    if (v[0] !== 2 || v.some((x) => !Number.isFinite(x))) continue;
    const per = (v.length - 2) / 2;
    if (per !== 19) continue;
    lenses = [0, 1].map((k) => {
      const a = v.slice(1 + k * per, 1 + (k + 1) * per);
      return { xi: a[0], fx: a[1], fy: a[2], cx: a[3], cy: a[4], yaw: a[5], pitch: a[6], roll: a[7], tx: a[8], ty: a[9], tz: a[10], k1: a[11], k2: a[12], k3: a[13], p1: a[14], p2: a[15], calibW: a[16], calibH: a[17] };
    });
    break;
  }
  return { model, lenses };
}
