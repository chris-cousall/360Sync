// Column rename table shown when a telemetry file is loaded. Renames are remembered by original column name.
const KEY = 'colNames';
const $ = (id) => document.getElementById(id);

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

// keep the file's own names, then apply any saved renames
export function applySavedNames(raw) {
  raw.origNames = [...raw.names];
  raw.origUnits = [...raw.units];
  const saved = load();
  raw.names = raw.origNames.map((n) => (saved[n] && saved[n].name) || n);
  raw.units = raw.origUnits.map((u, i) => (saved[raw.origNames[i]] && saved[raw.origNames[i]].unit !== undefined ? saved[raw.origNames[i]].unit : u));
}

export const showOnLoad = () => localStorage.getItem('colDialogOnLoad') !== '0';

function range(col) {
  let lo = Infinity, hi = -Infinity;
  const step = Math.max(1, Math.floor(col.length / 20000));
  for (let i = 0; i < col.length; i += step) { const v = col[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (lo > hi) return '–';
  const f = (v) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v)) : v.toPrecision(4).replace(/\.?0+$/, ''));
  return lo === hi ? f(lo) : `${f(lo)} … ${f(hi)}`;
}

// Opens the table. Resolves true if names were applied, false if cancelled.
export function editColumns(raw, fileName) {
  const dlg = $('colDialog'), body = $('colRows'), filter = $('colFilter');
  $('colFile').textContent = fileName || '';
  $('colShowOnLoad').checked = showOnLoad();
  filter.value = '';
  const rows = raw.origNames.map((orig, i) => {
    const tr = document.createElement('tr');
    const name = Object.assign(document.createElement('input'), { value: raw.names[i], placeholder: orig, spellcheck: false });
    const unit = Object.assign(document.createElement('input'), { value: raw.units[i] || '', className: 'unit', spellcheck: false });
    const td = (...c) => { const e = document.createElement('td'); e.append(...c); return e; };
    const o = td(orig);
    o.className = 'orig';
    o.title = raw.origUnits[i] ? `${orig} [${raw.origUnits[i]}]` : orig;
    const r = td(range(raw.cols[i]));
    r.className = 'rng';
    tr.append(td(String(i + 1)), o, td(name), td(unit), r);
    return { tr, name, unit, orig, i };
  });
  body.replaceChildren(...rows.map((r) => r.tr));
  filter.oninput = () => {
    const f = filter.value.trim().toLowerCase();
    for (const r of rows) r.tr.hidden = !!f && !r.orig.toLowerCase().includes(f) && !r.name.value.toLowerCase().includes(f);
  };
  $('colResetNames').onclick = () => {
    for (const r of rows) { r.name.value = r.orig; r.unit.value = raw.origUnits[r.i] || ''; }
  };

  return new Promise((resolve) => {
    const done = (ok) => {
      dlg.close();
      localStorage.setItem('colDialogOnLoad', $('colShowOnLoad').checked ? '1' : '0');
      if (!ok) return resolve(false);
      const saved = load();
      for (const r of rows) {
        const name = r.name.value.trim() || r.orig, unit = r.unit.value.trim();
        raw.names[r.i] = name;
        raw.units[r.i] = unit;
        if (name === r.orig && unit === (raw.origUnits[r.i] || '')) delete saved[r.orig];
        else saved[r.orig] = { name, unit };
      }
      localStorage.setItem(KEY, JSON.stringify(saved));
      resolve(true);
    };
    $('colApply').onclick = () => done(true);
    $('colCancel').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') done(true); };
    dlg.showModal();
    const first = rows[0];
    if (first) first.name.focus();
  });
}
