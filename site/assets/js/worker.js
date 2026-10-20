// Squishless engine worker (classic worker, started by engine.js).
//
// Loads /engine/wasm_exec.js (Go's runtime support plus cmd/wasm/glue.js) and
// /engine/squishless.wasm, which installs self.squishless. Then answers messages:
//
//   in:  { id, op: 'init' }                                   -> result { version }
//   in:  { id, op: 'resize', rgba, width, height, opts }      -> result { rgba, width, height }
//   in:  { id, op: 'seamOrder', rgba, width, height, opts }   -> result { order, axis, maxSeams, width, height }
//   out: { id, ok: true, result } | { id, ok: false, error: { name, message, code } }
//   out: { id, progress }   (0..1, at most ~20 per second, resize only)
//
// Result buffers are transferred back. One job runs at a time (the Go calls are
// synchronous); engine.js never sends a second job before the first answered.
'use strict';

const BUILD_ID = '__BUILD_ID__';
const WASM_URL = '/engine/squishless.wasm?v=' + BUILD_ID;
const EXEC_URL = '/engine/wasm_exec.js?v=' + BUILD_ID;
const PROGRESS_INTERVAL_MS = 50; // <= 20 messages per second

function loadError(message, cause) {
  const err = new Error(message);
  err.code = 'ENGINE_LOAD';
  if (cause) err.cause = cause;
  return err;
}

async function instantiate(importObject) {
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      return await WebAssembly.instantiateStreaming(fetch(WASM_URL), importObject);
    } catch (err) {
      // Usually a wrong Content-Type from a misconfigured server; fall through and
      // retry with a plain download. Real network failures fail again below.
    }
  }
  const res = await fetch(WASM_URL);
  if (!res.ok) throw loadError(`Could not download the engine (HTTP ${res.status}).`);
  const bytes = await res.arrayBuffer();
  return WebAssembly.instantiate(bytes, importObject);
}

async function load() {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
    throw loadError('This browser does not support WebAssembly, which Squishless needs. Please use a current version of Chrome, Edge, Firefox or Safari.');
  }
  try {
    importScripts(EXEC_URL);
  } catch (err) {
    throw loadError('Could not load the engine runtime (wasm_exec.js): ' + (err && err.message || err), err);
  }
  if (typeof self.Go !== 'function') throw loadError('The engine runtime did not define Go.');
  const go = new self.Go();
  let result;
  try {
    result = await instantiate(go.importObject);
  } catch (err) {
    if (err && err.code === 'ENGINE_LOAD') throw err;
    throw loadError('Could not load the engine: ' + (err && err.message || err), err);
  }
  // go.run resolves only when the Go program exits (never: main blocks in select{}).
  // self.squishless is installed synchronously while main() starts.
  go.run(result.instance).catch((err) => {
    self.squishless = undefined;
    console.error('squishless engine stopped:', err);
  });
  if (!self.squishless) throw loadError('The engine did not start.');
  return self.squishless.version;
}

const loading = load();
loading.catch(() => {}); // reported to each request below

function errorInfo(err) {
  if (err && typeof err === 'object') {
    return { name: err.name || 'Error', message: String(err.message || err), code: err.code || undefined };
  }
  return { name: 'Error', message: String(err), code: undefined };
}

function progressReporter(id) {
  let last = 0;
  let lastValue = -1;
  return (f) => {
    const now = Date.now();
    if (f >= 1 || now - last >= PROGRESS_INTERVAL_MS) {
      if (f === lastValue) return;
      last = now;
      lastValue = f;
      self.postMessage({ id, progress: f });
    }
  };
}

function maskOf(m) {
  return m == null ? null : m;
}

function engineOpts(opts) {
  const o = opts || {};
  return {
    width: o.width,
    height: o.height,
    faces: !!o.faces,
    blur: o.blur,
    sobel: o.sobel,
    axis: o.axis,
    maxSeams: o.maxSeams,
    protect: maskOf(o.protect),
    remove: maskOf(o.remove),
  };
}

function run(msg) {
  const sq = self.squishless;
  if (!sq) throw new Error('The engine is not running.');
  switch (msg.op) {
    case 'init':
      return { result: { version: sq.version }, transfer: [] };
    case 'resize': {
      const r = sq.resize(msg.rgba, msg.width, msg.height, engineOpts(msg.opts), progressReporter(msg.id));
      return { result: { rgba: r.rgba, width: r.width, height: r.height }, transfer: [r.rgba.buffer] };
    }
    case 'seamOrder': {
      const r = sq.seamOrder(msg.rgba, msg.width, msg.height, engineOpts(msg.opts));
      return {
        result: { order: r.order, axis: r.axis, maxSeams: r.maxSeams, width: msg.width, height: msg.height },
        transfer: [r.order.buffer],
      };
    }
    default:
      throw new Error('Unknown operation: ' + msg.op);
  }
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const id = msg.id;
  try {
    await loading;
  } catch (err) {
    self.postMessage({ id, ok: false, error: errorInfo(err) });
    return;
  }
  let out;
  try {
    out = run(msg);
  } catch (err) {
    self.postMessage({ id, ok: false, error: errorInfo(err) });
    return;
  }
  self.postMessage({ id, ok: true, result: out.result }, out.transfer);
};
