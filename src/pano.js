// WebGL2 360° renderer. Per-pixel ray casting, so the same shader serves:
//   source 'equirect'    – a normal 2:1 360 video
//   source 'dualfisheye' – Insta360 .insv: two fisheye textures stitched live using the
//                          camera's own calibration (MEI/unified model, as used by Insta360/Gyroflow)
// Output 'view' is a perspective camera (drag/zoom); 'equirect' unwraps the full sphere.
//
// Dynamic stitching: the lenses sit a few cm apart, so near objects (the car, people) land in different
// places in each lens and ghost at the seam. Each new frame, a small GPU pass block-matches a belt along
// the seam for a range of stitch depths, picks the best depth (and an exposure gain) per seam segment,
// and smooths it over time. The main pass warps each lens towards that depth around the seam.

const VS = `#version 300 es
in vec2 p; out vec2 vUv;
void main() { vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
uniform sampler2D t0, t1;
uniform vec4 uK[2];      // fx, fy, cx, cy  (texture-normalised)
uniform vec4 uD[2];      // k1, k2, k3, xi
uniform vec2 uP[2];      // p1, p2
uniform mat3 uR[2];      // world -> lens
uniform vec3 uC[2];      // lens centres relative to the rig centre (metres, world frame)
const float PI = 3.14159265359;

// fisheye uv in .xy, validity in .z; invD = 1 / stitch distance (metres)
vec3 project(int i, vec3 d, float invD) {
  vec3 l = uR[i] * normalize(d - uC[i] * invD);
  vec4 D = uD[i];
  float den = l.z + D.w;
  if (den <= 1e-4 || l.z < -0.2) return vec3(0.0);
  vec2 m = l.xy / den;
  float r2 = dot(m, m);
  float rad = 1.0 + D.x * r2 + D.y * r2 * r2 + D.z * r2 * r2 * r2;
  vec2 P = uP[i];
  vec2 md = m * rad + vec2(2.0 * P.x * m.x * m.y + P.y * (r2 + 2.0 * m.x * m.x),
                           2.0 * P.y * m.x * m.y + P.x * (r2 + 2.0 * m.y * m.y));
  vec2 uv = uK[i].xy * md + uK[i].zw;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return vec3(uv, inside);
}
`;

const FS = `${COMMON}
in vec2 vUv; out vec4 o;
uniform int uSrc, uOut, uDyn, uColor, uShowSeam;
uniform float uYaw, uPitch, uTanY, uAspect, uBlend, uInvD, uSharp, uDefringe;
uniform sampler2D tSeam;   // per seam segment: r = 1/depth, g = exposure ratio lens0/lens1

vec2 clampGrad(vec2 g) { return length(g) > 0.02 ? vec2(0.0) : g; }
vec3 lensGrad(int i, vec2 uv, vec2 gx, vec2 gy) {
  return i == 0 ? textureGrad(t0, uv, gx, gy).rgb : textureGrad(t1, uv, gx, gy).rgb;
}
// unsharp mask using taps one output pixel apart
vec3 sharp(int i, vec2 uv, vec2 gx, vec2 gy) {
  vec3 c = lensGrad(i, uv, gx, gy);
  if (uSharp <= 0.0) return c;
  vec3 n = lensGrad(i, uv + gx, gx, gy) + lensGrad(i, uv - gx, gx, gy) + lensGrad(i, uv + gy, gx, gy) + lensGrad(i, uv - gy, gx, gy);
  return clamp(c + uSharp * (c - 0.25 * n), 0.0, 1.0);
}
// purple/blue fringe suppression: desaturate blue-violet pixels that sit next to a much brighter area
vec3 defringe(int i, vec2 uv, vec3 c) {
  if (uDefringe <= 0.0) return c;
  float hue = max(c.b - max(c.g, c.r * 0.8), 0.0) + max(min(c.r, c.b) - c.g, 0.0);
  if (hue < 0.02) return c;
  vec2 px = 3.5 / vec2(i == 0 ? textureSize(t0, 0) : textureSize(t1, 0));
  float y = dot(c, vec3(0.299, 0.587, 0.114)), m = y;
  for (int k = 0; k < 8; k++) {
    float an = float(k) * 0.7853982;
    for (int r = 1; r <= 2; r++) {
      vec2 q = uv + vec2(cos(an), sin(an)) * px * float(r);
      vec3 n = i == 0 ? textureLod(t0, q, 0.0).rgb : textureLod(t1, q, 0.0).rgb;
      m = max(m, dot(n, vec3(0.299, 0.587, 0.114)));
    }
  }
  float k = uDefringe * smoothstep(0.02, 0.12, hue) * smoothstep(0.08, 0.3, m - y + 0.5 * (m - 0.6));
  return mix(c, vec3(y) + (c - vec3(y)) * 0.15, clamp(k, 0.0, 1.0));
}

vec3 viewRay() {
  if (uOut == 1) {
    float lon = (vUv.x - 0.5) * 2.0 * PI, lat = (vUv.y - 0.5) * PI;
    return vec3(cos(lat) * sin(lon), -sin(lat), cos(lat) * cos(lon));
  }
  vec2 s = (vUv * 2.0 - 1.0) * vec2(uTanY * uAspect, uTanY);
  vec3 d = normalize(vec3(s.x, -s.y, 1.0));           // x right, y down, z forward
  float cp = cos(uPitch), sp = sin(uPitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(uYaw), sy = sin(uYaw);
  return vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
}

void main() {
  vec3 d = viewRay();
  if (uSrc == 0) {
    float lon = atan(d.x, d.z), lat = asin(clamp(-d.y, -1.0, 1.0));
    o = texture(t0, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
    return;
  }
  vec3 l0 = uR[0] * d;
  vec2 seam = vec2(uInvD, 1.0);
  if (uDyn == 1 || uColor == 1) {
    // per-segment depth, smoothed along the seam, easing back to the base depth ~20 deg away from it
    float u = atan(l0.y, l0.x) / (2.0 * PI) + 0.5, w = 1.0 / float(textureSize(tSeam, 0).x);
    vec2 s = vec2(0.0);
    for (int k = -3; k <= 3; k++) s += texture(tSeam, vec2(u + float(k) * w, 0.5)).rg * (4.0 - abs(float(k)));
    s /= 16.0;
    seam = uDyn == 1 ? mix(s, vec2(uInvD, s.y), smoothstep(0.03, 0.35, abs(l0.z))) : vec2(uInvD, s.y);
  }
  vec3 a = project(0, d, seam.x), b = project(1, d, seam.x);
  // texture gradients taken here, before any divergent branch, and clamped where a lens's image ends
  vec2 ax = clampGrad(dFdx(a.xy)), ay = clampGrad(dFdy(a.xy)), bx = clampGrad(dFdx(b.xy)), by = clampGrad(dFdy(b.xy));
  // seam: crossfade across a band around the plane between the lenses
  float s = smoothstep(-uBlend, uBlend, l0.z);
  float wa = a.z * s, wb = b.z * (1.0 - s);
  if (wa + wb < 1e-4) { wa = a.z; wb = b.z; }
  float tot = wa + wb;
  if (tot < 1e-4) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // exposure match, strongest at the seam and fading out over ~30 deg
  float f = uColor == 1 ? 1.0 - smoothstep(0.0, 0.5, abs(l0.z)) : 0.0;
  float g = clamp(seam.y, 0.6, 1.6);
  vec3 ca = wa > 0.0 ? defringe(0, a.xy, sharp(0, a.xy, ax, ay)) * mix(1.0, inversesqrt(g), f) : vec3(0.0);
  vec3 cb = wb > 0.0 ? defringe(1, b.xy, sharp(1, b.xy, bx, by)) * mix(1.0, sqrt(g), f) : vec3(0.0);
  vec3 c = (ca * wa + cb * wb) / tot;
  if (uShowSeam == 1) c = mix(c, vec3(1.0, 0.1, 0.6), 0.35 * (1.0 - smoothstep(0.0, uBlend, abs(l0.z))));
  o = vec4(c, 1.0);
}`;

// Seam matching cost. Target is N x K: x = seam segment (angle around lens 0's axis), y = depth candidate.
const FS_COST = `${COMMON}
out vec4 o;
uniform int uN, uKn;
uniform float uD0, uD1, uLod;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float bw = 2.0 * PI / float(uN);
  float phi = (float(p.x) + 0.5) * bw - PI;
  float invD = mix(uD0, uD1, float(p.y) / float(uKn - 1));
  mat3 Rt = transpose(uR[0]);
  float sa = 0.0, sb = 0.0, saa = 0.0, sbb = 0.0, sab = 0.0, n = 0.0;
  // parallax moves things across the seam, so the patch is long across it and short along it
  for (int j = -2; j <= 2; j++) {
    for (int t = -6; t <= 6; t++) {
      float ph = phi + float(j) * bw / 2.0;
      float th = float(t) * 0.0131;     // +-4.5 deg either side of the seam
      vec3 d = Rt * vec3(cos(th) * cos(ph), cos(th) * sin(ph), sin(th));
      vec3 a = project(0, d, invD), b = project(1, d, invD);
      if (a.z * b.z < 0.5) continue;
      float A = lum(textureLod(t0, a.xy, uLod).rgb), B = lum(textureLod(t1, b.xy, uLod).rgb);
      sa += A; sb += B; saa += A * A; sbb += B * B; sab += A * B; n += 1.0;
    }
  }
  if (n < 20.0) { o = vec4(1.0, 1.0, 0.0, 1.0); return; }
  float ma = sa / n, mb = sb / n;
  float va = max(saa / n - ma * ma, 0.0), vb = max(sbb / n - mb * mb, 0.0), cv = sab / n - ma * mb;
  // 1 - normalised cross-correlation (insensitive to exposure differences), exposure ratio, texture energy
  o = vec4(1.0 - cv / sqrt(va * vb + 1e-8), ma / max(mb, 1e-3), va + vb, 1.0);
}`;

// Pick the best depth per seam segment (smoothed across neighbours and towards the previous estimate).
const FS_PICK = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D tCost, tPrev;
uniform int uN, uKn;
uniform float uD0, uD1, uAlpha, uLambda, uBase;
const int KMAX = 64;
void main() {
  int i = int(gl_FragCoord.x);
  vec4 prev = texelFetch(tPrev, ivec2(i, 0), 0);
  float cs[KMAX];
  float mean = 0.0, energy = 0.0;
  for (int k = 0; k < KMAX; k++) {
    if (k >= uKn) break;
    float v = 0.0;
    for (int j = -2; j <= 2; j++) {
      vec4 c = texelFetch(tCost, ivec2((i + j + uN) % uN, k), 0);
      v += (3.0 - abs(float(j))) * c.r;
      if (j == 0) energy += c.b;
    }
    cs[k] = v / 9.0;
    mean += cs[k];
  }
  mean /= float(uKn);
  energy /= float(uKn);
  float best = 1e9; int bk = 0;
  for (int k = 0; k < KMAX; k++) {
    if (k >= uKn) break;
    float invD = mix(uD0, uD1, float(k) / float(uKn - 1));
    // prefer the previous estimate (stability) and, weakly, the base depth
    cs[k] += uLambda * (abs(invD - prev.r) + 0.5 * abs(invD - uBase)) / (uD1 - uD0);
    if (cs[k] < best) { best = cs[k]; bk = k; }
  }
  float off = 0.0;
  if (bk > 0 && bk < uKn - 1) {
    float l = cs[bk - 1], r = cs[bk + 1], den = l - 2.0 * best + r;
    if (den > 1e-9) off = clamp(0.5 * (l - r) / den, -0.5, 0.5);
  }
  float target = mix(uD0, uD1, (float(bk) + off) / float(uKn - 1));
  float gain = texelFetch(tCost, ivec2(i, bk), 0).g;
  // trust segments with a clear minimum and some texture; featureless sky/walls keep the old value
  float conf = clamp((mean - best) * 4.0, 0.0, 1.0) * smoothstep(0.0003, 0.003, energy);
  o = vec4(mix(prev.r, target, uAlpha * conf), mix(prev.g, gain, uAlpha * 0.5), 0.0, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fs, names) {
  const pr = gl.createProgram();
  gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(pr, 0, 'p');
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(pr, n);
  return { pr, u };
}

const rad = (d) => (d * Math.PI) / 180;

function rotXYZ(rx, ry, rz) {
  // R = Rz * Ry * Rx, row-major 3x3
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}
const mul = (a, b) => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

// Convert Insta360 offset_v3 lens calibration into normalised shader uniforms. Calibration is in a
// 2-lens side-by-side calibW x calibH space, in the sensor frame (roll ~90 deg); decoded frames are stored
// upright, so the principal point is rotated by 90 deg and the remaining roll is a small correction.
// layout 'tracks': one streamW x streamH texture per lens; 'sbs': both lenses side by side in one texture.
export function lensUniforms(lenses, streamW, streamH, layout = 'tracks') {
  const out = lenses.map((L, i) => {
    const lensW = L.calibW / 2, lensH = L.calibH;
    const perLensW = layout === 'sbs' ? streamW / 2 : streamW;
    const s = perLensW / lensW, sv = streamH / lensH;
    const cxUp = (lensW - L.cy) * s + (layout === 'sbs' ? i * perLensW : 0);
    const cyUp = (L.cx - i * lensW) * sv;
    // back lens looks the other way: 180 deg about the vertical (y-down) axis
    const base = i ? [-1, 0, 0, 0, 1, 0, 0, 0, -1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const corr = rotXYZ(rad(L.pitch), rad(L.yaw), rad(L.roll - 90));
    return {
      C: [0, 0, 0],
      K: [(L.fx * s) / streamW, (L.fy * sv) / streamH, cxUp / streamW, cyUp / streamH],
      D: [L.k1, L.k2, L.k3, L.xi],
      P: [L.p1, L.p2],
      R: mul(corr, transpose(base)),
    };
  });
  // Lens 1's position relative to lens 0 (metres, lens-0 frame). The rig centre is their midpoint.
  const L1 = lenses[1] || {};
  const t = [L1.tx || 0, L1.ty || 0, L1.tz || 0];
  const R0 = out[0].R; // world -> lens0, so world = R0^T * v
  const tw = [0, 1, 2].map((j) => R0[j] * t[0] + R0[3 + j] * t[1] + R0[6 + j] * t[2]);
  out[0].C = tw.map((v) => -v / 2);
  if (out[1]) out[1].C = tw.map((v) => v / 2);
  return out;
}

// Typical X-series calibration, used if a file has no readable calibration.
export const GENERIC_LENSES = [0, 1].map((i) => ({
  xi: 2.3, fx: 7125, fy: 7125, cx: 3840 + i * 7680, cy: 3840, yaw: 0, pitch: 0, roll: 90, tx: 0, ty: 0, tz: i ? -0.033 : 0,
  k1: 0.97, k2: -2.02, k3: 3.98, p1: 0, p2: 0, calibW: 15360, calibH: 7680,
}));
const LENS_UNIFORMS = ['t0', 't1', 'uK', 'uD', 'uP', 'uR', 'uC'];

export class Pano {
  constructor(canvas) {
    this.cv = canvas;
    const gl = (this.gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false }));
    if (!gl) throw new Error('WebGL2 not available');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.main = program(gl, FS, [...LENS_UNIFORMS, 'uSrc', 'uOut', 'uDyn', 'uYaw', 'uPitch', 'uTanY', 'uAspect', 'uBlend', 'uInvD', 'tSeam', 'uColor', 'uShowSeam', 'uSharp', 'uDefringe']);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.tex = [0, 1].map((i) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // the fisheye edge (where the seam is) is squashed radially, so plain mipmapping blurs it; anisotropic filtering doesn't
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    });
    this.src = 'equirect';
    // user settings (see set())
    this.mode = 'dynamic';  // 'dynamic' | 'fixed' | 'off'
    this.blend = 0.05;      // seam crossfade half-width (sin of angle, ~3 deg)
    this.invD = 2;          // fixed stitch depth (1/m); also the base depth away from the seam in dynamic mode
    this.colorMatch = true;
    this.sharpen = 0;
    this.defringe = 0;
    this.showSeam = false;
    this.N = 192;           // seam segments
    this.Kn = 49;         // depth candidates
    this.d0 = 0; this.d1 = 16;
    this.dynamic = false;
    try { this.initDynamic(); } catch (e) { console.warn('dynamic stitching unavailable:', e); }
    gl.useProgram(this.main.pr);
    gl.uniform1i(this.main.u.t0, 0);
    gl.uniform1i(this.main.u.t1, 1);
    gl.uniform1i(this.main.u.tSeam, 2);
  }

  initDynamic() {
    const gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');

    this.cost = program(gl, FS_COST, [...LENS_UNIFORMS, 'uN', 'uKn', 'uD0', 'uD1', 'uLod']);
    this.pick = program(gl, FS_PICK, ['tCost', 'tPrev', 'uN', 'uKn', 'uD0', 'uD1', 'uAlpha', 'uLambda', 'uBase']);
    const target = (w, h, fmt, filter, data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, gl.FLOAT, data || null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('float framebuffer incomplete');
      return { t, fb };
    };
    gl.activeTexture(gl.TEXTURE3);
    this.costT = target(this.N, this.Kn, gl.RGBA32F, gl.NEAREST);
    const init = new Float32Array(this.N * 4);
    this.seamInit = init;
    this.seam = [0, 1].map(() => target(this.N, 1, gl.RGBA16F, gl.LINEAR, null));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.cost.pr);
    gl.uniform1i(this.cost.u.t0, 0);
    gl.uniform1i(this.cost.u.t1, 1);
    gl.uniform1i(this.cost.u.uN, this.N);
    gl.uniform1i(this.cost.u.uKn, this.Kn);
    gl.uniform1f(this.cost.u.uD0, this.d0);
    gl.uniform1f(this.cost.u.uD1, this.d1);
    gl.useProgram(this.pick.pr);
    gl.uniform1i(this.pick.u.tCost, 3);
    gl.uniform1i(this.pick.u.tPrev, 2);
    gl.uniform1i(this.pick.u.uN, this.N);
    gl.uniform1i(this.pick.u.uKn, this.Kn);
    gl.uniform1f(this.pick.u.uD0, this.d0);
    gl.uniform1f(this.pick.u.uD1, this.d1);
    gl.uniform1f(this.pick.u.uLambda, 0.1);
    gl.uniform1f(this.pick.u.uBase, this.invD);
    this.cur = 0;
    this.dynamic = true;
    this.resetSeam();
  }

  // Update user settings: { mode, distance (m, Infinity ok), fusionAngle (deg), colorMatch, sharpen (0-1), defringe (0-1), showSeam }
  set(o) {
    // distance first: a reset seeds the seam with it
    if (o.distance !== undefined) this.invD = Math.min(this.d1, 1 / Math.max(o.distance, 0.125));
    if (o.mode && o.mode !== this.mode) { this.mode = o.mode; this.resetSeam(); }
    if (o.fusionAngle !== undefined) this.blend = Math.sin(rad(Math.max(0.2, o.fusionAngle) / 2));
    if (o.colorMatch !== undefined) this.colorMatch = !!o.colorMatch;
    if (o.sharpen !== undefined) this.sharpen = +o.sharpen;
    if (o.defringe !== undefined) this.defringe = +o.defringe;
    if (o.showSeam !== undefined) this.showSeam = !!o.showSeam;
  }

  setEquirect() { this.src = 'equirect'; }

  // shared: both lenses are in texture 0 (side-by-side layout)
  setDualFisheye(lensU, shared = false) {
    this.src = 'dualfisheye';
    const gl = this.gl;
    for (const p of [this.main, this.cost].filter(Boolean)) {
      gl.useProgram(p.pr);
      gl.uniform1i(p.u.t1, shared ? 0 : 1);
      gl.uniform4fv(p.u.uK, lensU.flatMap((l) => l.K));
      gl.uniform4fv(p.u.uD, lensU.flatMap((l) => l.D));
      gl.uniform2fv(p.u.uP, lensU.flatMap((l) => l.P));
      gl.uniformMatrix3fv(p.u.uR, true, lensU.flatMap((l) => l.R));
      gl.uniform3fv(p.u.uC, lensU.flatMap((l) => l.C));
    }
    // texel size at LOD 0 is ~1/texture width; sample the belt around 4-8 px per texel
    this.lod = 2.5;
    this.resetSeam();
  }

  // Forget the stitch estimate (new file or a seek), so the next estimate() starts fresh.
  resetSeam() {
    if (!this.dynamic) return;
    const gl = this.gl;
    for (let i = 0; i < this.N; i++) this.seamInit.set([this.invD, 1, 0, 1], i * 4);
    gl.activeTexture(gl.TEXTURE2);
    for (const s of this.seam) {
      gl.bindTexture(gl.TEXTURE_2D, s.t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.N, 1, gl.RGBA, gl.FLOAT, this.seamInit);
    }
  }

  upload(i, source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  // Update the per-segment stitch depth from the current lens textures.
  // alpha: how far to move towards the new measurement (1 = jump, e.g. when paused or after a seek).
  estimate(alpha = 0.3) {
    if (!this.dynamic || this.src !== 'dualfisheye' || this.mode === 'off') return;
    const gl = this.gl;
    gl.useProgram(this.cost.pr);
    gl.uniform1f(this.cost.u.uLod, this.lod);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.costT.fb);
    gl.viewport(0, 0, this.N, this.Kn);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const next = 1 - this.cur;
    gl.useProgram(this.pick.pr);
    gl.uniform1f(this.pick.u.uAlpha, alpha);
    gl.uniform1f(this.pick.u.uBase, this.invD);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.costT.t);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.seam[this.cur].t);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.seam[next].fb);
    gl.viewport(0, 0, this.N, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = next;
  }

  resize(w, h) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
  }

  render({ lon = 0, lat = 0, fov = 75, out = 'view' } = {}) {
    const gl = this.gl, u = this.main.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.main.pr);
    if (this.dynamic) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.seam[this.cur].t);
    }
    gl.viewport(0, 0, this.cv.width, this.cv.height);
    gl.uniform1i(u.uSrc, this.src === 'dualfisheye' ? 1 : 0);
    gl.uniform1i(u.uOut, out === 'equirect' ? 1 : 0);
    const dyn = this.dynamic && this.mode === 'dynamic';
    gl.uniform1i(u.uDyn, dyn ? 1 : 0);
    gl.uniform1i(u.uColor, this.colorMatch && this.dynamic && this.mode !== 'off' ? 1 : 0);
    gl.uniform1i(u.uShowSeam, this.showSeam ? 1 : 0);
    gl.uniform1f(u.uSharp, this.sharpen);
    gl.uniform1f(u.uDefringe, this.defringe);
    gl.uniform1f(u.uYaw, rad(lon));
    gl.uniform1f(u.uPitch, rad(lat));
    gl.uniform1f(u.uTanY, Math.tan(rad(fov) / 2));
    gl.uniform1f(u.uAspect, this.cv.width / this.cv.height);
    gl.uniform1f(u.uBlend, this.blend);
    gl.uniform1f(u.uInvD, this.mode === 'off' ? 0 : this.invD);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}