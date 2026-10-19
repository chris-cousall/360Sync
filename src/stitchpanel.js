// Side panel with the Insta360 stitching / image settings. Settings are remembered between sessions.
const $ = (id) => document.getElementById(id);
const KEY = 'stitch';
const STITCH_DEFAULTS = { mode: 'dynamic', distance: 0.5, fusionAngle: 4, colorMatch: true, sharpen: 0.25, defringe: 0.5, showSeam: false };

// distance slider: 0..99 = 0.3 m .. 30 m (log), 100 = infinity
const toDist = (v) => (v >= 100 ? Infinity : 0.3 * Math.pow(100, v / 99));
const fromDist = (d) => (!isFinite(d) ? 100 : Math.round((99 * Math.log(d / 0.3)) / Math.log(100)));
const fmtDist = (d) => (!isFinite(d) ? '∞' : d < 10 ? `${d.toFixed(1)} m` : `${Math.round(d)} m`);

export function initStitchPanel(player) {
  let s = { ...STITCH_DEFAULTS };
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }
  if (s.distance === null) s.distance = Infinity; // JSON has no Infinity

  const panel = $('stitchPanel'), btn = $('btnStitch');
  const show = (on) => {
    panel.hidden = !on;
    btn.classList.toggle('on', on);
    player.resize();
  };
  btn.addEventListener('click', () => {
    localStorage.setItem('stitchPanel', panel.hidden ? '1' : '0');
    show(panel.hidden);
  });

  const render = () => {
    for (const r of document.querySelectorAll('input[name=stMode]')) r.checked = r.value === s.mode;
    $('stDist').value = fromDist(s.distance);
    $('stDistV').textContent = fmtDist(s.distance);
    $('stDist').closest('.sl').classList.toggle('off', s.mode !== 'fixed');
    $('stDist').disabled = s.mode !== 'fixed';
    $('stFuse').value = s.fusionAngle;
    $('stFuseV').textContent = `${s.fusionAngle}°`;
    $('stColor').checked = s.colorMatch;
    $('stColor').disabled = s.mode === 'off';
    $('stSharp').value = Math.round(s.sharpen * 100);
    $('stSharpV').textContent = `${Math.round(s.sharpen * 100)}%`;
    $('stFringe').value = Math.round(s.defringe * 100);
    $('stFringeV').textContent = `${Math.round(s.defringe * 100)}%`;
    $('stSeam').checked = s.showSeam;
  };
  const apply = (o) => {
    Object.assign(s, o);
    localStorage.setItem(KEY, JSON.stringify(s));
    player.setStitch(s);
    render();
  };

  for (const r of document.querySelectorAll('input[name=stMode]')) r.addEventListener('change', () => apply({ mode: r.value }));
  $('stDist').addEventListener('input', (e) => apply({ distance: toDist(+e.target.value) }));
  $('stFuse').addEventListener('input', (e) => apply({ fusionAngle: +e.target.value }));
  $('stColor').addEventListener('change', (e) => apply({ colorMatch: e.target.checked }));
  $('stSharp').addEventListener('input', (e) => apply({ sharpen: +e.target.value / 100 }));
  $('stFringe').addEventListener('input', (e) => apply({ defringe: +e.target.value / 100 }));
  $('stSeam').addEventListener('change', (e) => apply({ showSeam: e.target.checked }));
  $('stReset').addEventListener('click', () => apply({ ...STITCH_DEFAULTS }));
  apply({});

  return {
    // called when the loaded video changes; the panel only applies to Insta360 files
    setEnabled(on) {
      btn.disabled = !on;
      show(on && localStorage.getItem('stitchPanel') !== '0');
    },
    // projects (JSON stores Infinity as null)
    get: () => ({ ...s, distance: isFinite(s.distance) ? s.distance : null }),
    set: (o) => apply({ ...STITCH_DEFAULTS, ...(o || {}), distance: o && o.distance === null ? Infinity : (o && o.distance) || STITCH_DEFAULTS.distance }),
  };
}
