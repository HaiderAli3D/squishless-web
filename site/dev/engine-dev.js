// Engine harness (dev only): exposes the browser engine on window.squishlessDev for the
// Playwright tests, and runs a small demo (load a sample, resize, seam order, live slider).
import { getEngine } from '/assets/js/engine.js';
import { renderOrder, renderNaive, orderSeams } from '/assets/js/livepreview.js';
import { buildZip, crc32, uniqueNames } from '/assets/js/zip.js';
import { stashFiles, takeFiles } from '/assets/js/handoff.js';

const engine = getEngine();

// ---- helpers for tests ----

async function fetchBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const blob = await res.blob();
  const name = url.split('/').pop().split('?')[0];
  return new File([blob], name, { type: blob.type || 'image/jpeg' });
}

async function fetchImg(url, opts) {
  return engine.decode(await fetchBlob(url), opts);
}

function fileFromBase64(b64, type, name) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'file', { type: type || '' });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Number of pixels whose RGBA differs by more than tol in any channel. */
function diffPixels(a, b, tol = 0) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol ||
        Math.abs(a[i + 2] - b[i + 2]) > tol || Math.abs(a[i + 3] - b[i + 3]) > tol) n++;
  }
  return n;
}

/** Copies a w x h region of img (straight RGBA) starting at (x, y). */
function crop(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.width + x) * 4;
    out.set(img.rgba.subarray(s, s + w * 4), r * w * 4);
  }
  return { rgba: out, width: w, height: h, type: img.type, name: img.name };
}

window.squishlessDev = {
  engine, getEngine, renderOrder, renderNaive, orderSeams, buildZip, crc32, uniqueNames,
  stashFiles, takeFiles, fetchBlob, fetchImg, fileFromBase64, blobToBase64, diffPixels, crop,
};

// ---- demo ----

const $ = (id) => document.getElementById(id);
const ui = {
  sample: $('sample'), axis: $('axis'), faces: $('faces'), load: $('load'), resize: $('resize'),
  order: $('order'), cancel: $('cancel'), status: $('status'), progress: $('progress'),
  slider: $('slider'), sliderOut: $('sliderOut'), live: $('live'), naive: $('naive'), result: $('result'),
};
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
const state = { img: null, map: null, frame: null, naiveFrame: null, ctrl: null, raf: 0 };

function setStatus(text) {
  ui.status.textContent = text;
}

function draw(canvas, imageData) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
}

function imgToImageData(img) {
  return new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height);
}

async function job(label, fn) {
  if (state.ctrl) state.ctrl.abort();
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  ui.progress.value = 0;
  setStatus(label + '…');
  const t0 = performance.now();
  try {
    const r = await fn(ctrl.signal);
    setStatus(`${label}: done in ${((performance.now() - t0) / 1000).toFixed(2)} s (engine ${engine.version || '?'}).`);
    return r;
  } catch (err) {
    setStatus(`${label}: ${err.name === 'AbortError' ? 'cancelled' : err.message}`);
    return null;
  } finally {
    if (state.ctrl === ctrl) state.ctrl = null;
  }
}

async function loadSample() {
  state.map = null;
  ui.slider.disabled = true;
  const img = await job('Loading ' + radio('sample'), () => fetchImg(radio('sample')));
  if (!img) return;
  state.img = img;
  draw(ui.live, imgToImageData(img));
  draw(ui.naive, imgToImageData(img));
  ui.result.width = ui.result.height = 0;
}

function renderSlider() {
  state.raf = 0;
  const { img, map } = state;
  if (!img || !map) return;
  const k = Number(ui.slider.value);
  const t0 = performance.now();
  state.frame = renderOrder(img.rgba, img.width, img.height, map.order, map.axis, k, state.frame);
  const ms = performance.now() - t0;
  draw(ui.live, state.frame);
  state.naiveFrame = renderNaive(img.rgba, img.width, img.height, state.frame.width, state.frame.height, state.naiveFrame);
  draw(ui.naive, state.naiveFrame);
  ui.sliderOut.textContent = `${k} → ${state.frame.width} × ${state.frame.height} (${ms.toFixed(1)} ms)`;
}

ui.load.addEventListener('click', loadSample);
ui.sample.addEventListener('change', loadSample);

ui.resize.addEventListener('click', async () => {
  if (!state.img) await loadSample();
  const img = state.img;
  if (!img) return;
  const y = radio('axis') === 'y';
  const opts = {
    width: y ? img.width : Math.max(1, img.width - 350),
    height: y ? Math.max(1, img.height - 350) : img.height,
    faces: ui.faces.checked,
  };
  const out = await job('Resize', (signal) => engine.resize(img, opts, {
    signal, onProgress: (f) => { ui.progress.value = f; },
  }));
  if (out) draw(ui.result, imgToImageData(out));
});

ui.order.addEventListener('click', async () => {
  if (!state.img) await loadSample();
  const img = state.img;
  if (!img) return;
  const axis = radio('axis');
  const size = axis === 'y' ? img.height : img.width;
  const map = await job('Seam order', (signal) => engine.seamOrder(img, {
    axis, maxSeams: Math.floor(size * 0.6), faces: ui.faces.checked, signal,
  }));
  if (!map) return;
  state.map = map;
  state.frame = null;
  ui.slider.min = String(-map.maxSeams);
  ui.slider.max = String(map.maxSeams);
  ui.slider.value = '0';
  ui.slider.disabled = false;
  renderSlider();
});

ui.slider.addEventListener('input', () => {
  if (!state.raf) state.raf = requestAnimationFrame(renderSlider);
});

ui.cancel.addEventListener('click', () => {
  if (state.ctrl) state.ctrl.abort();
});

window.squishlessDevReady = true;
document.documentElement.dataset.ready = 'true';
