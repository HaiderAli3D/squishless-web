// Squishless browser engine (main thread). See ARCHITECTURE.md "Browser modules".
//
//   import { getEngine } from '/assets/js/engine.js';
//   const engine = getEngine();
//   const img = await engine.decode(file);                      // { rgba, width, height, type, name }
//   const out = await engine.resize(img, { width: 800 }, { signal, onProgress });
//   const blob = await engine.encode(out, { type: 'image/jpeg', quality: 0.9 });
//
// Seam carving runs in a small pool of Web Workers (worker.js), each with its own copy of
// the Go/WebAssembly engine. Workers start lazily. Cancelling a running job terminates its
// worker and starts a fresh one later (a Go call cannot be interrupted). A worker is also
// replaced after any large job, because Go's wasm memory never shrinks. Pixels are copied
// for a worker only when its job starts, and the pixels running at once are capped
// (pixelBudget), so queueing a whole batch of large photos is safe.

const BUILD_ID = '__BUILD_ID__';
const WORKER_URL = '/assets/js/worker.js?v=' + BUILD_ID;

/** Jobs over this many pixels (input or output) retire their worker afterwards. */
const RECYCLE_PIXELS = 6e6;

/**
 * Most pixels (input or output, summed over jobs) that may run in workers at once. A
 * worker needs about 30 bytes per pixel while carving, so three 12 MP photos at once is
 * ~1.1 GB; phones run one full-size photo at a time. A job bigger than the budget still
 * runs, alone. Small jobs (live-preview maps) may start ahead of a big one that waits.
 */
const PIXEL_BUDGET_DESKTOP = 36e6;
const PIXEL_BUDGET_PHONE = 12.5e6;
const SMALL_JOB_PIXELS = 2e6;

function detectPhone() {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
  } catch { /* ignore */ }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  if (nav.userAgentData && nav.userAgentData.mobile) return true;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4) return true;
  return false;
}

function abortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    return e;
  }
}

function codedError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function fromWorkerError(info) {
  const err = new Error((info && info.message) || 'Engine error');
  if (info && info.name && info.name !== 'Error') err.name = info.name;
  if (info && info.code) err.code = info.code;
  return err;
}

/** A copy of bytes as a Uint8Array that owns its whole buffer (safe to transfer). */
function ownedCopy(bytes) {
  if (bytes == null) return null;
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  throw new TypeError('Expected a Uint8Array mask');
}

/** Throws at call time (not when the job starts) for a mask ownedCopy cannot copy. */
function checkMask(mask) {
  if (mask == null) return;
  if (!(Array.isArray(mask) || ArrayBuffer.isView(mask) || mask instanceof ArrayBuffer)) {
    throw new TypeError('Expected a Uint8Array mask');
  }
}

function asClamped(bytes) {
  if (bytes instanceof Uint8ClampedArray) return bytes;
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function checkImg(img) {
  if (!img || !img.rgba || !(img.width > 0) || !(img.height > 0)) throw new TypeError('Expected an Img { rgba, width, height }');
  if (img.rgba.length !== img.width * img.height * 4) {
    throw new TypeError(`Img has ${img.rgba.length} bytes, want ${img.width * img.height * 4} for ${img.width}x${img.height}`);
  }
}

// ---- Canvas helpers ---------------------------------------------------------------

let offscreen2d; // cached: does OffscreenCanvas support a 2D context here?
function hasOffscreen2d() {
  if (offscreen2d === undefined) {
    offscreen2d = false;
    try {
      if (typeof OffscreenCanvas === 'function') {
        const c = new OffscreenCanvas(1, 1);
        offscreen2d = !!c.getContext('2d');
      }
    } catch { offscreen2d = false; }
  }
  return offscreen2d;
}

function makeCanvas(w, h) {
  if (hasOffscreen2d()) return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined') throw new Error('No canvas available');
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function context2d(canvas, readback) {
  const opts = { colorSpace: 'srgb' };
  if (readback) opts.willReadFrequently = true;
  let ctx = null;
  try { ctx = canvas.getContext('2d', opts); } catch { ctx = null; }
  if (!ctx) ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  return ctx;
}

function readPixels(ctx, w, h) {
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h, { colorSpace: 'srgb' });
  } catch {
    data = ctx.getImageData(0, 0, w, h);
  }
  return data.data;
}

function imageDataOf(img) {
  const data = asClamped(img.rgba);
  try {
    return new ImageData(data, img.width, img.height, { colorSpace: 'srgb' });
  } catch {
    return new ImageData(data, img.width, img.height);
  }
}

/** Canvas holding img's pixels. */
function canvasOf(img) {
  const c = makeCanvas(img.width, img.height);
  context2d(c, false).putImageData(imageDataOf(img), 0, 0);
  return c;
}

function releaseCanvas(c) {
  // Frees the backing store early (helps Safari's canvas memory limit).
  try { c.width = 0; c.height = 0; } catch { /* ignore */ }
}

/**
 * Draws src (canvas, ImageBitmap or image) at (sw x sh) scaled down to (dw x dh) with
 * good quality: halves step by step, then one final high-quality draw.
 */
function drawDownscaled(src, sw, sh, dw, dh) {
  let cur = src;
  let cw = sw;
  let ch = sh;
  const temps = [];
  while (cw / 2 >= dw && ch / 2 >= dh) {
    const nw = Math.max(dw, Math.floor(cw / 2));
    const nh = Math.max(dh, Math.floor(ch / 2));
    const c = makeCanvas(nw, nh);
    const ctx = context2d(c, false);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    temps.push(c);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(dw, dh);
  const octx = context2d(out, true);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, cw, ch, 0, 0, dw, dh);
  const rgba = readPixels(octx, dw, dh);
  for (const t of temps) releaseCanvas(t);
  releaseCanvas(out);
  return rgba;
}

/** Largest (w, h) with the same aspect ratio and w*h <= maxPixels. */
function fitPixels(width, height, maxPixels) {
  if (width * height <= maxPixels) return { width, height };
  const s = Math.sqrt(maxPixels / (width * height));
  let w = Math.max(1, Math.floor(width * s));
  let h = Math.max(1, Math.floor(height * s));
  while (w * h > maxPixels && (w > 1 || h > 1)) {
    if (w >= h && w > 1) w--; else h--;
  }
  return { width: w, height: h };
}

// ---- Decoding -----------------------------------------------------------------------

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    if (typeof Image !== 'function' || typeof URL === 'undefined') {
      reject(new Error('No image element'));
      return;
    }
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => {
      URL.revokeObjectURL(url);
      resolve(im);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image element could not decode the file'));
    };
    im.src = url;
  });
}

/** Decodes blob to a drawable source: { source, width, height, close() }. */
async function decodeSource(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch {
      // Fall back to an <img> (older Safari rejects the options, some formats only
      // decode through the image element, e.g. SVG or HEIC on some Safari versions).
    }
  }
  const im = await loadImageElement(blob);
  const w = im.naturalWidth;
  const h = im.naturalHeight;
  if (!(w > 0 && h > 0)) throw new Error('Image has no size');
  return { source: im, width: w, height: h, close: () => { im.src = ''; } };
}

// ---- Engine ----------------------------------------------------------------------------

let nextId = 1;

class Engine {
  constructor() {
    const phone = detectPhone();
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    /** Number of workers the pool grows to. */
    this.poolSize = phone ? 2 : Math.min(Math.max(1, hc - 1), 3);
    this.isPhone = phone;
    this.limits = Object.freeze({ maxPixels: phone ? 12e6 : 24e6 });
    /** Pixels that may be in flight in workers at once (see PIXEL_BUDGET_DESKTOP). */
    this.pixelBudget = phone ? PIXEL_BUDGET_PHONE : PIXEL_BUDGET_DESKTOP;
    /** Engine version string, set once a worker has loaded. */
    this.version = null;
    this._slots = [];
    this._queue = [];
    this._ready = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._loadedOnce = false;
  }

  /** Resolves when one worker has loaded the wasm engine (starts one if needed). */
  get ready() {
    if (!this._ready) {
      this._ready = new Promise((resolve, reject) => {
        this._readyResolve = resolve;
        this._readyReject = reject;
      });
      this._ready.catch(() => {});
      if (this._loadedOnce) this._settleReady(null);
      else if (!this._slots.some((s) => !s.dead)) this._spawn();
    }
    return this._ready;
  }

  /** Settles a pending ready promise: err null = loaded. A failure allows a retry. */
  _settleReady(err) {
    if (!this._readyResolve) return;
    const { _readyResolve: resolve, _readyReject: reject } = this;
    this._readyResolve = this._readyReject = null;
    if (err) {
      this._ready = null;
      reject(err);
    } else {
      resolve();
    }
  }

  /** Number of live workers (for diagnostics and tests). */
  get workerCount() {
    return this._slots.length;
  }

  // -- worker pool --

  _spawn() {
    const slot = { worker: null, job: null, dead: false, ready: false, initId: nextId++, initResolve: null, initReject: null };
    // The init promise is internal; callers use engine.ready or their job's promise.
    new Promise((resolve, reject) => {
      slot.initResolve = resolve;
      slot.initReject = reject;
    }).catch(() => {});
    this._slots.push(slot);
    let worker;
    try {
      worker = new Worker(WORKER_URL);
    } catch (err) {
      const e = codedError('ENGINE_LOAD', 'Could not start a Web Worker: ' + (err && err.message || err));
      queueMicrotask(() => this._killSlot(slot, e));
      return slot;
    }
    slot.worker = worker;
    worker.onmessage = (e) => this._onMessage(slot, e.data);
    worker.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      const loading = !!slot.initResolve;
      const msg = (e && e.message) ||
        (loading ? 'The engine worker could not start.' : 'The engine worker crashed (possibly out of memory).');
      this._killSlot(slot, codedError(loading ? 'ENGINE_LOAD' : 'ENGINE_CRASH', msg));
    };
    worker.onmessageerror = () => {
      this._killSlot(slot, codedError('ENGINE_CRASH', 'Could not read a message from the engine worker.'));
    };
    worker.postMessage({ id: slot.initId, op: 'init' });
    return slot;
  }

  _onMessage(slot, msg) {
    if (!msg || slot.dead) return;
    if (msg.id === slot.initId) {
      const resolve = slot.initResolve;
      const reject = slot.initReject;
      slot.initResolve = slot.initReject = null;
      if (msg.ok) {
        if (msg.result && msg.result.version) this.version = msg.result.version;
        slot.ready = true;
        this._loadedOnce = true;
        resolve();
        this._settleReady(null);
      } else {
        const err = fromWorkerError(msg.error);
        if (!err.code) err.code = 'ENGINE_LOAD';
        reject(err);
        this._settleReady(err);
        this._killSlot(slot, err); // also fails a job already sent to this worker
      }
      return;
    }
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    if ('progress' in msg) {
      if (job.onProgress) {
        try { job.onProgress(msg.progress); } catch (err) { console.error(err); }
      }
      return;
    }
    slot.job = null;
    job.cleanup();
    if (msg.ok) {
      const retire = job.pixels > RECYCLE_PIXELS ||
        (msg.result && msg.result.width * msg.result.height > RECYCLE_PIXELS);
      if (retire) this._retire(slot);
      job.resolve(msg.result);
    } else {
      // Recycle after an error: the Go runtime may be in a bad state (e.g. out of memory).
      this._retire(slot);
      job.reject(fromWorkerError(msg.error));
    }
    this._pump();
  }

  /** Terminates a slot's worker and removes it from the pool. */
  _retire(slot) {
    if (slot.dead) return;
    slot.dead = true;
    try { slot.worker && slot.worker.terminate(); } catch { /* ignore */ }
    const i = this._slots.indexOf(slot);
    if (i >= 0) this._slots.splice(i, 1);
    // A pending ready promise must not wait on a worker that is gone.
    if (this._readyResolve && !this._slots.some((s) => !s.dead)) this._spawn();
  }

  /** Worker died or failed to load: fail its job (or its pending load) and pump. */
  _killSlot(slot, err) {
    if (slot.dead) return;
    if (slot.initReject) {
      const reject = slot.initReject;
      slot.initResolve = slot.initReject = null;
      reject(err);
      this._settleReady(err);
    }
    this._retire(slot);
    const job = slot.job;
    slot.job = null;
    if (job) {
      job.cleanup();
      job.reject(err);
    }
    this._pump();
  }

  /** Pixels of the jobs running in workers now. */
  _runningPixels() {
    let n = 0;
    for (const s of this._slots) if (s.job && !s.dead) n += s.job.pixels || 0;
    return n;
  }

  /**
   * Index of the next queued job that fits the pixel budget: the head of the queue, or
   * when it does not fit, the first small job behind it. -1 when nothing may start.
   */
  _nextJob() {
    const running = this._runningPixels();
    const fits = (job) => running === 0 || running + (job.pixels || 0) <= this.pixelBudget;
    if (fits(this._queue[0])) return 0;
    for (let i = 1; i < this._queue.length; i++) {
      const job = this._queue[i];
      if ((job.pixels || 0) <= SMALL_JOB_PIXELS && fits(job)) return i;
    }
    return -1;
  }

  _pump() {
    while (this._queue.length) {
      let slot = this._slots.find((s) => !s.job && !s.dead);
      if (!slot && this._slots.length >= this.poolSize) return;
      const qi = this._nextJob();
      if (qi < 0) return;
      if (!slot) slot = this._spawn();
      const job = this._queue.splice(qi, 1)[0];
      this._start(slot, job);
    }
  }

  _start(slot, job) {
    slot.job = job;
    job.slot = slot;
    job.started = true;
    // If the worker is still loading, the message waits in its queue; a load failure
    // comes back as an error for this job.
    try {
      // The pixels are copied only now, so queued jobs do not each hold a full-size
      // copy (a batch of large photos would otherwise need gigabytes up front).
      const { message, transfer } = job.prepare();
      job.prepare = null;
      slot.worker.postMessage({ ...message, id: job.id }, transfer);
    } catch (err) {
      slot.job = null;
      job.cleanup();
      job.reject(err);
      this._retire(slot);
    }
  }

  /**
   * Queues a worker job. prepare() returns { message, transfer }; it is called when the
   * job starts. Returns a promise of the worker's result.
   */
  _run(prepare, { signal, onProgress, pixels }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }
      const id = nextId++;
      const job = {
        id,
        prepare,
        onProgress: typeof onProgress === 'function' ? onProgress : null,
        pixels,
        slot: null,
        started: false,
        resolve,
        reject,
        cleanup: () => {},
      };
      if (signal) {
        const onAbort = () => this._abort(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this._queue.push(job);
      this._pump();
    });
  }

  _abort(job) {
    job.cleanup();
    const qi = this._queue.indexOf(job);
    if (qi >= 0) {
      this._queue.splice(qi, 1);
      job.reject(abortError());
      return;
    }
    const slot = job.slot;
    if (slot && slot.job === job) {
      slot.job = null;
      this._retire(slot); // a running Go call cannot be interrupted
      job.reject(abortError());
      this._pump();
    }
  }

  // -- public API --

  /**
   * Decodes an image file into straight RGBA, honouring EXIF orientation.
   * Rejects with err.code 'TOO_BIG' (err.width, err.height) or 'UNSUPPORTED'.
   */
  async decode(file, { maxPixels } = {}) {
    const limit = maxPixels || this.limits.maxPixels;
    let src;
    try {
      src = await decodeSource(file);
    } catch (err) {
      throw codedError('UNSUPPORTED', 'This browser cannot open this image' + (file && file.type ? ` (${file.type})` : '') + '.', { cause: err });
    }
    try {
      const { width, height } = src;
      if (width * height > limit) {
        throw codedError('TOO_BIG', `The image is ${width} × ${height} (${(width * height / 1e6).toFixed(1)} MP); the limit is ${(limit / 1e6).toFixed(0)} MP.`, { width, height, maxPixels: limit });
      }
      let rgba;
      let canvas;
      try {
        canvas = makeCanvas(width, height);
        const ctx = context2d(canvas, true);
        ctx.drawImage(src.source, 0, 0);
        rgba = readPixels(ctx, width, height);
      } catch (err) {
        throw codedError('UNSUPPORTED', 'Could not read the pixels of this image (it may be too large for this device).', { cause: err });
      } finally {
        if (canvas) releaseCanvas(canvas);
      }
      return { rgba, width, height, type: (file && file.type) || '', name: (file && file.name) || 'image' };
    } finally {
      src.close();
    }
  }

  /**
   * High-quality downscale so that width*height <= maxPixels (aspect ratio kept).
   * Accepts an Img, or a File/Blob (decoded straight to the smaller size, so photos
   * over the decode limit can be shrunk without holding their full RGBA).
   */
  async downscale(img, maxPixels) {
    const limit = maxPixels || this.limits.maxPixels;
    if (typeof Blob !== 'undefined' && img instanceof Blob) {
      let src;
      try {
        src = await decodeSource(img);
      } catch (err) {
        throw codedError('UNSUPPORTED', 'This browser cannot open this image.', { cause: err });
      }
      try {
        const t = fitPixels(src.width, src.height, limit);
        const rgba = drawDownscaled(src.source, src.width, src.height, t.width, t.height);
        return { rgba, width: t.width, height: t.height, type: img.type || '', name: img.name || 'image' };
      } finally {
        src.close();
      }
    }
    checkImg(img);
    const t = fitPixels(img.width, img.height, limit);
    if (t.width === img.width && t.height === img.height) return img;
    const c = canvasOf(img);
    try {
      const rgba = drawDownscaled(c, img.width, img.height, t.width, t.height);
      return { rgba, width: t.width, height: t.height, type: img.type, name: img.name };
    } finally {
      releaseCanvas(c);
    }
  }

  /** Seam-carving resize to opts.width x opts.height. Returns a new Img. */
  async resize(img, opts = {}, { signal, onProgress } = {}) {
    checkImg(img);
    checkMask(opts.protect);
    checkMask(opts.remove);
    const { width: tw, height: th } = opts;
    const outPixels = (tw > 0 ? tw : img.width) * (th > 0 ? th : img.height);
    const r = await this._run(() => {
      const rgba = ownedCopy(img.rgba);
      const protect = ownedCopy(opts.protect);
      const remove = ownedCopy(opts.remove);
      const transfer = [rgba.buffer];
      if (protect) transfer.push(protect.buffer);
      if (remove) transfer.push(remove.buffer);
      return {
        message: {
          op: 'resize',
          rgba,
          width: img.width,
          height: img.height,
          opts: { width: tw, height: th, faces: !!opts.faces, blur: opts.blur, sobel: opts.sobel, protect, remove },
        },
        transfer,
      };
    }, { signal, onProgress, pixels: Math.max(img.width * img.height, outPixels) });
    return { rgba: asClamped(r.rgba), width: r.width, height: r.height, type: img.type, name: img.name };
  }

  /** Seam-order map; see livepreview.js renderOrder. */
  async seamOrder(img, { axis = 'x', maxSeams, faces, blur, sobel, protect, remove, signal, onProgress } = {}) {
    checkImg(img);
    checkMask(protect);
    checkMask(remove);
    const r = await this._run(() => {
      const rgba = ownedCopy(img.rgba);
      const p = ownedCopy(protect);
      const rm = ownedCopy(remove);
      const transfer = [rgba.buffer];
      if (p) transfer.push(p.buffer);
      if (rm) transfer.push(rm.buffer);
      return {
        message: {
          op: 'seamOrder',
          rgba,
          width: img.width,
          height: img.height,
          opts: { axis, maxSeams, faces: !!faces, blur, sobel, protect: p, remove: rm },
        },
        transfer,
      };
    }, { signal, onProgress, pixels: img.width * img.height });
    return { order: r.order, axis: r.axis, maxSeams: r.maxSeams, width: img.width, height: img.height };
  }

  /**
   * Encodes an Img. type: 'image/jpeg' | 'image/png' | 'image/webp'; quality 0..1.
   * Browsers that cannot write the type (e.g. WebP in Safari) give PNG: check blob.type.
   * JPEG has no alpha, so transparent pixels are put on white.
   */
  async encode(img, { type = 'image/png', quality } = {}) {
    checkImg(img);
    let c = canvasOf(img);
    try {
      if (type === 'image/jpeg' && hasAlpha(img.rgba)) {
        const flat = makeCanvas(img.width, img.height);
        const ctx = context2d(flat, false);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, img.width, img.height);
        ctx.drawImage(c, 0, 0);
        releaseCanvas(c);
        c = flat;
      }
      const blob = await toBlob(c, type, quality);
      if (!blob) throw new Error('Could not encode the image');
      return blob;
    } finally {
      releaseCanvas(c);
    }
  }
}

function hasAlpha(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

function toBlob(canvas, type, quality) {
  const q = typeof quality === 'number' ? Math.min(1, Math.max(0, quality)) : undefined;
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob(q === undefined ? { type } : { type, quality: q });
  }
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, q);
    } catch (err) {
      reject(err);
    }
  });
}

let instance = null;

/** The shared Engine (workers start lazily, on first use of ready or a job). */
export function getEngine() {
  if (!instance) instance = new Engine();
  return instance;
}

export { fitPixels };
