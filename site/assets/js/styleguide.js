// Styleguide page behaviour (demo only, not used by the site).
import { createCompare } from './compare.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- Theme radio group ----------
const themeRadios = $$('input[name="theme"]');
function syncThemeRadios() {
  const pref = window.squishlessTheme ? window.squishlessTheme.get() : 'system';
  for (const r of themeRadios) r.checked = r.value === pref;
}
themeRadios.forEach((r) => r.addEventListener('change', () => window.squishlessTheme.set(r.value)));
document.addEventListener('squishless:themechange', () => { syncThemeRadios(); renderSwatches(); });
syncThemeRadios();

// ---------- Colour swatches with live contrast ----------
const SWATCHES = [
  ['--color-bg', null], ['--color-surface', null], ['--color-raised', null], ['--color-sunken', null],
  ['--color-text', '--color-bg'], ['--color-muted', '--color-bg'], ['--color-subtle', '--color-surface'],
  ['--color-border', '--color-bg', 'decorative'], ['--color-border-strong', '--color-bg', 'ui'],
  ['--color-accent', '--color-bg', 'ui'], ['--color-accent-ink', '--color-accent'], ['--color-accent-text', '--color-bg'],
  ['--color-accent-soft', null], ['--color-highlight', null],
  ['--color-success', '--color-bg'], ['--color-warning', '--color-bg'], ['--color-danger', '--color-bg'],
  ['--color-focus', '--color-bg', 'ui'],
];
const probe = document.createElement('span');
probe.hidden = true;
document.body.appendChild(probe);
function resolveColor(token) {
  probe.style.color = `var(${token})`;
  const m = getComputedStyle(probe).color.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
function lum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function renderSwatches() {
  const host = $('#swatches');
  if (!host) return;
  host.textContent = '';
  for (const [token, against, kind] of SWATCHES) {
    const c = resolveColor(token);
    const row = document.createElement('div');
    row.className = 'sg-swatch';
    const chip = document.createElement('span');
    chip.className = 'sg-swatch__chip';
    chip.style.background = `var(${token})`;
    if (against) { chip.style.color = `var(${against})`; chip.textContent = 'Aa'; }
    const meta = document.createElement('div');
    meta.className = 'sg-swatch__meta';
    const name = document.createElement('code');
    name.textContent = token;
    const info = document.createElement('span');
    let text = hex(c);
    if (against) {
      const r = ratio(c, resolveColor(against));
      const need = kind === 'ui' ? 3 : 4.5;
      text += `, ${r.toFixed(2)}:1 on ${against.replace('--color-', '')}`;
      if (kind !== 'decorative') text += r >= need ? (kind === 'ui' ? ' (UI ok)' : ' (AA)') : ' (FAIL)';
      else text += ' (decorative)';
    }
    info.textContent = text;
    meta.append(name, info);
    row.append(chip, meta);
    host.appendChild(row);
  }
}
renderSwatches();

// ---------- Spacing ----------
const spaces = $('#spaces');
for (let i = 1; i <= 9; i++) {
  const row = document.createElement('div');
  row.className = 'sg-space';
  const code = document.createElement('code');
  code.textContent = `--space-${i}`;
  const bar = document.createElement('span');
  bar.className = 'sg-space__bar';
  bar.style.width = `var(--space-${i})`;
  row.append(code, bar);
  spaces.appendChild(row);
}

// ---------- Motion ----------
const motion = $('#motion-demo');
$('#motion-play').addEventListener('click', () => {
  const track = motion.querySelector('.sg-motion__track');
  motion.style.setProperty('--sg-travel', `${track.clientWidth - 48}px`);
  motion.classList.toggle('is-on');
});

// ---------- Range fill + output ----------
for (const range of $$('input.range')) {
  const out = document.getElementById(range.id + '-out');
  const update = () => {
    const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
    range.style.setProperty('--range-pct', pct + '%');
    if (out) out.textContent = range.value;
  };
  range.addEventListener('input', update);
  update();
}

// ---------- Chips (single select) ----------
$$('.chip-row .chip').forEach((chip, _, all) => chip.addEventListener('click', () => {
  for (const c of all) c.setAttribute('aria-pressed', String(c === chip));
}));

// ---------- Drop zone drag state ----------
const dz = $('#dropzone');
let depth = 0;
dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; dz.classList.add('is-dragover'); });
dz.addEventListener('dragover', (e) => e.preventDefault());
dz.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('is-dragover'); } });
dz.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; dz.classList.remove('is-dragover'); });

// ---------- Progress ----------
let progTimer = 0;
$('#p1-run').addEventListener('click', () => {
  const p = $('#p1'), t = $('#p1-text');
  clearInterval(progTimer);
  let v = 0;
  progTimer = setInterval(() => {
    v = Math.min(100, v + 4 + Math.random() * 8);
    p.value = v;
    t.textContent = Math.round(v) + '%';
    if (v >= 100) clearInterval(progTimer);
  }, 120);
});

// ---------- Toasts ----------
const region = $('#toasts');
function toast(message, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ` toast--${kind}` : '');
  el.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
  const body = document.createElement('div');
  body.className = 'toast__body';
  body.textContent = message;
  const close = document.createElement('button');
  close.className = 'btn btn--ghost btn--icon btn--sm toast__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  el.append(body, close);
  const dismiss = () => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  };
  close.addEventListener('click', dismiss);
  setTimeout(dismiss, 5000);
  region.appendChild(el);
}
$$('[data-toast]').forEach((b) => b.addEventListener('click', () => toast(b.dataset.toast, b.dataset.toastKind)));

// ---------- Dialog ----------
const dlg = $('#demo-dialog');
$('#open-dialog').addEventListener('click', () => dlg.showModal());
dlg.addEventListener('close', () => {
  if (dlg.returnValue === 'ok') toast('Shrunk to 24 MP', 'success');
});
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); }); // backdrop click

// ---------- Compare ----------
const ORIGINAL = '/samples/portrait-field.jpg';
const CARVED = '/assets/img/demo-portrait-squishless.jpg';
const NORMAL = '/assets/img/demo-portrait-normal.jpg';
const cmp = createCompare($('#compare-demo'), { before: ORIGINAL, after: CARVED, mode: 'slider' });
window.__compare = cmp; // for automated checks
function applyPair(mode) {
  return cmp.set({ before: mode === 'normal' ? NORMAL : ORIGINAL, after: CARVED });
}
$$('input[name="cmode"]').forEach((r) => r.addEventListener('change', () => {
  cmp.setMode(r.value);
  applyPair(r.value);
}));
$('#cmp-nudge').addEventListener('click', () => cmp.nudge());
