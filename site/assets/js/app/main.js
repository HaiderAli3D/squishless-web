// Squishless app: wires the photos, the stage, the panel, compare and export together.

import { getEngine } from '../engine.js';
import { takeFiles } from '../handoff.js';
import { createCompare } from '../compare.js';
import { Photo, isAbort } from './photo.js';
import { Stage, LABEL_KEEP, LABEL_REMOVE, LABEL_NONE } from './stage.js';
import {
  PRESETS, FINE_DEFAULTS, loadSettings, saveSettings, carveOpts, carveSig, batchTarget, clampTarget,
} from './settings.js';
import { encodeResult, downloadBlob, zipEntries, canShareFiles, shareFile } from './exporter.js';
import { $, $$, el, clamp, debounce, isMac, toast, setToastHooks, announce, loadJSON, saveJSON, formatMP, reducedMotion } from './util.js';

const engine = getEngine();
const settings = loadSettings();
const photos = [];
let selected = null;
let view = 'edit';          // edit | compare
let marking = false;
let cmpMode = 'slider';
let compare = null;
let batch = null;           // { total, ctrl } while "Resize all" runs
let engineState = 'idle';   // idle | loading | ready | error
const COACH_KEY = 'squishless-coach-done';

const ui = {
  body: document.body,
  welcome: $('#welcome'),
  editor: $('#editor'),
  editorTitle: $('#editor-title'),
  workspace: $('#editor .workspace'),
  toolbar: $('#editor .toolbar'),
  handleX: $('#handle-x'),
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  chooseBtn: $('#choose-btn'),
  addBtn: $('#add-btn'),
  filmList: $('#film-list'),
  stageRoot: $('#stage'),
  readoutSize: $('#readout-size'),
  readoutFrom: $('#readout-from'),
  markBtn: $('#mark-btn'),
  brushBar: $('#brush-bar'),
  brushSize: $('#brush-size'),
  undoBtn: $('#undo-btn'),
  clearBtn: $('#clear-btn'),
  markDone: $('#mark-done'),
  brushHint: $('#brush-hint'),
  shortcuts: $('#shortcuts'),
  shortcutsAll: $('#shortcuts-all'),
  shortcutsBrush: $('#shortcuts-brush'),
  compareBar: $('#compare-bar'),
  compareWrap: $('#compare-wrap'),
  compareWait: $('#compare-wait'),
  job: $('#job'),
  jobFill: $('#job-fill'),
  jobText: $('#job-text'),
  jobCancel: $('#job-cancel'),
  jobRetry: $('#job-retry'),
  skeleton: $('#stage-skeleton'),
  notice: $('#notice'),
  noticeTitle: $('#notice-title'),
  noticeText: $('#notice-text'),
  noticeActions: $('#notice-actions'),
  panel: $('#panel'),
  sheetToggle: $('#sheet-toggle'),
  moreBtn: $('#more-btn'),
  presets: $('#presets'),
  sizeNote: $('#size-note'),
  adjusted: $('#adjusted'),
  adjustedReset: $('#adjusted-reset'),
  custom: $('#custom'),
  cw: $('#c-w'),
  ch: $('#c-h'),
  cwUnit: $('#c-w-unit'),
  chUnit: $('#c-h-unit'),
  cLock: $('#c-lock'),
  customHint: $('#custom-hint'),
  faces: $('#opt-faces'),
  blur: $('#opt-blur'),
  blurOut: $('#opt-blur-out'),
  sobel: $('#opt-sobel'),
  sobelOut: $('#opt-sobel-out'),
  fineReset: $('#fine-reset'),
  fmtHint: $('#fmt-hint'),
  qualityRow: $('#quality-row'),
  quality: $('#opt-quality'),
  qualityOut: $('#opt-quality-out'),
  resizeAll: $('#resize-all'),
  batchbar: $('#batchbar'),
  batchProgress: $('#batch-progress'),
  batchText: $('#batch-text'),
  downloadBtn: $('#download-btn'),
  downloadLabel: $('#download-label'),
  zipBtn: $('#zip-btn'),
  shareBtn: $('#share-btn'),
  engineChip: $('#engine-chip'),
  dropOverlay: $('#drop-overlay'),
};

// ====================================================================== targets

const maxPixels = () => engine.limits.maxPixels;
const sig = () => carveSig(settings);
const opts = () => carveOpts(settings);

function targetOf(p) {
  if (p.override) return p.override;
  const t = batchTarget(p.W, p.H, settings, maxPixels());
  return { w: t.w, h: t.h };
}

function persist() { saveSettings(settings); }

// ====================================================================== stage

let mapWanted = { x: false, y: false };
const stage = new Stage(ui.stageRoot, {
  sig,
  maxPixels,
  target: (p) => targetOf(p),
  input: onStageInput,
  needMap: (axis) => {
    if (!selected || mapWanted[axis]) return;
    mapWanted[axis] = true;
    queueMicrotask(() => {
      mapWanted[axis] = false;
      if (selected) selected.ensureMap(axis, opts(), sig()).then(() => stage.render());
    });
  },
  marksChanged: onMarksChanged,
  dragStart: () => dismissCoach(),
});

function onStageInput(w, h, phase) {
  const p = selected;
  if (!p) return;
  if (photos.length === 1) {
    // One photo: dragging is simply choosing a custom size.
    settings.preset = 'custom';
    settings.custom.mode = 'px';
    settings.custom.w = w;
    settings.custom.h = h;
    p.override = null;
    if (phase !== 'move') persist();
  } else {
    const b = batchTarget(p.W, p.H, settings, maxPixels());
    p.override = b.w === w && b.h === h ? null : { w, h };
  }
  updateReadout();
  dismissCoach();
  if (phase !== 'move') {
    updatePanel();
    renderFilm();
    if (phase === 'end') scheduleCompute(0);
    else scheduleCompute(450);
    announce(`${w} by ${h} pixels`);
  } else {
    scheduleCompute.cancel();
    if (p.job) p.cancel();
  }
}

// ====================================================================== compute

const scheduleCompute = debounce(() => computeSelected(), 350);

async function computeSelected() {
  const p = selected;
  if (!p || p.status !== 'ready' || marking) return;
  const t = targetOf(p);
  if (p.hasResult(t.w, t.h, sig())) { refreshStage(); return; }
  // Cancelled by the user: wait for Resize, a new size or a download.
  if (p.cancelledKey && p.cancelledKey === p.resultKey(t.w, t.h, sig())) { updateJob(); return; }
  try {
    const r = await p.compute(t.w, t.h, opts(), sig());
    if (p !== selected) return;
    refreshStage();
    if (view === 'compare') showCompare();
    if (r.img !== p.img) {
      announce(`Resized to ${r.w} by ${r.h} pixels`);
      maybeOfferNormal();
    }
  } catch (err) {
    if (isAbort(err)) return;
    handleEngineError(err, p);
  }
}

function handleEngineError(err, p) {
  console.error(err);
  if (err && err.code === 'ENGINE_LOAD') {
    setEngineState('error');
    return;
  }
  const msg = err && err.code === 'ENGINE_CRASH'
    ? `“${p.name}” is too much for this device right now. Try a smaller size, or shrink the photo first.`
    : `Could not resize “${p.name}”. ${err && err.message ? err.message : ''}`;
  toast(msg, { kind: 'danger', timeout: 9000 });
}

let offeredNormal = false;
let closeNormalToast = null;
function maybeOfferNormal() {
  // Not during or after "Resize all": the batch has its own toast.
  if (offeredNormal || view !== 'edit' || batch) return;
  offeredNormal = true;
  if (loadJSON('squishless-normal-offered', false)) return;
  saveJSON('squishless-normal-offered', true);
  closeNormalToast = toast('Curious what a normal resize would have done?', {
    action: { label: 'Show me', fn: () => { setCmpMode('normal'); setView('compare'); } },
    timeout: 6000,
  });
}

// ====================================================================== photos

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const accepted = [];
  for (const f of files) {
    if (f.type && !f.type.startsWith('image/')) {
      toast(`“${f.name}” is not a photo. Squishless opens images like JPG, PNG and WebP.`, { kind: 'warning' });
      continue;
    }
    accepted.push(f);
  }
  if (!accepted.length) return;
  startEngine();
  const added = accepted.map((f) => {
    const p = new Photo(f);
    p.onChange = onPhotoChange;
    photos.push(p);
    return p;
  });
  showEditor();
  if (!selected || photos.length === added.length) select(added[0]);
  renderFilm();
  announce(added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} photos`);
  // Decode one at a time: each decode holds a full-size bitmap.
  for (const p of added) {
    await p.load();
    if (p.status === 'error' && !photos.includes(p)) continue;
  }
}

function onPhotoChange(p, what) {
  if (what === 'status') {
    renderFilm();
    if (p === selected) {
      stage.setPhoto(p);
      updateStageState();
      updateReadout();
      updatePanel();
      if (p.status === 'ready') {
        maybeCoach();
        scheduleCompute(150);
        warmMaps(p);
      }
    }
    if (p.status === 'error' && p !== selected) {
      toast(p.error, { kind: 'danger', timeout: 8000 });
    }
    updateActions();
    return;
  }
  if (what === 'map') { if (p === selected) stage.render(); return; }
  if (what === 'progress' || what === 'job' || what === 'result') {
    updateFilmItem(p);
    if (p === selected) updateJob();
    if (batch) updateBatch();
    if (what === 'result' && p === selected) refreshStage();
    updateActions();
  }
}

/** Builds the width map, then the height map, so drags on either handle are instant. */
function warmMaps(p) {
  if (!p || p.status !== 'ready') return;
  p.ensureMap('x', opts(), sig()).then((m) => {
    if (p === selected) stage.render();
    if (m && p === selected && !marking) p.ensureMap('y', opts(), sig()).then(() => { if (p === selected) stage.render(); });
  });
}

function select(p) {
  if (selected === p) return;
  if (selected && selected.job && !batch) selected.cancel();
  selected = p;
  if (marking) setMarking(false, { compute: false });
  ui.editorTitle.textContent = p ? `Editing ${p.name}` : 'Editor';
  stage.setPhoto(p);
  renderFilm();
  updateStageState();
  updateReadout();
  updatePanel();
  updateJob();
  updateActions();
  if (p && p.status === 'ready') {
    scheduleCompute(120);
    warmMaps(p);
  }
  if (view === 'compare') showCompare();
}

/** Photos removed in the last few seconds: kept (not disposed) so Undo can bring them back. */
const removedPhotos = new Set();

function removePhoto(p) {
  const i = photos.indexOf(p);
  if (i < 0) return;
  const ae = document.activeElement;
  const focusLost = !ae || ae === document.body || ui.filmList.contains(ae) || ui.notice.contains(ae);
  photos.splice(i, 1);
  p.cancel();
  if (selected === p) {
    selected = null;
    const next = photos[Math.min(i, photos.length - 1)];
    if (next) select(next);
  }
  renderFilm();
  updateActions();
  if (!photos.length) showWelcome();
  if (focusLost) {
    const next = photos[Math.min(i, photos.length - 1)];
    const thumb = next && ui.filmList.querySelector(`.film[data-id="${next.id}"] .film__thumb`);
    (thumb || (photos.length ? ui.addBtn : ui.chooseBtn)).focus({ preventScroll: true });
  }
  // Free the memory only once the Undo offer is gone.
  removedPhotos.add(p);
  toast(`Removed “${p.name}”.`, {
    action: { label: 'Undo', fn: () => restorePhoto(p, i) },
    timeout: 7000,
    onClose: () => setTimeout(() => {
      if (removedPhotos.delete(p)) p.dispose();
    }, 0),
  });
}

function restorePhoto(p, i) {
  if (!removedPhotos.delete(p)) return;
  photos.splice(Math.min(i, photos.length), 0, p);
  if (ui.editor.hidden) showEditor();
  renderFilm();
  select(p);
  updateActions();
  announce(`Restored ${p.name}`);
  const thumb = ui.filmList.querySelector(`.film[data-id="${p.id}"] .film__thumb`);
  if (thumb) thumb.focus({ preventScroll: true });
}

function refreshStage() {
  stage.render();
  updateReadout();
  updateJob();
}

// ====================================================================== filmstrip

function statusOf(p) {
  if (p.status !== 'ready') return p.status;
  if (p.job) return 'working';
  const t = targetOf(p);
  if (p.hasResult(t.w, t.h, sig()) && p.result.img !== p.img) return 'done';
  return 'idle';
}

const STATUS_TEXT = {
  loading: 'opening', toobig: 'too big, needs shrinking', error: 'cannot be opened',
  working: 'resizing', done: 'resized', idle: 'not resized yet',
};

function renderFilm() {
  updateSizeNote();
  const list = ui.filmList;
  const ids = new Set(photos.map((p) => p.id));
  const existing = new Map();
  for (const n of $$('.film', list)) {
    if (ids.has(Number(n.dataset.id))) existing.set(Number(n.dataset.id), n);
    else n.remove();
  }
  let prev = null;
  for (const p of photos) {
    const li = existing.get(p.id) || makeFilmItem(p);
    const want = prev ? prev.nextElementSibling : list.firstElementChild;
    // Move a node only when it is out of place: moving restarts its entrance animation.
    if (li !== want) list.insertBefore(li, want);
    prev = li;
    updateFilmItem(p, li);
  }
  ui.body.classList.toggle('has-many', photos.length > 1);
  updateShortcuts();
}

function makeFilmItem(p) {
  const li = el('li', 'film is-new');
  li.dataset.id = p.id;
  li.addEventListener('animationend', (e) => { if (e.target === li) li.classList.remove('is-new'); });
  const btn = el('button', 'film__thumb', { type: 'button' });
  const canvas = el('canvas', 'film__img', { width: '112', height: '112', 'aria-hidden': 'true' });
  const badge = el('span', 'film__badge', { 'aria-hidden': 'true' });
  btn.append(canvas, badge);
  btn.addEventListener('click', () => select(p));
  const rm = el('button', 'film__remove', { type: 'button', 'aria-label': `Remove ${p.name}` });
  rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
  rm.addEventListener('click', (e) => { e.stopPropagation(); removePhoto(p); });
  li.append(btn, rm);
  return li;
}

function updateFilmItem(p, li) {
  li = li || ui.filmList.querySelector(`.film[data-id="${p.id}"]`);
  if (!li) return;
  const btn = li.firstChild;
  const st = statusOf(p);
  li.dataset.status = st;
  li.classList.toggle('is-selected', p === selected);
  btn.setAttribute('aria-current', p === selected ? 'true' : 'false');
  btn.setAttribute('aria-label', `${p.name}, ${STATUS_TEXT[st] || ''}${p.override ? ', own size' : ''}`);
  li.classList.toggle('is-adjusted', !!p.override);
  const prog = p.job ? p.job.progress : 0;
  li.style.setProperty('--p', String(Math.round(prog * 100)));
  const canvas = btn.querySelector('canvas');
  if (p.display && !canvas.dataset.drawn) {
    const ctx = canvas.getContext('2d');
    const s = Math.max(112 / p.display.width, 112 / p.display.height);
    const w = p.display.width * s, h = p.display.height * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.display, (112 - w) / 2, (112 - h) / 2, w, h);
    canvas.dataset.drawn = '1';
  }
}

// ====================================================================== stage state

function updateStageState() {
  const p = selected;
  ui.skeleton.hidden = !(p && p.status === 'loading');
  if (!p || p.status === 'ready' || p.status === 'loading') { ui.notice.hidden = true; return; }
  ui.noticeActions.textContent = '';
  if (p.status === 'toobig') {
    const { width, height } = p.tooBig;
    const lim = Math.round(maxPixels() / 1e6);
    ui.noticeTitle.textContent = `This photo is ${formatMP(width, height)}`;
    ui.noticeText.textContent = `That’s more than this device can resize comfortably. Shrink it to ${lim} MP first? It stays sharp, and your original file is untouched.`;
    const go = el('button', 'btn btn--primary', { type: 'button', text: `Shrink to ${lim} MP` });
    go.addEventListener('click', async () => {
      go.setAttribute('aria-busy', 'true');
      await p.shrinkToLimit();
    });
    const rm = el('button', 'btn btn--ghost', { type: 'button', text: 'Remove' });
    rm.addEventListener('click', () => removePhoto(p));
    ui.noticeActions.append(go, rm);
  } else {
    ui.noticeTitle.textContent = 'This file can’t be opened';
    ui.noticeText.textContent = p.error || 'Try a JPG, PNG or WebP photo.';
    const rm = el('button', 'btn btn--secondary', { type: 'button', text: 'Remove it' });
    rm.addEventListener('click', () => removePhoto(p));
    ui.noticeActions.append(rm);
  }
  ui.notice.hidden = false;
}

function updateReadout() {
  const p = selected;
  if (!p || p.status !== 'ready') {
    ui.readoutSize.textContent = '';
    ui.readoutFrom.textContent = '';
    return;
  }
  const t = stage.drag ? stage.vt : targetOf(p);
  ui.readoutSize.textContent = `${t.w} × ${t.h}`;
  ui.readoutFrom.textContent = t.w === p.W && t.h === p.H ? 'original size' : `from ${p.W} × ${p.H}`;
}

/** The user cancelled the exact result for the photo's current size (and nothing replaced it). */
function isCancelled(p) {
  if (!p || p.job || p.status !== 'ready' || !p.cancelledKey) return false;
  const t = targetOf(p);
  return p.cancelledKey === p.resultKey(t.w, t.h, sig()) && !p.hasResult(t.w, t.h, sig());
}

function updateJob() {
  const p = selected;
  const j = p && p.job;
  const cancelled = !j && isCancelled(p);
  const show = (!!j || cancelled) && view === 'edit' && !marking;
  const hadFocus = ui.job.contains(document.activeElement);
  ui.job.hidden = !show;
  ui.stageRoot.classList.toggle('is-working', !!j);
  ui.job.classList.toggle('is-cancelled', cancelled);
  ui.jobCancel.hidden = !j;
  ui.jobRetry.hidden = !cancelled;
  if (hadFocus && show && !ui.job.contains(document.activeElement)) (j ? ui.jobCancel : ui.jobRetry).focus({ preventScroll: true });
  if (!show) return;
  if (cancelled) {
    ui.job.classList.remove('is-indeterminate');
    ui.jobText.textContent = 'Not resized';
    return;
  }
  const f = j.progress || 0;
  const pct = Math.round(f * 100);
  ui.job.classList.toggle('is-indeterminate', pct <= 0);
  ui.jobFill.style.strokeDashoffset = String(pct > 0 ? 100 - pct : 72);
  let text = pct > 0 ? `Resizing ${pct}%` : 'Resizing';
  const elapsed = (performance.now() - j.started) / 1000;
  if (f > 0.03 && elapsed > 3) {
    const left = (elapsed * (1 - f)) / f;
    if (left >= 5) text = `${pct}%, about ${left < 60 ? Math.ceil(left / 5) * 5 + ' s' : Math.round(left / 60) + ' min'} left`;
  }
  ui.jobText.textContent = text;
}

ui.jobCancel.addEventListener('click', () => {
  const p = selected;
  if (!p) return;
  if (p.status === 'ready') {
    const t = targetOf(p);
    p.cancelledKey = p.resultKey(t.w, t.h, sig());
  }
  p.cancel();
  updateJob();
  if (!ui.job.hidden) ui.jobRetry.focus({ preventScroll: true });
  announce('Cancelled. The photo was not resized. Press Resize to try again.');
});
ui.jobRetry.addEventListener('click', () => {
  const p = selected;
  if (!p) return;
  p.cancelledKey = null;
  computeSelected();
  if (p.job) ui.jobCancel.focus({ preventScroll: true });
});

// ====================================================================== coach

function maybeCoach() {
  if (loadJSON(COACH_KEY, false)) return;
  stage.showCoach(true);
}
function dismissCoach() {
  if (ui.stageRoot.querySelector('#coach').hidden) return;
  stage.showCoach(false);
  saveJSON(COACH_KEY, true);
}

// ====================================================================== views

function showEditor() {
  const ae = document.activeElement;
  const focusLost = !ae || ae === document.body || ui.welcome.contains(ae);
  // Coming from the welcome screen (maybe scrolled down to the samples): start at the top.
  if (!ui.welcome.hidden) window.scrollTo(0, 0);
  ui.welcome.hidden = true;
  ui.editor.hidden = false;
  ui.body.dataset.view = 'editor';
  stage._resizeCanvas();
  stage.render();
  measureSheet();
  updatePanelFade();
  // The welcome section is gone: give keyboard and screen-reader users a place to start.
  if (focusLost) ui.editorTitle.focus({ preventScroll: true });
}

function showWelcome() {
  ui.editor.hidden = true;
  ui.welcome.hidden = false;
  ui.body.dataset.view = 'empty';
  setView('edit');
  selected = null;
  ui.editorTitle.textContent = 'Editor';
  stage.setPhoto(null);
}

function setView(v) {
  view = v;
  $$('input[name="view"]').forEach((r) => { r.checked = r.value === v; });
  ui.body.dataset.mode = v;
  const isCmp = v === 'compare';
  if (isCmp && closeNormalToast) { closeNormalToast(); closeNormalToast = null; }
  if (isCmp && marking) setMarking(false, { compute: true });
  ui.stageRoot.hidden = isCmp;
  ui.compareWrap.hidden = !isCmp;
  ui.compareBar.hidden = !isCmp;
  updateEditable();
  if (isCmp) showCompare();
  else { stage._resizeCanvas(); stage.render(); }
  updateJob();
}

function setCmpMode(m) {
  cmpMode = m;
  $$('input[name="cmp"]').forEach((r) => { r.checked = r.value === m; });
  if (view === 'compare') showCompare();
}

let compareToken = 0;
async function showCompare() {
  const p = selected;
  const token = ++compareToken;
  if (!p || p.status !== 'ready') return;
  const t = targetOf(p);
  sizeCompare();
  if (!p.hasResult(t.w, t.h, sig())) {
    p.cancelledKey = null; // asking to compare asks for the result
    ui.compareWait.hidden = false;
    if (compare) compare.element.hidden = true;
    computeSelected();
    return;
  }
  ui.compareWait.hidden = true;
  const r = p.result;
  // Same scale for every image so sizes compare honestly; capped for speed.
  const s = Math.min(1, 2048 / Math.max(p.W, p.H, r.w, r.h));
  const draw = (src, w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };
  const after = draw(r.display, r.w, r.h);
  const before = cmpMode === 'normal' ? draw(p.display, r.w, r.h) : draw(p.display, p.W, p.H);
  if (token !== compareToken) return;
  if (!compare) {
    compare = createCompare(ui.compareWrap, { mode: cmpMode, ariaLabel: 'Compare the original and the result' });
  }
  compare.element.hidden = false;
  compare.setMode(cmpMode);
  pinCompareLabels(before, after);
  await compare.set({ before, after });
  if (token === compareToken && cmpMode !== 'side') compare.nudge();
}

/**
 * compare.js centres both images in a frame as big as the larger one. When the shapes
 * differ, keep each label on its own image instead of on the empty margin.
 */
function pinCompareLabels(b, a) {
  const W = Math.max(b.width, a.width), H = Math.max(b.height, a.height);
  const s = ui.compareWrap.style;
  const inset = (v, max) => `${(((1 - v / max) / 2) * 100).toFixed(3)}%`;
  s.setProperty('--cmp-bx', inset(b.width, W));
  s.setProperty('--cmp-by', inset(b.height, H));
  s.setProperty('--cmp-ax', inset(a.width, W));
  s.setProperty('--cmp-ay', inset(a.height, H));
}

function sizeCompare() {
  const h = ui.compareWrap.clientHeight;
  if (h > 0) ui.compareWrap.style.setProperty('--compare-max-h', Math.max(200, h - (cmpMode === 'side' ? 48 : 8)) + 'px');
}
window.addEventListener('resize', () => { if (view === 'compare') sizeCompare(); });

$$('input[name="view"]').forEach((r) => r.addEventListener('change', () => r.checked && setView(r.value)));
$$('input[name="cmp"]').forEach((r) => r.addEventListener('change', () => r.checked && setCmpMode(r.value)));

// ====================================================================== marking

function setMarking(on, { compute = true } = {}) {
  const focusInBar = ui.brushBar.contains(document.activeElement);
  marking = on;
  ui.markBtn.setAttribute('aria-pressed', String(on));
  ui.brushBar.hidden = !on;
  ui.body.classList.toggle('is-marking', on);
  stage.setMode(on ? 'mark' : 'edit');
  updateMarkButtons();
  updateJob();
  updateShortcuts();
  // The brush bar is gone: put focus back on the button that opened it.
  if (!on && (focusInBar || document.activeElement === document.body) && !ui.markBtn.disabled) ui.markBtn.focus({ preventScroll: true });
  if (on) {
    if (selected) selected.cancel();
    announce('Mark areas: paint Keep over what must not change and Remove over what can go first. Press Done when finished.');
  } else if (compute) {
    stage.sync();
    scheduleCompute(0);
    warmMaps(selected);
  }
}

function updateMarkButtons() {
  const p = selected;
  ui.undoBtn.disabled = !(p && p.undoStack.length);
  ui.clearBtn.disabled = !(p && p.hasMarks);
  ui.markBtn.classList.toggle('has-marks', !!(p && p.hasMarks));
  ui.brushHint.hidden = !!(p && p.hasMarks);
}

function updateShortcuts() {
  const many = photos.length > 1;
  ui.shortcutsAll.hidden = !many;
  ui.shortcutsBrush.hidden = !marking;
  ui.shortcuts.hidden = !many && !marking;
}

function onMarksChanged() {
  updateMarkButtons();
  renderFilm();
}

function undoStroke() {
  if (!selected || !selected.undo()) return;
  stage.marksReset();
  onMarksChanged();
  announce('Undone');
  if (!marking) { stage.sync(); scheduleCompute(200); }
}

ui.markBtn.addEventListener('click', () => {
  if (view !== 'edit') setView('edit');
  setMarking(!marking);
});
ui.markDone.addEventListener('click', () => setMarking(false));
ui.undoBtn.addEventListener('click', undoStroke);
ui.clearBtn.addEventListener('click', () => {
  if (selected && selected.clearMarks()) {
    stage.marksReset();
    onMarksChanged();
    announce('Marks cleared');
  }
});
$$('input[name="brush"]').forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  stage.setBrush({ label: r.value === 'keep' ? LABEL_KEEP : r.value === 'remove' ? LABEL_REMOVE : LABEL_NONE });
}));

function setBrushSize(v) {
  settings.brush = clamp(Math.round(v), 8, 160);
  ui.brushSize.value = String(settings.brush);
  setRangeFill(ui.brushSize);
  stage.setBrush({ size: settings.brush });
  persist();
}
ui.brushSize.addEventListener('input', () => setBrushSize(+ui.brushSize.value));

// ====================================================================== panel: presets

function presetGlyph(p) {
  const g = el('span', 'preset__glyph', { 'aria-hidden': 'true' });
  const shape = el('span', 'preset__shape');
  if (p.ratio) {
    const r = p.ratio;
    const w = r >= 1 ? 26 : Math.round(26 * r);
    const h = r >= 1 ? Math.round(26 / r) : 26;
    shape.style.width = Math.max(8, w) + 'px';
    shape.style.height = Math.max(8, h) + 'px';
  } else {
    shape.classList.add(p.id === 'custom' ? 'preset__shape--custom' : 'preset__shape--original');
  }
  g.appendChild(shape);
  return g;
}

function buildPresets() {
  for (const p of PRESETS) {
    const label = el('label', 'preset');
    label.dataset.preset = p.id;
    const input = el('input', '', { type: 'radio', name: 'preset', value: p.id });
    const text = el('span', 'preset__text');
    const use = el('span', 'preset__use');
    if (p.label) use.append(el('span', 'preset__ratio tabular', { text: p.label }), ' ');
    use.append(p.use);
    text.append(el('span', 'preset__name', { text: p.name }), use);
    label.append(input, presetGlyph(p), text);
    input.addEventListener('change', () => { if (input.checked) choosePreset(p.id); });
    ui.presets.appendChild(label);
  }
}

function choosePreset(id) {
  dismissCoach();
  const prev = settings.preset;
  if (id === 'custom' && prev !== 'custom' && selected && selected.status === 'ready') {
    const t = targetOf(selected);
    settings.custom.w = t.w;
    settings.custom.h = t.h;
    settings.custom.fw = t.w;
    settings.custom.fh = t.h;
  }
  settings.preset = id;
  for (const p of photos) p.override = null;
  persist();
  updatePanel();
  renderFilm();
  stage.sync({ animate: true });
  updateReadout();
  scheduleCompute(reducedMotion() ? 50 : 600);
  if (id === 'custom') setSheet(true);
  if (selected && selected.status === 'ready') {
    const t = targetOf(selected);
    announce(`${PRESETS.find((x) => x.id === id).name}: ${t.w} by ${t.h} pixels`);
  }
}

ui.adjustedReset.addEventListener('click', () => {
  if (!selected) return;
  selected.override = null;
  updatePanel();
  renderFilm();
  stage.sync({ animate: true });
  updateReadout();
  scheduleCompute(500);
});

// ====================================================================== panel: custom

const CUSTOM_HINTS = {
  px: 'Every photo becomes exactly this size.',
  percent: 'Each photo is resized relative to its own size.',
  width: 'Only the width changes. The height stays as it is.',
  height: 'Only the height changes. The width stays as it is.',
};

function updateCustomFields() {
  const c = settings.custom;
  $$('input[name="cmode"]').forEach((r) => { r.checked = r.value === c.mode; });
  const pct = c.mode === 'percent';
  ui.cwUnit.textContent = pct ? '%' : 'px';
  ui.chUnit.textContent = pct ? '%' : 'px';
  ui.custom.dataset.mode = c.mode;
  const set = (input, v) => { if (document.activeElement !== input) input.value = String(v); };
  if (c.mode === 'px') { set(ui.cw, c.w); set(ui.ch, c.h); }
  else if (pct) { set(ui.cw, c.pw); set(ui.ch, c.ph); }
  else if (c.mode === 'width') set(ui.cw, c.fw);
  else set(ui.ch, c.fh);
  ui.cw.min = pct ? '5' : '1';
  ui.ch.min = pct ? '5' : '1';
  ui.cw.max = pct ? '200' : '30000';
  ui.ch.max = pct ? '200' : '30000';
  ui.cLock.setAttribute('aria-pressed', String(c.lock));
  ui.customHint.textContent = CUSTOM_HINTS[c.mode];
}

const applyCustom = debounce(() => {
  for (const p of photos) p.override = null;
  persist();
  renderFilm();
  stage.sync({ animate: true });
  updateReadout();
  updateSizeNote();
  scheduleCompute(reducedMotion() ? 50 : 600);
}, 350);

function readNum(input) {
  const v = Math.round(Number(input.value));
  const ok = Number.isFinite(v) && v >= Number(input.min) && v <= Number(input.max);
  input.setAttribute('aria-invalid', ok ? 'false' : 'true');
  return ok ? v : null;
}

function onCustomInput(which) {
  const c = settings.custom;
  const input = which === 'w' ? ui.cw : ui.ch;
  const v = readNum(input);
  if (v == null) return;
  const ref = selected && selected.status === 'ready' ? selected : null;
  if (c.mode === 'px') {
    c[which] = v;
    if (c.lock && ref) {
      if (which === 'w') { c.h = Math.max(1, Math.round(v * ref.H / ref.W)); ui.ch.value = String(c.h); }
      else { c.w = Math.max(1, Math.round(v * ref.W / ref.H)); ui.cw.value = String(c.w); }
    }
  } else if (c.mode === 'percent') {
    c[which === 'w' ? 'pw' : 'ph'] = v;
    if (c.lock) { c.pw = c.ph = v; (which === 'w' ? ui.ch : ui.cw).value = String(v); }
  } else if (c.mode === 'width') c.fw = v;
  else c.fh = v;
  applyCustom();
}

ui.cw.addEventListener('input', () => onCustomInput('w'));
ui.ch.addEventListener('input', () => onCustomInput('h'));
ui.cLock.addEventListener('click', () => {
  settings.custom.lock = !settings.custom.lock;
  updateCustomFields();
  persist();
});
$$('input[name="cmode"]').forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  settings.custom.mode = r.value;
  if (selected && selected.status === 'ready' && (r.value === 'width' || r.value === 'height')) {
    const t = targetOf(selected);
    if (r.value === 'width') settings.custom.fw = t.w; else settings.custom.fh = t.h;
  }
  updateCustomFields();
  applyCustom();
}));

// ====================================================================== panel: fine-tune + format

function setRangeFill(input) {
  const min = +input.min, max = +input.max, v = +input.value;
  input.style.setProperty('--range-pct', ((v - min) / (max - min)) * 100 + '%');
}

function syncFine() {
  ui.faces.checked = settings.faces;
  ui.blur.value = String(settings.blur);
  ui.sobel.value = String(settings.sobel);
  ui.blurOut.textContent = String(settings.blur);
  ui.sobelOut.textContent = String(settings.sobel);
  setRangeFill(ui.blur);
  setRangeFill(ui.sobel);
}

function fineChanged() {
  for (const p of photos) p.optionsChanged();
  persist();
  syncFine();
  renderFilm();
  stage.render();
  scheduleCompute(500);
  if (selected) warmMaps(selected);
}

ui.faces.addEventListener('change', () => { settings.faces = ui.faces.checked; fineChanged(); });
ui.blur.addEventListener('input', () => { settings.blur = +ui.blur.value; syncFine(); });
ui.blur.addEventListener('change', () => { settings.blur = +ui.blur.value; fineChanged(); });
ui.sobel.addEventListener('input', () => { settings.sobel = +ui.sobel.value; syncFine(); });
ui.sobel.addEventListener('change', () => { settings.sobel = +ui.sobel.value; fineChanged(); });
ui.fineReset.addEventListener('click', () => {
  Object.assign(settings, FINE_DEFAULTS);
  fineChanged();
  announce('Fine-tune settings reset');
});

const FMT_HINTS = {
  same: 'Keeps each photo’s own format.',
  jpeg: 'Smallest files for photos. No transparency.',
  png: 'Lossless and larger. Keeps transparency.',
  webp: 'Small files with transparency. Saved as PNG where WebP isn’t supported.',
};
function syncFormat() {
  $$('input[name="fmt"]').forEach((r) => { r.checked = r.value === settings.format; });
  ui.fmtHint.textContent = FMT_HINTS[settings.format];
  ui.qualityRow.hidden = settings.format === 'png';
  ui.quality.value = String(settings.quality);
  ui.qualityOut.textContent = String(settings.quality);
  setRangeFill(ui.quality);
}
$$('input[name="fmt"]').forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  settings.format = r.value;
  persist();
  syncFormat();
}));
ui.quality.addEventListener('input', () => {
  settings.quality = +ui.quality.value;
  syncFormat();
  persist();
});

// ====================================================================== panel: sync

function updateSizeNote() {
  const p = selected;
  let note = '';
  if (p && p.status === 'ready' && settings.preset === 'custom' && !p.override) {
    const t = batchTarget(p.W, p.H, settings, maxPixels());
    if (t.clamped) note = 'Limited to 2× the original';
  }
  if (!note && photos.length > 1) note = `For all ${photos.length} photos`;
  ui.sizeNote.textContent = note;
}

function updatePanel() {
  $$('input[name="preset"]').forEach((r) => { r.checked = r.value === settings.preset; });
  ui.custom.hidden = settings.preset !== 'custom';
  ui.adjusted.hidden = !(selected && selected.override && photos.length > 1);
  updateCustomFields();
  updateSizeNote();
  updateEditable();
}

/** The view switch and the brush need a photo that opened; presets need at least one. */
function updateEditable() {
  const ok = !!(selected && selected.status === 'ready');
  $$('input[name="view"]').forEach((r) => { r.disabled = !ok; });
  ui.markBtn.disabled = !ok || view === 'compare';
  const any = photos.some((p) => p.status === 'ready' || p.status === 'loading');
  $$('input[name="preset"]').forEach((r) => { r.disabled = !any; });
}

function updateActions() {
  const ready = photos.filter((p) => p.status === 'ready');
  const many = photos.length > 1;
  ui.resizeAll.hidden = !many;
  ui.zipBtn.hidden = !many;
  ui.resizeAll.disabled = !ready.length;
  ui.zipBtn.disabled = !ready.length || !!batch;
  ui.resizeAll.textContent = batch ? 'Stop' : `Resize all ${ready.length}`;
  ui.resizeAll.classList.toggle('btn--secondary', !!batch);
  ui.resizeAll.classList.toggle('btn--primary', !batch);
  ui.downloadBtn.classList.toggle('btn--primary', !many);
  ui.downloadBtn.classList.toggle('btn--secondary', many);
  ui.downloadLabel.textContent = many ? 'Download photo' : 'Download';
  ui.downloadBtn.classList.toggle('is-many', many);
  ui.downloadBtn.disabled = !(selected && selected.status === 'ready');
  ui.shareBtn.hidden = !canShareFiles();
  ui.shareBtn.disabled = ui.downloadBtn.disabled;
}

// ====================================================================== batch

async function resizeAll() {
  if (batch) { stopBatch(); return; }
  const list = photos.filter((p) => p.status === 'ready');
  if (!list.length) return;
  if (marking) setMarking(false, { compute: false });
  const run = { list, cancelled: false };
  batch = run;
  offeredNormal = true; // the batch toast says enough
  if (closeNormalToast) { closeNormalToast(); closeNormalToast = null; }
  ui.batchbar.hidden = false;
  updateActions();
  updateBatch();
  const s = sig(), o = opts();
  const targets = list.map((p) => targetOf(p));
  // Feed the engine a few jobs at a time (not all at once), so a seam map for the photo
  // the user is looking at never waits behind the whole batch in the engine's queue.
  const limit = Math.max(1, engine.poolSize > 2 ? engine.poolSize - 1 : engine.poolSize || 1);
  const results = new Array(list.length);
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const i = next++;
      const p = list[i];
      if (batch !== run) { results[i] = { status: 'rejected', reason: abortErr() }; continue; }
      if (!photos.includes(p) || p.status !== 'ready') { results[i] = { status: 'fulfilled', value: null }; continue; }
      try {
        results[i] = { status: 'fulfilled', value: await p.compute(targets[i].w, targets[i].h, o, s) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane));
  if (batch !== run) return results;
  batch = null;
  ui.batchbar.hidden = true;
  updateActions();
  renderFilm();
  refreshStage();
  const failed = results.filter((r) => r.status === 'rejected' && !isAbort(r.reason));
  const aborted = results.some((r) => r.status === 'rejected' && isAbort(r.reason));
  if (failed.length) {
    handleEngineError(failed[0].reason, list[results.indexOf(failed[0])]);
  } else if (!aborted) {
    const n = list.length;
    announce(`All ${n} photos resized`);
    toast(`All ${n} photos resized.`, { kind: 'success', action: { label: 'Download all', fn: downloadZip } });
  }
  return results;
}

function abortErr() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function stopBatch() {
  if (!batch) return;
  const run = batch;
  batch = null;
  for (const p of run.list) p.cancel();
  ui.batchbar.hidden = true;
  updateActions();
  renderFilm();
  announce('Stopped');
}

function updateBatch() {
  if (!batch) return;
  const t = batch.list.length;
  let sum = 0, done = 0;
  for (const p of batch.list) {
    const tt = targetOf(p);
    if (p.hasResult(tt.w, tt.h, sig()) && !p.job) { sum += 1; done++; }
    else if (p.job) sum += p.job.progress || 0;
  }
  ui.batchProgress.value = t ? sum / t : 0;
  ui.batchText.textContent = `${done} of ${t} done`;
}

ui.resizeAll.addEventListener('click', resizeAll);

// ====================================================================== export

const fmt = () => ({ format: settings.format, quality: settings.quality });
let encodedCache = null; // { key, blob, name }

async function resultFor(p) {
  const t = targetOf(p);
  return p.compute(t.w, t.h, opts(), sig());
}

async function encodeSelected() {
  const p = selected;
  const r = await resultFor(p);
  const key = `${p.id}|${r.key}|${settings.format}|${settings.quality}`;
  if (encodedCache && encodedCache.key === key) return encodedCache;
  const e = await encodeResult(p, r, fmt());
  if (e.fellBack) toast('This browser can’t save WebP, so it was saved as PNG.', { kind: 'warning' });
  encodedCache = { key, blob: e.blob, name: e.name };
  return encodedCache;
}

async function busy(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  try { await fn(); }
  catch (err) {
    if (!isAbort(err)) handleEngineError(err, selected || { name: 'photo' });
  } finally { btn.removeAttribute('aria-busy'); }
}

ui.downloadBtn.addEventListener('click', () => busy(ui.downloadBtn, async () => {
  if (!selected) return;
  const e = await encodeSelected();
  downloadBlob(e.blob, e.name);
  announce(`Downloaded ${e.name}`);
}));

ui.shareBtn.addEventListener('click', () => busy(ui.shareBtn, async () => {
  if (!selected) return;
  const p = selected;
  const t = targetOf(p);
  const cached = encodedCache && encodedCache.key.startsWith(`${p.id}|${p.resultKey(t.w, t.h, sig())}|${settings.format}|${settings.quality}`);
  const e = await encodeSelected();
  try {
    await shareFile(e.blob, e.name);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (!cached && err && err.name === 'NotAllowedError') {
      toast('Your photo is ready. Tap Share or save again.', {});
      return;
    }
    toast('Sharing didn’t work here. Use Download instead.', { kind: 'warning' });
  }
}));

async function downloadZip() {
  await busy(ui.zipBtn, async () => {
    const list = photos.filter((p) => p.status === 'ready');
    if (!list.length) return;
    const need = list.some((p) => { const t = targetOf(p); return !p.hasResult(t.w, t.h, sig()); });
    if (need) {
      const results = await resizeAll();
      if (!results || results.some((r) => r.status === 'rejected')) return;
    }
    const ready = list.filter((p) => photos.includes(p) && p.result);
    if (!ready.length || ready.some((p) => { const t = targetOf(p); return !p.hasResult(t.w, t.h, sig()); })) return;
    const entries = [];
    for (const p of ready) {
      const e = await encodeResult(p, p.result, fmt());
      entries.push({ name: e.name, blob: e.blob });
    }
    const zip = await zipEntries(entries);
    const name = `squishless-${entries.length}-photos.zip`;
    downloadBlob(zip, name);
    announce(`Downloaded ${name}`);
  });
}
ui.zipBtn.addEventListener('click', downloadZip);

// ====================================================================== phone sheet

// Narrow and tall enough: the panel is a bottom sheet. Narrow and short (phone landscape,
// a laptop at 200% zoom): the panel sits in the page flow below the photo instead (app.css).
const sheetMQ = matchMedia('(max-width: 1023.98px) and (min-height: 560px)');
function setSheet(open) {
  if (!sheetMQ.matches) open = false;
  ui.panel.classList.toggle('is-open', open);
  ui.sheetToggle.setAttribute('aria-expanded', String(open));
  ui.moreBtn.setAttribute('aria-expanded', String(open));
  ui.body.classList.toggle('sheet-open', open);
}
ui.sheetToggle.addEventListener('click', () => setSheet(!ui.panel.classList.contains('is-open')));
ui.moreBtn.addEventListener('click', () => setSheet(!ui.panel.classList.contains('is-open')));
function measureSheet() {
  if (!sheetMQ.matches) { document.documentElement.style.removeProperty('--sheet-h'); return; }
  const open = ui.panel.classList.contains('is-open');
  if (open) return;
  document.documentElement.style.setProperty('--sheet-h', ui.panel.offsetHeight + 'px');
}

/** Desktop panel: a fade above the sticky buttons while more settings are scrolled out of view. */
function updatePanelFade() {
  const pnl = ui.panel;
  pnl.classList.toggle('has-more-below', pnl.scrollHeight - pnl.scrollTop - pnl.clientHeight > 4);
}
ui.panel.addEventListener('scroll', updatePanelFade, { passive: true });
/** Phones: the preset row fades out on the right while more presets are off-screen. */
function updatePresetFade() {
  const r = ui.presets;
  r.classList.toggle('is-at-end', r.scrollLeft + r.clientWidth >= r.scrollWidth - 4);
}
ui.presets.addEventListener('scroll', updatePresetFade, { passive: true });
const panelRO = new ResizeObserver(() => { measureSheet(); updatePanelFade(); updatePresetFade(); });
panelRO.observe(ui.panel);
for (const n of ui.panel.children) panelRO.observe(n);
sheetMQ.addEventListener('change', () => { setSheet(false); measureSheet(); });

// ====================================================================== input: files, drop, paste

ui.chooseBtn.addEventListener('click', () => ui.fileInput.click());
ui.addBtn.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  const files = Array.from(ui.fileInput.files || []);
  ui.fileInput.value = '';
  addFiles(files);
});
ui.dropzone.addEventListener('click', (e) => {
  if (e.target === ui.dropzone || e.target.closest('.welcome__drop-art, .welcome__drop-title')) ui.fileInput.click();
});

$$('[data-sample]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
  const name = b.dataset.sample;
  const res = await fetch('/samples/' + name);
  if (!res.ok) throw new Error('Could not load the sample photo');
  const blob = await res.blob();
  await addFiles([new File([blob], name, { type: blob.type || 'image/jpeg' })]);
})));

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  ui.body.classList.add('is-dragover');
  ui.dropzone.classList.add('is-dragover');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) { ui.body.classList.remove('is-dragover'); ui.dropzone.classList.remove('is-dragover'); }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  ui.body.classList.remove('is-dragover');
  ui.dropzone.classList.remove('is-dragover');
  addFiles(e.dataTransfer.files);
});

document.addEventListener('paste', (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const files = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}${i ? '-' + i : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  addFiles(named);
});

// ====================================================================== keyboard

const typing = (t) => t && (t.closest('input:not([type="range"]):not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable="true"]'));
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') {
    if (photos.length) { e.preventDefault(); resizeAll(); }
    return;
  }
  if (e.key === 'Escape' && ui.panel.classList.contains('is-open')) {
    const inMore = $('#panel-more').contains(document.activeElement);
    setSheet(false);
    if (inMore) ui.sheetToggle.focus({ preventScroll: true });
    return;
  }
  if (typing(e.target)) return;
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    if (selected && selected.undoStack.length) { e.preventDefault(); undoStroke(); }
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    setBrushSize(settings.brush + (e.key === ']' ? 8 : -8));
    announce(`Brush size ${settings.brush}`);
  } else if (e.key === 'Escape') {
    if (marking) setMarking(false);
  }
});

// ====================================================================== engine

let closeEngineToast = null;
function setEngineState(s) {
  const was = engineState;
  engineState = s;
  if (s !== 'error' && closeEngineToast) { closeEngineToast(); closeEngineToast = null; }
  const chip = ui.engineChip;
  chip.textContent = '';
  chip.dataset.state = s;
  if (s === 'loading') {
    chip.hidden = false;
    chip.append(el('span', 'spinner', { 'aria-hidden': 'true' }), el('span', '', { text: 'Getting the resizer ready' }));
  } else if (s === 'error') {
    chip.hidden = false;
    chip.append(el('span', '', { text: 'The resizer didn’t load.' }));
    const b = el('button', 'btn btn--secondary btn--sm', { type: 'button', text: 'Try again' });
    b.addEventListener('click', () => { startEngine(true); scheduleCompute(0); });
    chip.append(b);
    if (was !== 'error') closeEngineToast = toast('The resizer couldn’t load. Check your connection, then try again.', {
      kind: 'danger', timeout: 0, action: { label: 'Try again', fn: () => { startEngine(true); scheduleCompute(0); } },
    });
  } else {
    chip.hidden = true;
  }
}

function startEngine(retry = false) {
  if (engineState === 'ready' || (engineState === 'loading' && !retry)) return;
  setEngineState('loading');
  engine.ready.then(() => {
    setEngineState('ready');
    if (selected) warmMaps(selected);
  }, (err) => {
    console.warn('Engine failed to load', err);
    setEngineState('error');
  });
}

// ====================================================================== boot

function boot() {
  $$('[data-mod-key]').forEach((k) => { k.textContent = isMac ? '⌘' : 'Ctrl'; });
  buildPresets();
  syncFine();
  syncFormat();
  updatePanel();
  ui.brushSize.value = String(settings.brush);
  setRangeFill(ui.brushSize);
  stage.setBrush({ size: settings.brush, label: LABEL_KEEP });
  updateActions();
  updateShortcuts();

  const params = new URLSearchParams(location.search);
  if (params.get('from') === 'home') {
    history.replaceState(null, '', location.pathname);
    takeFiles().then((files) => {
      if (files.length) addFiles(files);
      else startEngineWhenIdle();
    });
  } else {
    startEngineWhenIdle();
  }
}

function startEngineWhenIdle() {
  const go = () => startEngine();
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  if (engine.isPhone || saveData) {
    // Phones and Save-Data: fetch the 1.2 MB engine only once the visitor shows intent.
    for (const type of ['pointerdown', 'focusin', 'dragenter']) window.addEventListener(type, go, { once: true, passive: true });
    return;
  }
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1500 });
  else setTimeout(go, 300);
}

// ====================================================================== toast placement

/** In the editor, toasts sit just below the toolbar, centred over the photo (clear of the
 *  handles, the filmstrip and the bottom sheet). */
function placeToasts(region) {
  if (ui.editor.hidden) return;
  let top = ui.toolbar.getBoundingClientRect().bottom;
  for (const bar of [ui.compareBar, ui.brushBar]) if (!bar.hidden) top = Math.max(top, bar.getBoundingClientRect().bottom);
  const ws = ui.workspace.getBoundingClientRect();
  region.style.setProperty('--toast-top', Math.round(Math.max(8, top + 8)) + 'px');
  region.style.setProperty('--toast-x', Math.round(ws.left + ws.width / 2) + 'px');
}

function focusFallback() {
  const visible = (n) => n && n.getClientRects().length > 0 && !n.closest('[hidden]');
  const cands = ui.editor.hidden
    ? [ui.chooseBtn]
    : [view === 'compare' ? ui.compareWrap.querySelector('.compare__divider') : ui.handleX, ui.downloadBtn, ui.editorTitle];
  return cands.find(visible) || ui.editorTitle;
}
setToastHooks({ place: placeToasts, focusFallback });

// A new version was installed by the service worker: offer a reload, never force one.
window.addEventListener('squishless:update-available', (e) => {
  e.preventDefault();
  const apply = e.detail && e.detail.apply;
  toast('A new version of Squishless is ready.', {
    timeout: 0,
    action: { label: 'Reload', fn: () => { if (apply) apply(); else location.reload(); } },
  });
});

// Read-only hook for tests and the curious.
window.squishlessApp = {
  get state() {
    return {
      engine: engineState,
      view,
      marking,
      selected: selected ? selected.id : null,
      photos: photos.map((p) => {
        const t = p.status === 'ready' ? targetOf(p) : null;
        return {
          id: p.id, name: p.name, status: p.status, width: p.W, height: p.H, target: t,
          result: p.result && t && p.hasResult(t.w, t.h, sig()) ? { width: p.result.w, height: p.result.h } : null,
          working: !!p.job, marks: p.strokes.length,
          maps: { x: !!p.maps.x, y: !!p.maps.y },
        };
      }),
    };
  },
  /** FNV-1a hash of the selected result's pixels (to tell results apart). */
  resultHash() {
    const r = selected && selected.result;
    if (!r) return null;
    let h = 0x811c9dc5;
    const d = r.img.rgba;
    for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  },
};

boot();
