#!/usr/bin/env node
// Smoke test of the built engine (run after scripts/build-site.sh):
//   node scripts/wasm-smoke.mjs [distDir]
// Loads dist/engine/wasm_exec.js + dist/engine/squishless.wasm the way the worker does,
// then checks squishless.resize / squishless.seamOrder on synthetic images: sizes,
// progress, the seam-order invariant (keep order >= k == resize to size-k), errors
// thrown as Error with the runtime still usable afterwards, and prints timings.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.argv[2] || path.join(root, 'dist'));
const engineDir = path.join(dist, 'engine');

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}
function throws(fn, re, msg) {
  try {
    fn();
  } catch (e) {
    check(e instanceof Error && re.test(e.message), `${msg} (threw: ${e && e.message})`);
    return;
  }
  check(false, `${msg} (did not throw)`);
}
const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;

// --- load the engine like worker.js does (classic script + instantiate) ---
// wasm_exec.js polyfills fs/process when they are missing; Node 22 has crypto,
// performance and TextEncoder/TextDecoder globally. Go's stdout/stderr go to console.
const t0 = performance.now();
vm.runInThisContext(fs.readFileSync(path.join(engineDir, 'wasm_exec.js'), 'utf8'), {
  filename: 'wasm_exec.js',
});
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(
  fs.readFileSync(path.join(engineDir, 'squishless.wasm')),
  go.importObject,
);
const exited = go.run(instance); // main() registers the API synchronously, then blocks
const sq = globalThis.squishless;
console.log(`engine loaded in ${ms(t0)}`);
if (!sq) {
  console.error('FAIL: globalThis.squishless was not defined');
  process.exit(1);
}
console.log(`version: ${sq.version}`);
check(typeof sq.version === 'string' && sq.version.length > 0, 'version is a string');

// --- synthetic image: gradient + deterministic noise + a few blocks ---
function makeImage(w, h, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      const base = ((x / w) * 255 + (y / h) * 255) / 2;
      const block = ((x >> 4) + (y >> 4)) % 5 === 0 ? 80 : 0;
      px[i] = Math.max(0, Math.min(255, base + (rnd() - 0.5) * 50 + block));
      px[i + 1] = 255 - px[i];
      px[i + 2] = Math.floor(rnd() * 256);
      px[i + 3] = 255;
    }
  }
  return px;
}

// keep pixels with order >= k (per row for 'x', per column for 'y')
function applyOrder(px, w, h, order, axis, k) {
  if (axis === 'x') {
    const ow = w - k;
    const out = new Uint8Array(ow * h * 4);
    let o = 0;
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) {
        if (order[y * w + x] >= k) {
          out.set(px.subarray(4 * (y * w + x), 4 * (y * w + x) + 4), o);
          o += 4;
          n++;
        }
      }
      if (n !== ow) return null;
    }
    return { rgba: out, width: ow, height: h };
  }
  const oh = h - k;
  const out = new Uint8Array(w * oh * 4);
  for (let x = 0; x < w; x++) {
    let j = 0;
    for (let y = 0; y < h; y++) {
      if (order[y * w + x] >= k) {
        if (j >= oh) return null;
        out.set(px.subarray(4 * (y * w + x), 4 * (y * w + x) + 4), 4 * (j * w + x));
        j++;
      }
    }
    if (j !== oh) return null;
  }
  return { rgba: out, width: w, height: oh };
}

const sameBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function invariant(px, w, h, opts, axis, maxSeams, ks) {
  const r = sq.seamOrder(px, w, h, { ...opts, axis, maxSeams });
  check(r.order instanceof Uint16Array && r.order.length === w * h, `seamOrder ${axis}: Uint16Array(${w * h})`);
  check(r.axis === axis, `seamOrder ${axis}: axis echoed`);
  const size = axis === 'x' ? w : h;
  const n = Math.min(maxSeams, size - 1);
  check(r.maxSeams === n, `seamOrder ${axis}: maxSeams clamped to ${n} (got ${r.maxSeams})`);
  let never = 0;
  for (const v of r.order) if (v === 65535) never++;
  check(never === (axis === 'x' ? h : w) * (size - n), `seamOrder ${axis}: never-removed count`);
  for (const k of ks) {
    const got = applyOrder(px, w, h, r.order, axis, k);
    const want = sq.resize(px, w, h, { ...opts, width: axis === 'x' ? w - k : 0, height: axis === 'y' ? h - k : 0 }, null);
    check(
      got !== null && got.width === want.width && got.height === want.height && sameBytes(got.rgba, want.rgba),
      `invariant ${axis} k=${k} ${JSON.stringify(Object.keys(opts))}: order map == resize`,
    );
  }
}

console.log('\nresize');
{
  const w = 160, h = 100;
  const px = makeImage(w, h, 7);
  const copy = px.slice();
  const prog = [];
  const r = sq.resize(px, w, h, { width: 120, height: 0, faces: false, blur: 2, sobel: 0 }, (f) => prog.push(f));
  check(r.width === 120 && r.height === 100, `shrink to 120x100 (got ${r.width}x${r.height})`);
  check(r.rgba instanceof Uint8Array && r.rgba.length === 120 * 100 * 4, 'rgba is a Uint8Array of the right length');
  check(prog.length > 1 && prog[prog.length - 1] === 1 && prog.every((v, i) => i === 0 || v >= prog[i - 1]), `progress non-decreasing, ends at 1 (${prog.length} calls)`);
  check(sameBytes(px, copy), 'input buffer not modified');
  const e = sq.resize(px, w, h, { width: 200, height: 130 }, undefined);
  check(e.width === 200 && e.height === 130 && e.rgba.length === 200 * 130 * 4, 'enlarge both to 200x130');
  const both = sq.resize(new Uint8ClampedArray(px), w, h, { width: 90, height: 70, faces: true }, null);
  check(both.width === 90 && both.height === 70, 'shrink both from a Uint8ClampedArray, faces on');
  const noOpts = sq.resize(px, w, h, { height: 50 });
  check(noOpts.width === 160 && noOpts.height === 50, 'height only, onProgress omitted');
}

console.log('\nseamOrder invariant');
{
  const w = 96, h = 64;
  const px = makeImage(w, h, 3);
  invariant(px, w, h, {}, 'x', 40, [0, 1, 7, 40]);
  invariant(px, w, h, { blur: 0, sobel: 10 }, 'x', 30, [3, 30]);
  invariant(px, w, h, { blur: 5 }, 'y', 30, [1, 12, 30]);
  const protect = new Uint8Array(w * h);
  const remove = new Uint8Array(w * h);
  for (let y = 10; y < 40; y++) for (let x = 10; x < 30; x++) protect[y * w + x] = 255;
  for (let y = 20; y < 50; y++) for (let x = 60; x < 70; x++) remove[y * w + x] = 200;
  invariant(px, w, h, { protect, remove }, 'x', 50, [5, 25, 50]);
  invariant(px, w, h, { protect, remove, faces: true }, 'y', 20, [5, 20]);
  invariant(px, w, h, {}, 'x', 1e9, [95]); // clamp to w-1
  const none = sq.seamOrder(px, w, h, { axis: 'y', maxSeams: -5 });
  check(none.maxSeams === 0 && none.order.every((v) => v === 65535), 'maxSeams < 0 -> nothing removed');
  const one = sq.seamOrder(new Uint8Array([1, 2, 3, 255]), 1, 1, { axis: 'x', maxSeams: 10 });
  check(one.maxSeams === 0 && one.order[0] === 65535, '1x1 image');
}

console.log('\nerrors (each followed by a working call)');
{
  const w = 40, h = 30;
  const px = makeImage(w, h, 5);
  const works = (label) => {
    const r = sq.resize(px, w, h, { width: 30 }, null);
    check(r.width === 30 && r.height === 30, `  next call works after ${label}`);
  };
  throws(() => sq.resize(px.subarray(4), w, h, { width: 30 }, null), /bytes/, 'wrong buffer length throws');
  works('length error');
  throws(() => sq.resize(px, w, h, { width: 0, height: 0 }, null), /zero/, 'zero target throws');
  works('target error');
  throws(() => sq.resize(px, w, h, { width: 1000 }, null), /exceeds/, 'too-large target throws');
  throws(() => sq.resize([1, 2, 3], 1, 1, { width: 1 }, null), /Uint8Array/, 'non-typed-array rgba throws');
  throws(() => sq.resize(px, 'a', h, { width: 1 }, null), /width/, 'non-number width throws');
  throws(() => sq.resize(px, w, h, { width: 30, protect: new Uint8Array(5) }, null), /protect/, 'wrong-size mask throws');
  throws(() => sq.seamOrder(px, w, h, { axis: 'z' }), /axis/, 'bad axis throws');
  throws(() => sq.resize(px, w, h, { width: 30 }, 42), /onProgress/, 'non-function onProgress throws');
  throws(
    () => sq.resize(px, w, h, { width: 20 }, () => { throw new Error('boom from progress'); }),
    /boom from progress/,
    'exception in onProgress becomes a thrown Error (recovered panic)',
  );
  works('progress exception');
  const r = sq.seamOrder(px, w, h, { axis: 'y', maxSeams: 5 });
  check(r.order.length === w * h, '  seamOrder still works');
}

console.log('\ntimings (single thread, synthetic 1000x650)');
{
  const w = 1000, h = 650;
  const px = makeImage(w, h, 11);
  let t = performance.now();
  const so = sq.seamOrder(px, w, h, { axis: 'x', maxSeams: 500 });
  console.log(`  seamOrder x, 500 seams: ${ms(t)}`);
  t = performance.now();
  sq.seamOrder(px, w, h, { axis: 'y', maxSeams: 325, faces: true });
  console.log(`  seamOrder y, 325 seams, faces: ${ms(t)}`);
  t = performance.now();
  const r = sq.resize(px, w, h, { width: 700 }, null);
  console.log(`  resize to 700x650: ${ms(t)}`);
  t = performance.now();
  sq.resize(px, w, h, { width: 1300, height: 650, faces: true }, null);
  console.log(`  resize to 1300x650 (enlarge), faces: ${ms(t)}`);
  const got = applyOrder(px, w, h, so.order, 'x', 300);
  check(got && got.width === 700 && sameBytes(got.rgba, r.rgba), 'invariant at full size, k=300');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
// The Go program blocks in select{} forever; exit explicitly.
void exited;
process.exit(failures ? 1 : 0);
