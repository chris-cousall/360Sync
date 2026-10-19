// 360 view keyframes: [{ at: video time (s), lon, lat, fov }], sorted by time.
// The view glides through them on a monotone cubic: no overshoot, it eases out of the first and into the last,
// and it pauses on a keyframe only where the motion turns back (or two keyframes hold the same view).

const KEYS = ['lon', 'lat', 'fov'];

// lon wraps: each keyframe takes the shorter way round from the one before
function unwrap(keys) {
  const out = [];
  let prev = null;
  for (const k of keys) {
    let lon = k.lon;
    if (prev !== null) lon += Math.round((prev - lon) / 360) * 360;
    out.push({ ...k, lon });
    prev = lon;
  }
  return out;
}

function tangents(ks, key) {
  const n = ks.length, m = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = ks[i].at - ks[i - 1].at, h1 = ks[i + 1].at - ks[i].at;
    if (!(h0 > 0 && h1 > 0)) continue; // two keyframes at the same time: hold
    const d0 = (ks[i][key] - ks[i - 1][key]) / h0;
    const d1 = (ks[i + 1][key] - ks[i][key]) / h1;
    // a turn or a hold: stop here; otherwise the harmonic mean keeps it monotone
    m[i] = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
  }
  return m;
}

let cacheSrc = null, cache = null;
function prepare(keys) {
  if (keys === cacheSrc && cache && cache.n === keys.length) return cache;
  const ks = unwrap([...keys].sort((a, b) => a.at - b.at)); // a diamond being dragged can pass another
  cacheSrc = keys;
  cache = { n: keys.length, ks, m: Object.fromEntries(KEYS.map((k) => [k, tangents(ks, k)])) };
  return cache;
}

// call after changing the keyframes in place
export function keyframesChanged() { cacheSrc = null; }

export function viewAt(keys, t) {
  if (!keys || !keys.length) return null;
  const { ks, m } = prepare(keys);
  const n = ks.length;
  const norm = (v) => ({ lon: ((v.lon % 360) + 540) % 360 - 180, lat: Math.max(-89, Math.min(89, v.lat)), fov: Math.max(20, Math.min(140, v.fov)) });
  if (n === 1 || t <= ks[0].at) return norm(ks[0]);
  if (t >= ks[n - 1].at) return norm(ks[n - 1]);
  let i = 0;
  while (i < n - 2 && t >= ks[i + 1].at) i++;
  const a = ks[i], b = ks[i + 1], h = b.at - a.at;
  if (!(h > 0)) return norm(b);
  const s = (t - a.at) / h;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const v = {};
  for (const k of KEYS) v[k] = h00 * a[k] + h10 * h * m[k][i] + h01 * b[k] + h11 * h * m[k][i + 1];
  return norm(v);
}

// the keyframe within half a frame of t, if any
export function keyAt(keys, t, frameDur) {
  const tol = Math.max(0.01, frameDur / 2);
  return (keys || []).findIndex((k) => Math.abs(k.at - t) <= tol);
}
