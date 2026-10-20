/*
 * Squishless before/after compare component (ES module, no dependencies).
 *
 *   import { createCompare } from '/assets/js/compare.js';
 *   const cmp = createCompare(container, { before, after, mode: 'slider' });
 *   cmp.set({ before, after });         // swap images (either may be omitted to keep it)
 *   cmp.setMode('slider' | 'side' | 'normal');
 *   cmp.destroy();
 *
 * Extras (beyond the ARCHITECTURE.md contract, all optional):
 *   options.labels   { before, after } to override the label text
 *   options.position initial divider position, 0..100 (default 50)
 *   options.ariaLabel accessible name of the divider (default "Before and after comparison")
 *   cmp.setPosition(p) / cmp.getPosition()
 *   cmp.nudge()      a short wiggle of the divider to hint it can be dragged
 *                    (does nothing with prefers-reduced-motion)
 *   cmp.ready        Promise that settles when the latest set() has drawn (set() also
 *                    returns a promise that resolves when its images are drawn)
 *   cmp.element      the root element (div.compare)
 *
 * Image sources accepted for before/after: URL string, ImageBitmap,
 * HTMLImageElement, HTMLCanvasElement, OffscreenCanvas, ImageData, Blob/File,
 * or an engine Img { rgba, width, height }.
 *
 * Modes:
 *   'slider'  one frame, draggable divider anywhere on the image; left of the
 *             divider shows "Before", right shows "After".
 *   'normal'  the same slider; the caller passes the plain (squished) resize as
 *             `before`, labelled "Normal resize", and `after` is "Squishless".
 *   'side'    two panels side by side (stacked when that shows them bigger),
 *             each with its pixel size.
 *
 * Different sizes: both images are drawn at the same scale (one source pixel =
 * the same number of screen pixels), centred in a frame as big as the larger
 * of the two in each direction. Space an image does not cover shows the plain
 * stage colour, so a narrower result looks narrower, honestly.
 *
 * Styling lives in base.css (.compare*). Height cap: set --compare-max-h on the
 * container or .compare (default 70vh).
 */

const DEFAULT_LABELS = {
  slider: { before: 'Before', after: 'After' },
  side: { before: 'Before', after: 'After' },
  normal: { before: 'Normal resize', after: 'Squishless' },
};
const MODES = ['slider', 'side', 'normal'];
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, cls, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function handleIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M9 6 3 12l6 6M15 6l6 6-6 6');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

/** Turn any supported source into something drawImage accepts, plus its size. */
async function toDrawable(src) {
  if (src == null) return null;
  if (typeof src === 'string') {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    try {
      await img.decode();
    } catch {
      await new Promise((resolve, reject) => {
        if (img.complete && img.naturalWidth) return resolve();
        img.onload = resolve;
        img.onerror = () => reject(new Error('compare: could not load image ' + src));
      });
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, owned: null };
  }
  if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) {
    return { source: src, width: src.width, height: src.height, owned: null };
  }
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    if (!src.complete || !src.naturalWidth) await src.decode();
    return { source: src, width: src.naturalWidth, height: src.naturalHeight, owned: null };
  }
  if ((typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas)) {
    return { source: src, width: src.width, height: src.height, owned: null };
  }
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    const bmp = await createImageBitmap(src, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, owned: bmp };
  }
  let imageData = null;
  if (typeof ImageData !== 'undefined' && src instanceof ImageData) imageData = src;
  else if (src && src.rgba && src.width && src.height) {
    const data = src.rgba instanceof Uint8ClampedArray
      ? src.rgba
      : new Uint8ClampedArray(src.rgba.buffer, src.rgba.byteOffset, src.rgba.byteLength);
    imageData = new ImageData(data, src.width, src.height);
  }
  if (imageData) {
    const bmp = await createImageBitmap(imageData);
    return { source: bmp, width: bmp.width, height: bmp.height, owned: bmp };
  }
  throw new TypeError('compare: unsupported image source');
}

function release(d) {
  if (d && d.owned && typeof d.owned.close === 'function') d.owned.close();
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createCompare(container, options = {}) {
  if (!container) throw new TypeError('compare: container is required');
  let mode = MODES.includes(options.mode) ? options.mode : 'slider';
  let customLabels = options.labels || null;
  let pos = clamp(options.position ?? 50);
  let imgs = { before: null, after: null };
  let loadToken = 0;
  let destroyed = false;
  let rafId = 0;
  let nudgeAnim = null;

  // ---------- DOM ----------
  const root = el('div', 'compare is-loading');
  const frame = el('div', 'compare__frame');
  const cAfter = el('canvas', 'compare__canvas compare__canvas--after', { 'aria-hidden': 'true' });
  const cBefore = el('canvas', 'compare__canvas compare__canvas--before', { 'aria-hidden': 'true' });
  const lBefore = el('span', 'compare__label compare__label--before', { 'aria-hidden': 'true' });
  const lAfter = el('span', 'compare__label compare__label--after', { 'aria-hidden': 'true' });
  const divider = el('div', 'compare__divider', {
    role: 'slider',
    tabindex: '0',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-orientation': 'horizontal',
    'aria-label': options.ariaLabel || 'Before and after comparison',
  });
  const handle = el('span', 'compare__handle');
  handle.appendChild(handleIcon());
  divider.appendChild(handle);
  frame.append(cAfter, cBefore, lBefore, lAfter, divider);

  const side = el('div', 'compare__side');
  const panels = ['before', 'after'].map((key) => {
    const panel = el('figure', 'compare__panel');
    const pf = el('div', 'compare__panel-frame');
    const canvas = el('canvas', 'compare__canvas', { role: 'img' });
    const label = el('span', 'compare__label');
    const dims = el('span', 'compare__dims badge tabular');
    pf.append(canvas, label, dims);
    panel.appendChild(pf);
    side.appendChild(panel);
    return { key, canvas, label, dims };
  });
  root.append(frame, side);
  container.appendChild(root);

  // ---------- Labels / mode ----------
  function labels() {
    const base = DEFAULT_LABELS[mode];
    return {
      before: (customLabels && customLabels.before) || base.before,
      after: (customLabels && customLabels.after) || base.after,
    };
  }

  function applyMode() {
    root.classList.toggle('compare--side', mode === 'side');
    root.classList.toggle('compare--normal', mode === 'normal');
    root.dataset.mode = mode;
    const l = labels();
    lBefore.textContent = l.before;
    lAfter.textContent = l.after;
    panels[0].label.textContent = l.before;
    panels[1].label.textContent = l.after;
    updateAria();
    scheduleDraw();
  }

  // ---------- Position ----------
  function clamp(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 50;
    return Math.min(100, Math.max(0, v));
  }

  function updateAria() {
    const l = labels();
    const r = Math.round(pos);
    divider.setAttribute('aria-valuenow', String(r));
    divider.setAttribute('aria-valuetext', `${r}% ${l.before}, ${100 - r}% ${l.after}`);
  }

  function setPos(p) {
    pos = clamp(p);
    root.style.setProperty('--compare-pos', pos + '%');
    lBefore.classList.toggle('is-hidden', pos < 18);
    lAfter.classList.toggle('is-hidden', pos > 82);
    updateAria();
  }

  // ---------- Geometry and drawing ----------
  function dims() {
    const b = imgs.before, a = imgs.after;
    const w = Math.max(b ? b.width : 0, a ? a.width : 0);
    const h = Math.max(b ? b.height : 0, a ? a.height : 0);
    return w && h ? { w, h } : null;
  }

  function applyAspect() {
    const d = dims();
    if (!d) return;
    root.style.setProperty('--compare-ar', `${d.w} / ${d.h}`);
    root.style.setProperty('--compare-ar-num', String(d.w / d.h));
  }

  function sizeCanvas(canvas) {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, visible: r.width > 0 && r.height > 0 };
  }

  function drawInto(canvas, img, box) {
    const { w, h, visible } = sizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!img || !visible) return;
    const s = Math.min(w / box.w, h / box.h);
    const dw = img.width * s, dh = img.height * s;
    const dx = Math.round((w - dw) / 2), dy = Math.round((h - dh) / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, dx, dy, Math.round(dw), Math.round(dh));
  }

  function layoutSide() {
    const d = dims();
    if (!d) return;
    const cw = root.clientWidth;
    const gap = 12;
    const maxH = (window.innerHeight || 800) * 0.7;
    const ar = d.w / d.h;
    const sideBySide = (cw - gap) / 2;               // panel width when side by side
    const stacked = Math.min(cw, (maxH / 2) * ar);   // panel width when stacked
    root.classList.toggle('is-stacked', stacked > sideBySide * 1.15);
  }

  function draw() {
    rafId = 0;
    if (destroyed) return;
    const box = dims();
    if (!box) return;
    if (mode === 'side') {
      layoutSide();
      for (const p of panels) {
        const img = imgs[p.key];
        drawInto(p.canvas, img, box);
        p.dims.textContent = img ? `${img.width} × ${img.height}` : '';
        p.canvas.setAttribute('aria-label', img ? `${p.label.textContent}, ${img.width} by ${img.height} pixels` : p.label.textContent);
      }
    } else {
      drawInto(cAfter, imgs.after, box);
      drawInto(cBefore, imgs.before, box);
    }
  }

  function scheduleDraw() {
    if (!rafId && !destroyed) rafId = requestAnimationFrame(draw);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleDraw) : null;
  if (ro) ro.observe(root);
  else window.addEventListener('resize', scheduleDraw);

  // ---------- Pointer interaction ----------
  let dragId = null;
  function posFromEvent(e) {
    const r = frame.getBoundingClientRect();
    return r.width ? ((e.clientX - r.left) / r.width) * 100 : pos;
  }
  function onDown(e) {
    if (mode === 'side' || dragId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopNudge();
    dragId = e.pointerId;
    try { frame.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    root.classList.add('is-dragging');
    setPos(posFromEvent(e));
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection; keep focus below
    divider.focus({ preventScroll: true });
  }
  function onMove(e) {
    if (e.pointerId !== dragId) return;
    setPos(posFromEvent(e));
  }
  function onUp(e) {
    if (e.pointerId !== dragId) return;
    dragId = null;
    root.classList.remove('is-dragging');
    try { frame.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  frame.addEventListener('pointerdown', onDown);
  frame.addEventListener('pointermove', onMove);
  frame.addEventListener('pointerup', onUp);
  frame.addEventListener('pointercancel', onUp);
  frame.addEventListener('lostpointercapture', onUp);

  function onKey(e) {
    const big = 10;
    const step = e.shiftKey ? big : 1;
    let next = null;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': next = pos - step; break;
      case 'ArrowRight': case 'ArrowUp': next = pos + step; break;
      case 'PageDown': next = pos - big; break;
      case 'PageUp': next = pos + big; break;
      case 'Home': next = 0; break;
      case 'End': next = 100; break;
      default: return;
    }
    e.preventDefault();
    stopNudge();
    setPos(next);
  }
  divider.addEventListener('keydown', onKey);

  // ---------- Nudge hint ----------
  function stopNudge() {
    if (nudgeAnim) { cancelAnimationFrame(nudgeAnim); nudgeAnim = null; }
  }
  function nudge() {
    if (mode === 'side' || reducedMotion() || dragId !== null) return;
    stopNudge();
    const start = pos, t0 = performance.now(), dur = 1400;
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      // damped sine around the start position
      const off = Math.sin(t * Math.PI * 3) * 9 * (1 - t) * (1 - t);
      setPos(start + off);
      nudgeAnim = t < 1 ? requestAnimationFrame(tick) : null;
      if (t >= 1) setPos(start);
    };
    nudgeAnim = requestAnimationFrame(tick);
  }

  // ---------- Images ----------
  let ready = Promise.resolve();

  async function set(next = {}) {
    const token = ++loadToken;
    const hasBefore = 'before' in next, hasAfter = 'after' in next;
    if (!hasBefore && !hasAfter) return;
    if (!imgs.before && !imgs.after) root.classList.add('is-loading');
    let done;
    ready = new Promise((r) => { done = r; });
    api.ready = ready;
    try {
      let b, a;
      try {
        [b, a] = await Promise.all([
          hasBefore ? toDrawable(next.before) : undefined,
          hasAfter ? toDrawable(next.after) : undefined,
        ]);
      } catch (err) {
        if (token === loadToken) root.classList.remove('is-loading');
        throw err;
      }
      if (destroyed || token !== loadToken) {
        if (hasBefore) release(b);
        if (hasAfter) release(a);
        return;
      }
      // Swap atomically so the old pair stays visible until the new pair is decoded.
      if (hasBefore) { release(imgs.before); imgs.before = b; }
      if (hasAfter) { release(imgs.after); imgs.after = a; }
      root.classList.toggle('is-loading', !imgs.before && !imgs.after);
      applyAspect();
      draw();
    } finally {
      done();
    }
  }

  function setMode(m) {
    if (!MODES.includes(m) || m === mode) return;
    mode = m;
    applyMode();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopNudge();
    if (rafId) cancelAnimationFrame(rafId);
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', scheduleDraw);
    release(imgs.before);
    release(imgs.after);
    imgs = { before: null, after: null };
    root.remove();
  }

  const api = {
    element: root,
    ready,
    set,
    setMode,
    setPosition: setPos,
    getPosition: () => pos,
    setLabels(l) { customLabels = l || null; applyMode(); },
    nudge,
    destroy,
  };

  setPos(pos);
  applyMode();
  if (options.before != null || options.after != null) {
    const init = {};
    if (options.before != null) init.before = options.before;
    if (options.after != null) init.after = options.after;
    set(init).catch((err) => console.error(err));
  }
  return api;
}

export default createCompare;
