// Small vector flags for the overlay driver plate (simplified designs; Windows has no flag emoji).
const UJ = (ctx, x, y, w, h) => {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#012169'; ctx.fillRect(x, y, w, h);
  const line = (x0, y0, x1, y1, lw, c) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineWidth = lw; ctx.strokeStyle = c; ctx.stroke(); };
  for (const [lw, c] of [[h / 5, '#fff'], [h / 15, '#c8102e']]) { line(x, y, x + w, y + h, lw, c); line(x + w, y, x, y + h, lw, c); }
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y + h / 3, w, h / 3); ctx.fillRect(x + w / 2 - h / 6, y, h / 3, h);
  ctx.fillStyle = '#c8102e'; ctx.fillRect(x, y + h * 0.4, w, h * 0.2); ctx.fillRect(x + w / 2 - h * 0.1, y, h * 0.2, h);
  ctx.restore();
};
const star = (ctx, cx, cy, r, c, n = 5, inner = 0.4) => {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n, rr = i % 2 ? r * inner : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fillStyle = c; ctx.fill();
};
const disc = (ctx, cx, cy, r, c) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fillStyle = c; ctx.fill(); };
const stripes = (dir, colors, weights) => (ctx, x, y, w, h) => {
  const ws = weights || colors.map(() => 1), tot = ws.reduce((a, b) => a + b, 0);
  let p = 0;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    const a = (p / tot), b = ((p + ws[i]) / tot);
    if (dir === 'h') ctx.fillRect(x, y + a * h, w, (b - a) * h + 0.0005); else ctx.fillRect(x + a * w, y, (b - a) * w + 0.0005, h);
    p += ws[i];
  });
};
const nordic = (bg, cross, inner) => (ctx, x, y, w, h) => {
  ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
  const cx = x + w * 0.37, cy = y + h / 2;
  ctx.fillStyle = cross; ctx.fillRect(x, cy - h * 0.12, w, h * 0.24); ctx.fillRect(cx - h * 0.12, y, h * 0.24, h);
  if (inner) { ctx.fillStyle = inner; ctx.fillRect(x, cy - h * 0.06, w, h * 0.12); ctx.fillRect(cx - h * 0.06, y, h * 0.12, h); }
};
const with2 = (a, b) => (ctx, x, y, w, h) => { a(ctx, x, y, w, h); b(ctx, x, y, w, h); };
const LEAF = [[0, -1], [0.15, -0.7], [0.35, -0.8], [0.3, -0.35], [0.55, -0.5], [0.6, -0.35], [0.9, -0.4], [0.8, -0.1], [0.95, 0], [0.5, 0.3], [0.55, 0.45], [0.08, 0.4], [0.08, 0.8], [-0.08, 0.8], [-0.08, 0.4], [-0.55, 0.45], [-0.5, 0.3], [-0.95, 0], [-0.8, -0.1], [-0.9, -0.4], [-0.6, -0.35], [-0.55, -0.5], [-0.3, -0.35], [-0.35, -0.8], [-0.15, -0.7]];

export const FLAGS = {
  GB: ['United Kingdom', UJ],
  ENG: ['England', (c, x, y, w, h) => { c.fillStyle = '#fff'; c.fillRect(x, y, w, h); c.fillStyle = '#ce1124'; c.fillRect(x, y + h * 0.4, w, h * 0.2); c.fillRect(x + w / 2 - h * 0.1, y, h * 0.2, h); }],
  SCO: ['Scotland', (c, x, y, w, h) => { c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.fillStyle = '#005eb8'; c.fillRect(x, y, w, h); c.strokeStyle = '#fff'; c.lineWidth = h * 0.2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y + h); c.moveTo(x + w, y); c.lineTo(x, y + h); c.stroke(); c.restore(); }],
  IE: ['Ireland', stripes('v', ['#169b62', '#fff', '#ff883e'])],
  US: ['United States', (c, x, y, w, h) => {
    stripes('h', Array.from({ length: 13 }, (_, i) => (i % 2 ? '#fff' : '#b22234')))(c, x, y, w, h);
    c.fillStyle = '#3c3b6e'; c.fillRect(x, y, w * 0.4, h * 7 / 13);
    for (let r = 0; r < 4; r++) for (let k = 0; k < 5; k++) disc(c, x + w * 0.4 * (k + 0.5) / 5, y + h * 7 / 13 * (r + 0.5) / 4, h * 0.022, '#fff');
  }],
  CA: ['Canada', (c, x, y, w, h) => {
    stripes('v', ['#d52b1e', '#fff', '#d52b1e'], [1, 2, 1])(c, x, y, w, h);
    const s = h * 0.32, cx = x + w / 2, cy = y + h / 2;
    c.beginPath(); for (const [px, py] of LEAF) c.lineTo(cx + px * s, cy + py * s); c.closePath(); c.fillStyle = '#d52b1e'; c.fill();
  }],
  MX: ['Mexico', with2(stripes('v', ['#006847', '#fff', '#ce1126']), (c, x, y, w, h) => disc(c, x + w / 2, y + h / 2, h * 0.13, '#8c5a2b'))],
  BR: ['Brazil', (c, x, y, w, h) => {
    c.fillStyle = '#009c3b'; c.fillRect(x, y, w, h);
    c.beginPath(); c.moveTo(x + w * 0.5, y + h * 0.1); c.lineTo(x + w * 0.92, y + h / 2); c.lineTo(x + w * 0.5, y + h * 0.9); c.lineTo(x + w * 0.08, y + h / 2); c.closePath(); c.fillStyle = '#ffdf00'; c.fill();
    disc(c, x + w / 2, y + h / 2, h * 0.22, '#002776');
  }],
  AR: ['Argentina', with2(stripes('h', ['#74acdf', '#fff', '#74acdf']), (c, x, y, w, h) => disc(c, x + w / 2, y + h / 2, h * 0.1, '#f6b40e'))],
  CO: ['Colombia', stripes('h', ['#fcd116', '#003893', '#ce1126'], [2, 1, 1])],
  FR: ['France', stripes('v', ['#0055a4', '#fff', '#ef4135'])],
  DE: ['Germany', stripes('h', ['#000', '#dd0000', '#ffce00'])],
  IT: ['Italy', stripes('v', ['#009246', '#fff', '#ce2b37'])],
  ES: ['Spain', stripes('h', ['#aa151b', '#f1bf00', '#aa151b'], [1, 2, 1])],
  PT: ['Portugal', with2(stripes('v', ['#006600', '#ff0000'], [2, 3]), (c, x, y, w, h) => disc(c, x + w * 0.4, y + h / 2, h * 0.17, '#ffcc00'))],
  NL: ['Netherlands', stripes('h', ['#ae1c28', '#fff', '#21468b'])],
  BE: ['Belgium', stripes('v', ['#000', '#fdda24', '#ef3340'])],
  LU: ['Luxembourg', stripes('h', ['#ed2939', '#fff', '#00a1de'])],
  MC: ['Monaco', stripes('h', ['#ce1126', '#fff'])],
  CH: ['Switzerland', (c, x, y, w, h) => { c.fillStyle = '#da291c'; c.fillRect(x, y, w, h); c.fillStyle = '#fff'; const cx = x + w / 2, cy = y + h / 2; c.fillRect(cx - h * 0.3, cy - h * 0.1, h * 0.6, h * 0.2); c.fillRect(cx - h * 0.1, cy - h * 0.3, h * 0.2, h * 0.6); }],
  AT: ['Austria', stripes('h', ['#ed2939', '#fff', '#ed2939'])],
  DK: ['Denmark', nordic('#c8102e', '#fff')],
  SE: ['Sweden', nordic('#006aa7', '#fecc00')],
  NO: ['Norway', nordic('#ba0c2f', '#fff', '#00205b')],
  FI: ['Finland', nordic('#fff', '#002f6c')],
  EE: ['Estonia', stripes('h', ['#0072ce', '#000', '#fff'])],
  PL: ['Poland', stripes('h', ['#fff', '#dc143c'])],
  CZ: ['Czechia', (c, x, y, w, h) => { stripes('h', ['#fff', '#d7141a'])(c, x, y, w, h); c.beginPath(); c.moveTo(x, y); c.lineTo(x + w / 2, y + h / 2); c.lineTo(x, y + h); c.closePath(); c.fillStyle = '#11457e'; c.fill(); }],
  HU: ['Hungary', stripes('h', ['#ce2939', '#fff', '#477050'])],
  UA: ['Ukraine', stripes('h', ['#0057b7', '#ffd700'])],
  AE: ['United Arab Emirates', (c, x, y, w, h) => { stripes('h', ['#00732f', '#fff', '#000'])(c, x, y, w, h); c.fillStyle = '#ff0000'; c.fillRect(x, y, w * 0.25, h); }],
  SA: ['Saudi Arabia', (c, x, y, w, h) => { c.fillStyle = '#006c35'; c.fillRect(x, y, w, h); c.fillStyle = '#fff'; c.fillRect(x + w * 0.25, y + h * 0.62, w * 0.5, h * 0.05); }],
  IN: ['India', with2(stripes('h', ['#ff9933', '#fff', '#138808']), (c, x, y, w, h) => { c.beginPath(); c.arc(x + w / 2, y + h / 2, h * 0.12, 0, 2 * Math.PI); c.lineWidth = h * 0.03; c.strokeStyle = '#000080'; c.stroke(); })],
  CN: ['China', (c, x, y, w, h) => { c.fillStyle = '#de2910'; c.fillRect(x, y, w, h); star(c, x + w * 0.17, y + h * 0.27, h * 0.15, '#ffde00'); for (const [a, b] of [[0.33, 0.1], [0.4, 0.2], [0.4, 0.35], [0.33, 0.45]]) star(c, x + w * a, y + h * b, h * 0.05, '#ffde00'); }],
  JP: ['Japan', (c, x, y, w, h) => { c.fillStyle = '#fff'; c.fillRect(x, y, w, h); disc(c, x + w / 2, y + h / 2, h * 0.3, '#bc002d'); }],
  TH: ['Thailand', stripes('h', ['#a51931', '#f4f5f8', '#2d2a4a', '#f4f5f8', '#a51931'], [1, 1, 2, 1, 1])],
  AU: ['Australia', (c, x, y, w, h) => {
    c.fillStyle = '#012169'; c.fillRect(x, y, w, h); UJ(c, x, y, w / 2, h / 2);
    star(c, x + w * 0.25, y + h * 0.75, h * 0.12, '#fff', 7);
    for (const [a, b, r] of [[0.75, 0.2, 0.06], [0.62, 0.45, 0.06], [0.88, 0.4, 0.06], [0.75, 0.82, 0.07], [0.8, 0.55, 0.035]]) star(c, x + w * a, y + h * b, h * r, '#fff', 7);
  }],
  NZ: ['New Zealand', (c, x, y, w, h) => {
    c.fillStyle = '#012169'; c.fillRect(x, y, w, h); UJ(c, x, y, w / 2, h / 2);
    for (const [a, b, r] of [[0.75, 0.22, 0.07], [0.65, 0.48, 0.07], [0.86, 0.43, 0.06], [0.75, 0.8, 0.08]]) { star(c, x + w * a, y + h * b, h * r * 1.3, '#fff'); star(c, x + w * a, y + h * b, h * r, '#cc142b'); }
  }],
  ZA: ['South Africa', (c, x, y, w, h) => {
    stripes('h', ['#e03c31', '#fff', '#001489'])(c, x, y, w, h);
    c.fillStyle = '#fff'; c.fillRect(x, y + h * 0.3, w, h * 0.4); c.fillStyle = '#007749'; c.fillRect(x, y + h * 0.38, w, h * 0.24);
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + w * 0.42, y + h / 2); c.lineTo(x, y + h); c.closePath(); c.fillStyle = '#ffb81c'; c.fill();
    c.beginPath(); c.moveTo(x, y + h * 0.12); c.lineTo(x + w * 0.33, y + h / 2); c.lineTo(x, y + h * 0.88); c.closePath(); c.fillStyle = '#000'; c.fill();
  }],
  CHQ: ['Chequered flag', (c, x, y, w, h) => { const n = 6, m = 4; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { c.fillStyle = (i + j) % 2 ? '#111' : '#fff'; c.fillRect(x + (i * w) / n, y + (j * h) / m, w / n + 0.0005, h / m + 0.0005); } }],
};

export function drawFlag(ctx, code, x, y, w, h) {
  const f = FLAGS[code];
  if (f) f[1](ctx, x, y, w, h);
}
