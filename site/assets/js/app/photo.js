// One photo in the batch: decoded pixels, a small proxy for live previews, seam-order
// maps for that proxy, Keep/Remove marks, and the exact full-resolution result.

import { getEngine } from '../engine.js';
import { imgToCanvas, fitLongEdge } from './util.js';
import { NEVER_REMOVED } from '../livepreview.js';

/** Long edge of the live-preview proxy (seam maps are built on it). */
export const PROXY_EDGE = 720;
/** Long edge of the bitmap drawn on the stage (crisp on retina, cheap to draw). */
const DISPLAY_EDGE = 2048;
/** Share of the proxy each seam map can remove. */
const MAP_SHARE = 0.9;

export const LABEL_NONE = 0;
export const LABEL_KEEP = 1;
export const LABEL_REMOVE = 2;

let nextId = 1;

function abortError() {
  try { return new DOMException('Aborted', 'AbortError'); } catch { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }
}
export const isAbort = (err) => err && err.name === 'AbortError';

/** Fills a disc of `label` into a w x h label raster. Returns the touched box or null. */
function dab(labels, w, h, cx, cy, r, label) {
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  if (y0 > y1) return null;
  let bx0 = w, bx1 = -1;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const span = r2 - dy * dy;
    if (span < 0) continue;
    const half = Math.sqrt(span);
    const x0 = Math.max(0, Math.ceil(cx - half - 0.5));
    const x1 = Math.min(w - 1, Math.floor(cx + half - 0.5));
    if (x0 > x1) continue;
    labels.fill(label, y * w + x0, y * w + x1 + 1);
    if (x0 < bx0) bx0 = x0;
    if (x1 > bx1) bx1 = x1;
  }
  return bx1 < 0 ? null : { x0: bx0, y0, x1: bx1, y1 };
}

/**
 * Rasterizes stroke segment (ax,ay)->(bx,by) (source coords) at `scale`.
 * Calls onBox for each touched box (for overlay updates).
 */
export function paintSegment(labels, w, h, scale, ax, ay, bx, by, r, label, onBox) {
  const sr = Math.max(0.75, r * scale);
  const x0 = ax * scale, y0 = ay * scale, x1 = bx * scale, y1 = by * scale;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(0.75, sr * 0.3);
  const n = Math.max(1, Math.ceil(len / step));
  let box = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const b = dab(labels, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, sr, label);
    if (b) {
      if (!box) box = b;
      else {
        if (b.x0 < box.x0) box.x0 = b.x0;
        if (b.y0 < box.y0) box.y0 = b.y0;
        if (b.x1 > box.x1) box.x1 = b.x1;
        if (b.y1 > box.y1) box.y1 = b.y1;
      }
    }
  }
  if (box && onBox) onBox(box);
  return box;
}

/** Rasterizes a whole stroke list into a fresh label raster. */
function rasterize(strokes, w, h, scale) {
  const labels = new Uint8Array(w * h);
  for (const s of strokes) {
    const p = s.pts;
    if (p.length === 2) paintSegment(labels, w, h, scale, p[0], p[1], p[0], p[1], s.r, s.label);
    for (let i = 2; i < p.length; i += 2) paintSegment(labels, w, h, scale, p[i - 2], p[i - 1], p[i], p[i + 1], s.r, s.label);
  }
  return labels;
}

/** Engine masks (1 byte/pixel, 255 = marked) from a label raster; null when unused. */
function masksFrom(labels) {
  let keep = 0, rem = 0;
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    if (v === LABEL_KEEP) keep++;
    else if (v === LABEL_REMOVE) rem++;
  }
  let protect = null, remove = null;
  if (keep) {
    protect = new Uint8Array(labels.length);
    for (let i = 0; i < labels.length; i++) if (labels[i] === LABEL_KEEP) protect[i] = 255;
  }
  if (rem) {
    remove = new Uint8Array(labels.length);
    for (let i = 0; i < labels.length; i++) if (labels[i] === LABEL_REMOVE) remove[i] = 255;
  }
  return { protect, remove };
}

export class Photo {
  constructor(file) {
    this.id = nextId++;
    this.file = file;
    this.name = (file && file.name) || 'photo';
    this.type = (file && file.type) || '';
    this.status = 'loading'; // loading | toobig | ready | error
    this.error = null;
    this.tooBig = null;      // { width, height } when decode said TOO_BIG
    this.img = null;
    this.W = 0;
    this.H = 0;
    this.display = null;     // canvas, long edge <= DISPLAY_EDGE
    this.proxy = null;       // Img, long edge <= PROXY_EDGE
    this.pscale = 1;         // proxy px per source px (x and y may differ by rounding)
    this.pscaleX = 1;
    this.pscaleY = 1;
    this.maps = { x: null, y: null };
    this.mapJobs = { x: null, y: null };
    this.strokes = [];
    this.undoStack = [];
    this.maskVersion = 0;
    this.proxyLabels = null;
    this.override = null;    // { w, h } chosen for this photo only
    this.result = null;      // { img, key, w, h, display }
    this.job = null;         // { key, ctrl, progress, promise }
    this.batchDone = false;
    this.onChange = () => {};
  }

  get hasMarks() { return this.strokes.length > 0; }

  /** Decodes the file. Resolves when status is ready / toobig / error. */
  async load() {
    const engine = getEngine();
    try {
      const img = await engine.decode(this.file, { maxPixels: engine.limits.maxPixels });
      await this._setImg(img);
    } catch (err) {
      if (err && err.code === 'TOO_BIG') {
        this.status = 'toobig';
        this.tooBig = { width: err.width, height: err.height };
      } else {
        this.status = 'error';
        this.error = err && err.code === 'UNSUPPORTED' && !this._looksSupported()
          ? `This browser can’t open “${this.name}”. Try a JPG, PNG or WebP.`
          : `“${this.name}” looks damaged, or isn’t really a photo.`;
      }
    }
    this.onChange(this, 'status');
  }

  /** True when the type or extension is one every browser opens (so a failure means a bad file). */
  _looksSupported() {
    return /^image\/(jpeg|png|webp|gif|bmp)$/.test(this.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(this.name);
  }

  /** For TOO_BIG photos: shrink to the device limit, then continue. */
  async shrinkToLimit() {
    const engine = getEngine();
    this.status = 'loading';
    this.onChange(this, 'status');
    try {
      const img = await engine.downscale(this.file, engine.limits.maxPixels);
      this.tooBig = null;
      await this._setImg(img);
    } catch (err) {
      this.status = 'error';
      this.error = 'This photo could not be shrunk on this device.';
    }
    this.onChange(this, 'status');
  }

  async _setImg(img) {
    const engine = getEngine();
    this.img = img;
    this.W = img.width;
    this.H = img.height;
    const d = fitLongEdge(img.width, img.height, DISPLAY_EDGE);
    const dimg = await engine.downscale(img, d.width * d.height);
    this.display = imgToCanvas(dimg);
    const p = fitLongEdge(img.width, img.height, PROXY_EDGE);
    this.proxy = await engine.downscale(dimg, p.width * p.height);
    this.pscaleX = this.proxy.width / img.width;
    this.pscaleY = this.proxy.height / img.height;
    this.pscale = (this.pscaleX + this.pscaleY) / 2;
    this.proxyLabels = new Uint8Array(this.proxy.width * this.proxy.height);
    this.status = 'ready';
  }

  // ---------------- marks ----------------

  /** Starts a stroke; returns a function(x, y) to extend it and the stroke object. */
  beginStroke(label, r) {
    const stroke = { label, r, pts: [] };
    this.undoStack.push(this.strokes);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.strokes = this.strokes.concat([stroke]);
    return stroke;
  }

  /** Called when a stroke has ended (marks changed). */
  commitMarks() {
    this.maskVersion++;
    this._invalidate();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.strokes = this.undoStack.pop();
    this.rebuildProxyLabels();
    this.commitMarks();
    return true;
  }

  clearMarks() {
    if (!this.strokes.length) return false;
    this.undoStack.push(this.strokes);
    this.strokes = [];
    this.rebuildProxyLabels();
    this.commitMarks();
    return true;
  }

  rebuildProxyLabels() {
    if (!this.proxy) return;
    this.proxyLabels = rasterize(this.strokes, this.proxy.width, this.proxy.height, this.pscale);
  }

  _sourceMasks() {
    if (!this.strokes.length) return { protect: null, remove: null };
    // Rasterized per job and not kept: a full-size label raster is W*H bytes per photo.
    return masksFrom(rasterize(this.strokes, this.W, this.H, 1));
  }

  // ---------------- maps ----------------

  _invalidate() {
    // Marks or carving options changed: maps and the result are stale.
    for (const axis of ['x', 'y']) {
      if (this.mapJobs[axis]) { this.mapJobs[axis].ctrl.abort(); this.mapJobs[axis] = null; }
      this.maps[axis] = null;
    }
  }

  /** Called when carving options changed. */
  optionsChanged() {
    this._invalidate();
  }

  mapKey(axis, sig) {
    return `${axis}|${sig}|${this.maskVersion}`;
  }

  /** The ready map for axis under options sig, or null. */
  mapFor(axis, sig) {
    const m = this.maps[axis];
    return m && m.key === this.mapKey(axis, sig) ? m : null;
  }

  /** Builds (once) the seam-order map of the proxy for axis. Resolves to the map or null. */
  ensureMap(axis, opts, sig) {
    if (this.status !== 'ready') return Promise.resolve(null);
    const key = this.mapKey(axis, sig);
    const have = this.maps[axis];
    if (have && have.key === key) return Promise.resolve(have);
    const job = this.mapJobs[axis];
    if (job && job.key === key) return job.promise;
    if (job) job.ctrl.abort();
    const ctrl = new AbortController();
    const p = this.proxy;
    const size = axis === 'x' ? p.width : p.height;
    const maxSeams = Math.min(65534, Math.max(1, Math.floor(size * MAP_SHARE)));
    let protect = null, remove = null;
    if (this.strokes.length) ({ protect, remove } = masksFrom(this.proxyLabels));
    const promise = getEngine()
      .seamOrder(p, { axis, maxSeams, ...opts, protect, remove, signal: ctrl.signal })
      .then((r) => {
        if (this.mapJobs[axis] && this.mapJobs[axis].ctrl === ctrl) this.mapJobs[axis] = null;
        if (ctrl.signal.aborted) return null;
        let seams = 0;
        const o = r.order;
        if (axis === 'x') { for (let x = 0; x < p.width; x++) if (o[x] !== NEVER_REMOVED) seams++; }
        else { for (let y = 0; y < p.height; y++) if (o[y * p.width] !== NEVER_REMOVED) seams++; }
        this.maps[axis] = { key, order: o, axis, seams };
        this.onChange(this, 'map');
        return this.maps[axis];
      })
      .catch((err) => {
        if (this.mapJobs[axis] && this.mapJobs[axis].ctrl === ctrl) this.mapJobs[axis] = null;
        if (!isAbort(err)) console.warn('Seam map failed', err);
        return null;
      });
    this.mapJobs[axis] = { key, ctrl, promise };
    return promise;
  }

  isMapPending(axis) {
    return !!this.mapJobs[axis];
  }

  // ---------------- result ----------------

  resultKey(w, h, sig) {
    return `${w}x${h}|${sig}|${this.maskVersion}`;
  }

  hasResult(w, h, sig) {
    return !!(this.result && this.result.key === this.resultKey(w, h, sig));
  }

  /**
   * Computes the exact result for (w, h). Reuses a matching result or running job;
   * cancels a job for a different size. Resolves to the result, rejects on error/abort.
   */
  compute(w, h, opts, sig) {
    if (this.status !== 'ready') return Promise.reject(new Error('Photo is not ready'));
    const key = this.resultKey(w, h, sig);
    if (this.result && this.result.key === key) return Promise.resolve(this.result);
    if (this.job && this.job.key === key) return this.job.promise;
    this.cancel();
    const ctrl = new AbortController();
    const job = { key, ctrl, progress: 0, promise: null, started: performance.now() };
    this.job = job;
    this.onChange(this, 'job');

    const run = async () => {
      let out;
      if (w === this.W && h === this.H && !this.strokes.length) {
        out = this.img;
      } else {
        const { protect, remove } = this._sourceMasks();
        out = await getEngine().resize(this.img, { width: w, height: h, ...opts, protect, remove }, {
          signal: ctrl.signal,
          onProgress: (f) => {
            job.progress = f;
            this.onChange(this, 'progress');
          },
        });
      }
      if (ctrl.signal.aborted) throw abortError();
      const result = { img: out, key, w: out.width, h: out.height, display: null };
      // Display bitmap for the stage.
      if (out === this.img) result.display = this.display;
      else {
        const d = fitLongEdge(out.width, out.height, DISPLAY_EDGE);
        const dimg = await getEngine().downscale(out, d.width * d.height);
        result.display = imgToCanvas(dimg);
      }
      if (ctrl.signal.aborted) throw abortError();
      this.result = result;
      return result;
    };
    job.promise = run().finally(() => {
      if (this.job === job) {
        this.job = null;
        this.onChange(this, 'job');
      }
    });
    job.promise.then(() => this.onChange(this, 'result'), () => {});
    return job.promise;
  }

  cancel() {
    if (this.job) {
      const j = this.job;
      this.job = null;
      j.ctrl.abort();
      this.onChange(this, 'job');
    }
  }

  dispose() {
    this.cancel();
    this._invalidate();
    for (const c of [this.display, this.result && this.result.display]) {
      if (c) { c.width = 0; c.height = 0; }
    }
    this.img = this.proxy = this.result = null;
  }
}
