// The stage: the current photo drawn big on a canvas, drag handles on the right and
// bottom edges (and the corner), the live seam-carving preview while dragging, and the
// Keep/Remove brush. All drawing happens in requestAnimationFrame; buffers are reused.

import { renderOrder } from '../livepreview.js';
import { paintSegment, LABEL_KEEP, LABEL_REMOVE, LABEL_NONE } from './photo.js';
import { clamp, reducedMotion } from './util.js';
import { sizeLimits } from './settings.js';

const PAD = 34;          // room around the photo for the handles
const MAX_ZOOM = 1.5;    // CSS px per source px for small photos
const ANIM_MS = 560;

// A damped spring, 0 -> 1 with a little overshoot (matches --ease-spring).
function spring(t) {
  const z = 0.55, w = 2 * Math.PI * 1.45;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}

export class Stage {
  /**
   * host: {
   *   sig(), target(photo) -> {w,h}, maxPixels(),
   *   input(w, h, phase)      phase: 'move' | 'end' | 'key'
   *   needMap(axis)           a seam map is wanted for the preview
   *   marksChanged()          a stroke ended / undo / clear
   * }
   */
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.canvas = root.querySelector('#stage-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.frame = root.querySelector('#stage-frame');
    this.bounds = root.querySelector('#stage-bounds');
    this.overlay = root.querySelector('#stage-overlay');
    this.octx = this.overlay.getContext('2d');
    this.cursor = root.querySelector('#stage-cursor');
    this.hx = root.querySelector('#handle-x');
    this.hy = root.querySelector('#handle-y');
    this.hxy = root.querySelector('#handle-xy');
    this.bubble = root.querySelector('#stage-bubble');
    this.chipPreparing = root.querySelector('#chip-preparing');
    this.chipApprox = root.querySelector('#chip-approx');
    this.coach = root.querySelector('#coach');

    this.photo = null;
    this.mode = 'edit';
    this.vt = { w: 1, h: 1 };
    this.layout = null;
    this.frozen = null;      // layout frozen during drags/animations
    this.drag = null;
    this.anim = null;
    this.raf = 0;
    this.dpr = 1;
    this.brush = { label: LABEL_KEEP, size: 48 };
    this.stroke = null;
    this.overlayData = null;
    this.pcanvas = document.createElement('canvas');
    this.pctx = this.pcanvas.getContext('2d');
    this.pbuf = null;
    this.lastPreview = null;

    this._bind();
    const ro = new ResizeObserver(() => { this._resizeCanvas(); this.render(); });
    ro.observe(root);
    this._resizeCanvas();
  }

  // ------------------------------------------------------------------ public

  setPhoto(photo) {
    if (this.drag) this._endDrag(true);
    this._stopAnim();
    this.photo = photo;
    this.frozen = null;
    this.pbuf = null;
    this.overlayData = null;
    if (photo && photo.status === 'ready') {
      this.vt = { ...this.host.target(photo) };
      const p = photo.proxy;
      this.pcanvas.width = p.width * 2;
      this.pcanvas.height = p.height * 2;
      this.overlay.width = p.width;
      this.overlay.height = p.height;
      this._rebuildOverlay();
    }
    this.render();
  }

  /** Re-reads the photo's target (after a preset change etc). animate: carve visibly. */
  sync({ animate = false } = {}) {
    const p = this.photo;
    if (!p || p.status !== 'ready' || this.drag) { this.render(); return; }
    const t = this.host.target(p);
    if (t.w === this.vt.w && t.h === this.vt.h) { this.render(); return; }
    if (animate && !reducedMotion() && this.mode === 'edit') this._animate(t);
    else { this._stopAnim(); this.vt = { ...t }; this.frozen = null; this.render(); }
  }

  setMode(mode) {
    this.mode = mode;
    this.root.dataset.mode = mode;
    if (mode === 'mark') { this._stopAnim(); this._rebuildOverlay(); }
    this.cursor.classList.remove('is-on');
    this.render();
  }

  setBrush({ label, size }) {
    if (label !== undefined) this.brush.label = label;
    if (size !== undefined) this.brush.size = size;
    this._sizeCursor();
  }

  marksReset() {
    this._rebuildOverlay();
    this.render();
  }

  showCoach(on) {
    this.coach.hidden = !on;
  }

  render() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this._draw(); });
  }

  // ------------------------------------------------------------------ layout

  _resizeCanvas() {
    const r = this.root.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.sw = r.width;
    this.sh = r.height;
    if (!this.drag && !this.anim) this.frozen = null;
  }

  _computeLayout(t) {
    const p = this.photo;
    const W = p.W, H = p.H;
    const bw = Math.max(W, t.w), bh = Math.max(H, t.h);
    const availW = Math.max(40, this.sw - PAD * 2);
    const availH = Math.max(40, this.sh - PAD * 2);
    const scale = Math.min(availW / bw, availH / bh, MAX_ZOOM);
    const ox = Math.round((this.sw - bw * scale) / 2);
    const oy = Math.round((this.sh - bh * scale) / 2);
    return { scale, ox, oy };
  }

  _layout() {
    if (this.frozen) return this.frozen;
    const t = this.mode === 'mark' ? { w: this.photo.W, h: this.photo.H } : this.vt;
    return this._computeLayout(t);
  }

  // ------------------------------------------------------------------ drawing

  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const p = this.photo;
    const ready = p && p.status === 'ready';
    this.root.classList.toggle('has-photo', !!ready);
    if (!ready) {
      this._chips(false, false);
      return;
    }
    const L = this._layout();
    this.layout = L;
    const mark = this.mode === 'mark';
    const t = mark ? { w: p.W, h: p.H } : this.vt;
    const dw = t.w * L.scale, dh = t.h * L.scale;

    let src = p.display, sx = 0, sy = 0, sw = p.display.width, sh = p.display.height;
    let preparing = false, approx = false;
    const sig = this.host.sig();
    if (!mark) {
      const res = p.result;
      if (res && res.w === t.w && res.h === t.h && res.key === p.resultKey(t.w, t.h, sig)) {
        src = res.display; sw = src.width; sh = src.height;
      } else if (!(t.w === p.W && t.h === p.H)) {
        const pv = this._preview(p, t, sig);
        if (pv.src) { src = pv.src; sw = pv.sw; sh = pv.sh; }
        preparing = pv.preparing;
        approx = pv.approx;
      }
    }

    const d = this.dpr;
    const x = L.ox * d, y = L.oy * d, w = dw * d, h = dh * d;
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 6 * d);
    else ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.drag || this.anim ? 'low' : 'high';
    ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();

    // DOM decorations
    this._place(this.frame, L.ox, L.oy, dw, dh);
    this._place(this.bounds, L.ox, L.oy, p.W * L.scale, p.H * L.scale);
    this.bounds.classList.toggle('is-visible', !mark && (t.w !== p.W || t.h !== p.H));
    if (mark) this._place(this.overlay, L.ox, L.oy, dw, dh);
    this.hx.style.transform = `translate(${L.ox + dw}px, ${L.oy + dh / 2}px)`;
    this.hy.style.transform = `translate(${L.ox + dw / 2}px, ${L.oy + dh}px)`;
    this.hxy.style.transform = `translate(${L.ox + dw}px, ${L.oy + dh}px)`;
    const bx = Math.min(L.ox + dw + 14, this.sw - 120);
    const by = Math.min(L.oy + dh + 14, this.sh - 40);
    this.bubble.style.transform = `translate(${Math.max(8, bx)}px, ${Math.max(8, by)}px)`;
    this.bubble.textContent = `${t.w} × ${t.h}`;
    this.coach.style.transform = `translate(${L.ox + dw}px, ${L.oy + dh / 2}px)`;
    this._aria(p, t);
    this._chips(preparing, approx);
  }

  _place(node, x, y, w, h) {
    const s = node.style;
    s.left = x + 'px';
    s.top = y + 'px';
    s.width = Math.max(1, w) + 'px';
    s.height = Math.max(1, h) + 'px';
  }

  _chips(preparing, approx) {
    this.chipPreparing.hidden = !preparing;
    this.chipApprox.hidden = !approx || preparing || !(this.drag || this.anim);
  }

  _aria(p, t) {
    const L = sizeLimits(p.W, p.H, this.host.maxPixels());
    const set = (node, now, min, max, text) => {
      node.setAttribute('aria-valuemin', String(min));
      node.setAttribute('aria-valuemax', String(max));
      node.setAttribute('aria-valuenow', String(now));
      node.setAttribute('aria-valuetext', text);
    };
    set(this.hx, t.w, L.minW, L.maxW, `${t.w} pixels wide (original ${p.W})`);
    set(this.hy, t.h, L.minH, L.maxH, `${t.h} pixels tall (original ${p.H})`);
    this.frame.setAttribute('aria-label', `${p.name}, shown at ${t.w} by ${t.h} pixels`);
  }

  /** Live preview from the seam map of the dominant axis. */
  _preview(p, t, sig) {
    const pr = p.proxy;
    const dwp = Math.max(1, Math.round(t.w * p.pscaleX));
    const dhp = Math.max(1, Math.round(t.h * p.pscaleY));
    const kx = pr.width - dwp;
    const ky = pr.height - dhp;
    const rx = Math.abs(t.w - p.W) / p.W;
    const ry = Math.abs(t.h - p.H) / p.H;
    if (!kx && !ky) return { src: this._proxyCanvas(p), sw: pr.width, sh: pr.height };
    const axis = rx >= ry ? 'x' : 'y';
    const k = axis === 'x' ? kx : ky;
    const approx = rx > 0.004 && ry > 0.004;
    const map = p.mapFor(axis, sig);
    if (!map) {
      this.host.needMap(axis);
      // Plain squash until the smart preview is ready.
      return { src: null, preparing: true, approx: false };
    }
    if (!k) return { src: this._proxyCanvas(p), sw: pr.width, sh: pr.height, approx };
    const kc = clamp(k, -map.seams, map.seams);
    const ow = axis === 'x' ? pr.width - kc : pr.width;
    const oh = axis === 'y' ? pr.height - kc : pr.height;
    const need = ow * oh * 4;
    if (!this.pbuf || this.pbuf.length < need) this.pbuf = new Uint8ClampedArray(pr.width * pr.height * 4 * 2);
    const out = new ImageData(new Uint8ClampedArray(this.pbuf.buffer, 0, need), ow, oh);
    renderOrder(pr.rgba, pr.width, pr.height, map.order, axis, kc, out);
    this.pctx.putImageData(out, 0, 0);
    return { src: this.pcanvas, sw: ow, sh: oh, approx };
  }

  _proxyCanvas(p) {
    const pr = p.proxy;
    this.pctx.putImageData(new ImageData(pr.rgba, pr.width, pr.height), 0, 0);
    return this.pcanvas;
  }

  // ------------------------------------------------------------------ animation

  _animate(to) {
    this._stopAnim();
    const from = { ...this.vt };
    const p = this.photo;
    const both = { w: Math.max(from.w, to.w), h: Math.max(from.h, to.h) };
    this.frozen = this._computeLayout(both);
    const t0 = performance.now();
    const step = (now) => {
      if (!this.anim) return;
      const t = Math.min(1, (now - t0) / ANIM_MS);
      const e = spring(t);
      // overshoot is fine visually but must stay inside the limits
      this.vt = {
        w: Math.round(clamp(from.w + (to.w - from.w) * e, 8, p.W * 2)),
        h: Math.round(clamp(from.h + (to.h - from.h) * e, 8, p.H * 2)),
      };
      if (t >= 1) {
        this.vt = { ...to };
        this.anim = null;
        this.frozen = null;
        this.root.classList.remove('is-animating');
      } else {
        this.anim.raf = requestAnimationFrame(step);
      }
      this._draw();
    };
    this.anim = { raf: requestAnimationFrame(step) };
    this.root.classList.add('is-animating');
  }

  _stopAnim() {
    if (this.anim) {
      cancelAnimationFrame(this.anim.raf);
      this.anim = null;
      this.frozen = null;
      this.root.classList.remove('is-animating');
    }
  }

  // ------------------------------------------------------------------ handles

  _bind() {
    for (const [node, kind] of [[this.hx, 'x'], [this.hy, 'y'], [this.hxy, 'xy']]) {
      node.addEventListener('pointerdown', (e) => this._startDrag(e, kind, node));
      node.addEventListener('pointermove', (e) => this._moveDrag(e));
      node.addEventListener('pointerup', (e) => { if (this.drag && e.pointerId === this.drag.id) this._endDrag(false); });
      node.addEventListener('pointercancel', (e) => { if (this.drag && e.pointerId === this.drag.id) this._endDrag(false); });
      node.addEventListener('lostpointercapture', (e) => { if (this.drag && e.pointerId === this.drag.id) this._endDrag(false); });
      node.addEventListener('dblclick', () => this._resetAxis(kind));
    }
    this.hx.addEventListener('keydown', (e) => this._key(e, 'x'));
    this.hy.addEventListener('keydown', (e) => this._key(e, 'y'));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag) { e.preventDefault(); this._endDrag(true); }
    });

    // brush
    this.root.addEventListener('pointerdown', (e) => this._brushDown(e));
    this.root.addEventListener('pointermove', (e) => this._brushMove(e));
    this.root.addEventListener('pointerup', (e) => this._brushUp(e));
    this.root.addEventListener('pointercancel', (e) => this._brushUp(e));
    this.root.addEventListener('pointerleave', () => this.cursor.classList.remove('is-on'));
  }

  _startDrag(e, kind, node) {
    const p = this.photo;
    if (!p || p.status !== 'ready' || this.mode !== 'edit') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this._stopAnim();
    try { node.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const L = this._layout();
    // Freeze the scale so the handle stays under the pointer; leave room to grow.
    this.frozen = L;
    this.drag = { id: e.pointerId, kind, node, x: e.clientX, y: e.clientY, w: this.vt.w, h: this.vt.h, moved: false };
    this.root.classList.add('is-dragging');
    node.classList.add('is-grabbed');
    if (kind !== 'xy') node.focus({ preventScroll: true });
    this.host.dragStart && this.host.dragStart();
  }

  _moveDrag(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this.photo;
    const L = this.frozen;
    const lim = sizeLimits(p.W, p.H, this.host.maxPixels());
    // The handle cannot leave the stage: that bounds how far a drag can grow.
    const maxW = Math.min(lim.maxW, Math.floor((this.sw - 10 - L.ox) / L.scale));
    const maxH = Math.min(lim.maxH, Math.floor((this.sh - 10 - L.oy) / L.scale));
    let w = d.w, h = d.h;
    if (d.kind !== 'y') w = clamp(Math.round(d.w + (e.clientX - d.x) / L.scale), lim.minW, Math.max(lim.minW, maxW));
    if (d.kind !== 'x') h = clamp(Math.round(d.h + (e.clientY - d.y) / L.scale), lim.minH, Math.max(lim.minH, maxH));
    if (w * h > lim.maxPixels) return;
    if (w === this.vt.w && h === this.vt.h) return;
    d.moved = true;
    this.vt = { w, h };
    this.host.input(w, h, 'move');
    this.render();
  }

  _endDrag(cancel) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { d.node.releasePointerCapture(d.id); } catch { /* ignore */ }
    d.node.classList.remove('is-grabbed');
    this.root.classList.remove('is-dragging');
    if (cancel) {
      this.vt = { w: d.w, h: d.h };
      this.host.input(d.w, d.h, 'end');
    } else if (d.moved) {
      this.host.input(this.vt.w, this.vt.h, 'end');
    }
    this.frozen = null;
    this.render();
  }

  _resetAxis(kind) {
    const p = this.photo;
    if (!p || this.mode !== 'edit') return;
    const w = kind === 'y' ? this.vt.w : p.W;
    const h = kind === 'x' ? this.vt.h : p.H;
    this.vt = { w, h };
    this.host.input(w, h, 'end');
    this.render();
  }

  _key(e, axis) {
    const p = this.photo;
    if (!p || p.status !== 'ready' || this.mode !== 'edit') return;
    const lim = sizeLimits(p.W, p.H, this.host.maxPixels());
    const size = axis === 'x' ? p.W : p.H;
    const cur = axis === 'x' ? this.vt.w : this.vt.h;
    const min = axis === 'x' ? lim.minW : lim.minH;
    const max = axis === 'x' ? lim.maxW : lim.maxH;
    const big = Math.max(10, Math.round(size * 0.1));
    // Keys move the handle the way it moves on screen: the width handle grows to the
    // right, the height handle grows downwards (so Up makes the photo shorter).
    const small = e.shiftKey ? 10 : 1;
    const grow = axis === 'x'
      ? { ArrowRight: small, ArrowUp: small, ArrowLeft: -small, ArrowDown: -small, PageUp: big, PageDown: -big }
      : { ArrowDown: small, ArrowRight: small, ArrowUp: -small, ArrowLeft: -small, PageDown: big, PageUp: -big };
    let next = null;
    if (e.key in grow) next = cur + grow[e.key];
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    this._stopAnim();
    next = clamp(next, min, max);
    let w = axis === 'x' ? next : this.vt.w;
    let h = axis === 'y' ? next : this.vt.h;
    if (w * h > lim.maxPixels) return;
    this.vt = { w, h };
    this.host.input(w, h, 'key');
    this.render();
  }

  // ------------------------------------------------------------------ brush

  _toSource(e) {
    const r = this.root.getBoundingClientRect();
    const L = this.layout;
    return { x: (e.clientX - r.left - L.ox) / L.scale, y: (e.clientY - r.top - L.oy) / L.scale };
  }

  _sizeCursor() {
    const s = this.brush.size;
    this.cursor.style.width = s + 'px';
    this.cursor.style.height = s + 'px';
    this.cursor.dataset.tool = this.brush.label === LABEL_KEEP ? 'keep' : this.brush.label === LABEL_REMOVE ? 'remove' : 'erase';
  }

  _moveCursor(e) {
    const r = this.root.getBoundingClientRect();
    const s = this.brush.size;
    this.cursor.style.transform = `translate(${e.clientX - r.left - s / 2}px, ${e.clientY - r.top - s / 2}px)`;
    this.cursor.classList.add('is-on');
  }

  _brushDown(e) {
    if (this.mode !== 'mark' || !this.photo || this.photo.status !== 'ready' || !this.layout) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.job, .notice, .stage__chips')) return;
    e.preventDefault();
    try { this.root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this._sizeCursor();
    this._moveCursor(e);
    const p = this.photo;
    const r = (this.brush.size / 2) / this.layout.scale;
    const s = this.stroke = { id: e.pointerId, data: p.beginStroke(this.brush.label, r) };
    const pt = this._toSource(e);
    s.data.pts.push(pt.x, pt.y);
    this._paint(pt.x, pt.y, pt.x, pt.y);
  }

  _brushMove(e) {
    if (this.mode !== 'mark') return;
    if (e.pointerType !== 'touch') { this._sizeCursor(); this._moveCursor(e); }
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const pt = this._toSource(ev);
      const pts = s.data.pts;
      const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
      if (Math.hypot(pt.x - lx, pt.y - ly) * this.layout.scale < 1.5) continue;
      pts.push(pt.x, pt.y);
      this._paint(lx, ly, pt.x, pt.y);
    }
  }

  _brushUp(e) {
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    this.stroke = null;
    try { this.root.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.pointerType === 'touch') this.cursor.classList.remove('is-on');
    this.photo.commitMarks();
    this.host.marksChanged();
  }

  _paint(ax, ay, bx, by) {
    const p = this.photo;
    const pr = p.proxy;
    const r = this.stroke.data.r;
    paintSegment(p.proxyLabels, pr.width, pr.height, p.pscale, ax, ay, bx, by, r, this.stroke.data.label, (box) => this._updateOverlay(box));
  }

  _rebuildOverlay() {
    const p = this.photo;
    if (!p || p.status !== 'ready') return;
    const pr = p.proxy;
    if (!this.overlayData || this.overlayData.width !== pr.width || this.overlayData.height !== pr.height) {
      this.overlay.width = pr.width;
      this.overlay.height = pr.height;
      this.overlayData = new ImageData(pr.width, pr.height);
    }
    this._updateOverlay({ x0: 0, y0: 0, x1: pr.width - 1, y1: pr.height - 1 });
  }

  _updateOverlay(box) {
    const p = this.photo;
    const od = this.overlayData;
    if (!od) return;
    const w = od.width;
    const lab = p.proxyLabels;
    const d = od.data;
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0, i = y * w + box.x0; x <= box.x1; x++, i++) {
        const v = lab[i];
        const o = i * 4;
        if (v === LABEL_KEEP) {
          d[o] = 34; d[o + 1] = 197; d[o + 2] = 120; d[o + 3] = 120;
        } else if (v === LABEL_REMOVE) {
          const stripe = ((x + y) >> 2) & 1;
          d[o] = 255; d[o + 1] = 52; d[o + 2] = 96; d[o + 3] = stripe ? 175 : 95;
        } else {
          d[o + 3] = 0;
        }
      }
    }
    this.octx.putImageData(od, 0, 0, box.x0, box.y0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1);
  }
}

export { LABEL_KEEP, LABEL_REMOVE, LABEL_NONE };
