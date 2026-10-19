// CSV / ASCII telemetry import. Handles exports from MoTeC i2, McLaren ATLAS and Pi Toolbox:
// auto-detects delimiter, skips metadata blocks, finds the header (and optional units) row,
// parses numbers / hh:mm:ss.sss times, and forward-fills blank cells from mixed-rate exports.

function splitLine(line, d) {
  if (line.indexOf('"') === -1) return line.split(d);
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function detectDelimiter(lines) {
  const nonBlank = lines.filter((l) => l.trim());
  for (const d of ['\t', ';']) {
    const counts = new Map();
    for (const l of nonBlank) {
      const n = splitLine(l, d).length - 1;
      if (n > 0) counts.set(n, (counts.get(n) || 0) + 1);
    }
    let freq = 0;
    for (const f of counts.values()) freq = Math.max(freq, f);
    if (freq >= nonBlank.length * 0.5) return d;
  }
  return ',';
}

const TIME_RE = /^(-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;
const DATETIME_RE = /^(\d{4})-(\d\d)-(\d\d)[ T](\d+):(\d+):(\d+(?:\.\d+)?)/;

function parseNum(s, decComma) {
  s = s.trim();
  if (!s) return NaN;
  let v = Number(decComma ? s.replace(',', '.') : s);
  if (!Number.isNaN(v)) return v;
  let m = TIME_RE.exec(s);
  if (m) {
    v = (m[2] ? +m[2] : 0) * 3600 + +m[3] * 60 + parseFloat(m[4]);
    return m[1] ? -v : v;
  }
  m = DATETIME_RE.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 + +m[4] * 3600 + +m[5] * 60 + parseFloat(m[6]);
  return NaN;
}

// text states found in exports (pit limiter YES/NO, gear N/R, flags ON/OFF)
const WORDS = { YES: 1, NO: 0, Y: 1, ON: 1, OFF: 0, TRUE: 1, FALSE: 0, N: 0, NEUTRAL: 0, R: -1, REV: -1, REVERSE: -1 };
function cellNum(s, decComma) {
  const v = parseNum(s, decComma);
  if (!Number.isNaN(v)) return v;
  const w = WORDS[s.trim().toUpperCase()];
  return w === undefined ? NaN : w;
}

function splitNameUnit(name) {
  const m = /^(.*?)\s*[[(]([^\])]*)[\])]\s*$/.exec(name);
  return m && m[1] ? [m[1], m[2]] : [name, ''];
}

export function parseTelemetry(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/);
  const delim = detectDelimiter(lines.slice(0, 400));
  const decComma = delim !== ',';

  const numFrac = (cells) => {
    let ne = 0, num = 0;
    for (const c of cells) {
      if (c.trim() === '') continue;
      ne++;
      if (!Number.isNaN(cellNum(c, decComma))) num++;
    }
    return ne < 2 ? 0 : num / ne;
  };

  let dataStart = -1, ncols = 0;
  for (let i = 0; i < Math.min(lines.length, 5000) && dataStart < 0; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitLine(lines[i], delim);
    if (cells.length < 2 || numFrac(cells) < 0.8) continue;
    let ok = true, seen = 0;
    for (let j = i + 1; j < lines.length && seen < 3; j++) {
      if (!lines[j].trim()) continue;
      const c2 = splitLine(lines[j], delim);
      seen++;
      if (Math.abs(c2.length - cells.length) > 1 || numFrac(c2) < 0.8) { ok = false; break; }
    }
    if (ok) { dataStart = i; ncols = cells.length; }
  }
  if (dataStart < 0) throw new Error('Could not find rows of numeric data in this file.');

  // Walk back from the first data row to find names (and optionally units) rows.
  const hdr = [];
  for (let j = dataStart - 1; j >= 0 && hdr.length < 2; j--) {
    if (!lines[j].trim()) continue;
    const cells = splitLine(lines[j], delim);
    if (cells.length < ncols * 0.6 || numFrac(cells) >= 0.5) break;
    hdr.unshift(cells.map((s) => s.trim()));
  }

  const names = [], units = [];
  for (let c = 0; c < ncols; c++) {
    let name = (hdr[0] && hdr[0][c]) || `Column ${c + 1}`;
    let unit = hdr.length > 1 ? (hdr[1][c] || '') : '';
    if (!unit) [name, unit] = splitNameUnit(name);
    names.push(name);
    units.push(unit);
  }

  const cap = lines.length - dataStart;
  const raw = Array.from({ length: ncols }, () => new Float64Array(cap));
  let n = 0;
  for (let i = dataStart; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const cells = splitLine(l, delim);
    for (let c = 0; c < ncols; c++) raw[c][n] = c < cells.length ? cellNum(cells[c], decComma) : NaN;
    n++;
  }

  const out = { names: [], units: [], cols: [], n };
  const seenNames = new Map();
  for (let c = 0; c < ncols; c++) {
    const col = raw[c].subarray(0, n);
    let first = -1;
    for (let i = 0; i < n; i++) if (Number.isFinite(col[i])) { first = i; break; }
    if (first < 0) continue;
    for (let i = 0; i < first; i++) col[i] = col[first];
    for (let i = first + 1; i < n; i++) if (!Number.isFinite(col[i])) col[i] = col[i - 1];
    let name = names[c];
    const k = seenNames.get(name) || 0;
    seenNames.set(name, k + 1);
    if (k) name = `${name} #${k + 1}`;
    out.names.push(name);
    out.units.push(units[c]);
    out.cols.push(col);
  }
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function isIncreasing(col) {
  const n = col.length;
  if (n < 2 || !(col[n - 1] > col[0])) return false;
  let up = 0;
  for (let i = 1; i < n; i++) if (col[i] > col[i - 1]) up++;
  return up / (n - 1) >= 0.9;
}

function bestBy(names, scoreFn) {
  let best = -1, bestScore = 0;
  names.forEach((name, i) => {
    const s = scoreFn(norm(name), i);
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

export function guessTimeCol(data) {
  const i = bestBy(data.names, (k, i) => {
    let s = 0;
    if (['time', 'times', 'sessiontime', 'elapsedtime', 'timestamp', 'stime', 't'].includes(k)) s = 3;
    else if (k.includes('time') && !/lap|sector|split|delta|best|predict|gain|ign|inj/.test(k)) s = 2;
    return s && isIncreasing(data.cols[i]) ? s : 0;
  });
  return i >= 0 ? i : 0;
}

export function guessDistCol(data) {
  return bestBy(data.names, (k, i) => {
    if (!(k.includes('dist') || k === 'slap' || k === 'srun') || /gap|delta|ahead|behind|tgt|target/.test(k)) return 0;
    const col = data.cols[i];
    if (!(col[col.length - 1] > col[0])) return 0;
    return k === 'distance' || k === 'dist' ? 3 : k.includes('lap') ? 1 : 2;
  });
}

export function guessSpeedCol(data) {
  return bestBy(data.names, (k) => {
    if (['speed', 'vcar', 'vehiclespeed', 'groundspeed', 'gpsspeed', 'velocity', 'carspeed', 'vspeed', 'corrspeed'].includes(k)) return 3;
    if (k.includes('speed') && !/wheel|whl|engine|eng|fan|pump|shaft|turbo|wind|limit|target|tgt|[lr][fr]$|f[lr]|r[lr]/.test(k)) return 2;
    return 0;
  });
}

const TIME_UNITS = [['s', 1], ['ms', 1e-3], ['µs', 1e-6], ['ns', 1e-9]];

export function guessTimeUnit(col) {
  const diffs = [];
  const step = Math.max(1, Math.floor(col.length / 2000));
  for (let i = step; i < col.length; i += step) {
    const d = (col[i] - col[i - step]) / step;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 1;
  diffs.sort((a, b) => a - b);
  const dt = diffs[diffs.length >> 1];
  for (const [, f] of TIME_UNITS) if (dt * f >= 1e-5 && dt * f <= 5) return f;
  return 1;
}

// distSpec: { type: 'col' | 'speed', idx } or null
export function buildSession(data, timeIdx, unitFactor, distSpec) {
  const T = data.cols[timeIdx];
  const keep = new Uint32Array(data.n);
  let m = 0, last = -Infinity;
  for (let i = 0; i < data.n; i++) {
    if (Number.isFinite(T[i]) && T[i] > last) { keep[m++] = i; last = T[i]; }
  }
  if (m < 2) throw new Error('The selected time column does not increase.');
  const t0 = T[keep[0]];
  const t = new Float64Array(m);
  for (let j = 0; j < m; j++) t[j] = (T[keep[j]] - t0) * unitFactor;
  const cols = data.cols.map((c) => {
    const o = new Float64Array(m);
    for (let j = 0; j < m; j++) o[j] = c[keep[j]];
    return o;
  });

  let dist = null;
  if (distSpec && distSpec.type === 'col') {
    const d = cols[distSpec.idx];
    dist = new Float64Array(m);
    let off = 0;
    dist[0] = d[0];
    for (let j = 1; j < m; j++) {
      if (d[j] < d[j - 1] - 1) off += d[j - 1] - d[j]; // lap-distance reset: keep accumulating
      dist[j] = Math.max(dist[j - 1], d[j] + off);
    }
    const d0 = dist[0];
    for (let j = 0; j < m; j++) dist[j] -= d0;
  } else if (distSpec && distSpec.type === 'speed') {
    const s = cols[distSpec.idx];
    const u = (data.units[distSpec.idx] || '').toLowerCase();
    const f = u.includes('m/s') ? 1 : u.includes('mph') ? 0.44704 : 1 / 3.6;
    dist = new Float64Array(m);
    for (let j = 1; j < m; j++) {
      const v = 0.5 * (s[j] + s[j - 1]) * f * (t[j] - t[j - 1]);
      dist[j] = dist[j - 1] + (Number.isFinite(v) && v > 0 ? v : 0);
    }
  }
  return { t, cols, names: data.names, units: data.units, dist, n: m };
}

export function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function interp(xs, ys, x) {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const i = lowerBound(xs, x);
  const xa = xs[i - 1], xb = xs[i];
  return xb === xa ? ys[i] : ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xa)) / (xb - xa);
}

export function nearestIndex(xs, x) {
  const i = lowerBound(xs, x);
  if (i <= 0) return 0;
  if (i >= xs.length) return xs.length - 1;
  return x - xs[i - 1] <= xs[i] - x ? i - 1 : i;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '--:--.---';
  const neg = sec < 0;
  sec = Math.round(Math.abs(sec) * 1000) / 1000; // so 59.9996 shows as 1:00.000, not 0:60.000
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`);
}
