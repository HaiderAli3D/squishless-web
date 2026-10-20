// Browser engine tests (engine.js, worker.js, livepreview.js, handoff.js, zip.js), driven
// through the dev harness at /dev/engine (site/dev/engine.html), which exposes
// window.squishlessDev. Timings: SQUISHLESS_PERF=1 npx playwright test engine --project chromium
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.resolve(here, '../fixtures', name)).toString('base64');

// Seam carving is CPU heavy and the mobile/webkit projects are slower.
test.setTimeout(120_000);

async function openHarness(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto('/dev/engine');
  await page.waitForFunction(() => window.squishlessDevReady === true);
  return errors;
}

/** Defines window.small(): a ~200 x 134 copy of sample.jpg (cached). */
async function defineSmall(page) {
  await page.evaluate(async () => {
    const D = window.squishlessDev;
    if (!window.small) {
      const full = await D.fetchImg('/samples/sample.jpg');
      window.small = await D.engine.downscale(full, 200 * 134);
    }
  });
}

test.describe('browser engine', () => {
  test('engine loads the wasm and reports version, pool size and limits', async ({ page }) => {
    const errors = await openHarness(page);
    const info = await page.evaluate(async () => {
      const e = window.squishlessDev.engine;
      const before = e.workerCount;
      await e.ready;
      return { before, after: e.workerCount, version: e.version, poolSize: e.poolSize, limits: e.limits, isPhone: e.isPhone };
    });
    expect(info.before).toBe(0); // lazy
    expect(info.after).toBe(1);
    expect(info.version).toMatch(/^1\.0\.0/);
    expect(info.poolSize).toBeGreaterThanOrEqual(1);
    expect(info.poolSize).toBeLessThanOrEqual(3);
    if (info.isPhone) {
      expect(info.poolSize).toBe(2);
      expect(info.limits.maxPixels).toBe(12e6);
    } else {
      expect(info.limits.maxPixels).toBe(24e6);
    }
    expect(errors).toEqual([]);
  });

  test('engine load failure is reported clearly and can be retried', async ({ page }) => {
    await openHarness(page);
    await page.route('**/engine/squishless.wasm*', (route) => route.fulfill({ status: 404, body: 'nope' }));
    const failed = await page.evaluate(async () => {
      const e = window.squishlessDev.engine;
      const r = {};
      r.ready = await e.ready.then(() => 'resolved', (err) => ({ code: err.code, message: err.message }));
      r.job = await e.resize({ rgba: new Uint8ClampedArray(16), width: 2, height: 2 }, { width: 1 })
        .then(() => 'resolved', (err) => ({ code: err.code, message: err.message }));
      return r;
    });
    // Some browsers do not route a worker's requests through page.route; then it just loads.
    test.skip(failed.ready === 'resolved', 'worker requests are not intercepted in this browser');
    expect(failed.ready.code).toBe('ENGINE_LOAD');
    expect(failed.ready.message).toMatch(/engine/i);
    expect(failed.job.code).toBe('ENGINE_LOAD');
    await page.unroute('**/engine/squishless.wasm*');
    const ok = await page.evaluate(async () => {
      const e = window.squishlessDev.engine;
      await e.ready;
      const out = await e.resize({ rgba: new Uint8ClampedArray(16).fill(200), width: 2, height: 2 }, { width: 1 });
      return [out.width, out.height, e.version != null];
    });
    expect(ok).toEqual([1, 2, true]);
  });

  test('decode: sample JPEG gives straight RGBA with name and type', async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const img = await window.squishlessDev.fetchImg('/samples/sample.jpg');
      let opaque = true;
      for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] !== 255) { opaque = false; break; }
      return {
        w: img.width, h: img.height, len: img.rgba.length, clamped: img.rgba instanceof Uint8ClampedArray,
        type: img.type, name: img.name, opaque,
      };
    });
    expect(r).toEqual({ w: 670, h: 447, len: 670 * 447 * 4, clamped: true, type: 'image/jpeg', name: 'sample.jpg', opaque: true });
  });

  test('decode honours EXIF orientation (6 and 3)', async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async ({ o6, o3 }) => {
      const D = window.squishlessDev;
      const ref = await D.fetchImg('/samples/sample.jpg');
      const a = await D.engine.decode(D.fileFromBase64(o6, 'image/jpeg', 'o6.jpg'));
      const b = await D.engine.decode(D.fileFromBase64(o3, 'image/jpeg', 'o3.jpg'));
      const W = ref.width;
      const H = ref.height;
      // Orientation 6 = rotate 90° clockwise: shown (x, y) = stored (y, H-1-x).
      const rot6 = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < H; x++) {
          const s = (((H - 1 - x) * W) + y) * 4;
          rot6.set(ref.rgba.subarray(s, s + 4), (y * H + x) * 4);
        }
      }
      // Orientation 3 = rotate 180°.
      const rot3 = new Uint8ClampedArray(W * H * 4);
      for (let i = 0, n = W * H; i < n; i++) rot3.set(ref.rgba.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4);
      return {
        a: [a.width, a.height], b: [b.width, b.height],
        diff6: D.diffPixels(a.rgba, rot6, 24) / (W * H),
        diff3: D.diffPixels(b.rgba, rot3, 24) / (W * H),
        // Sanity: the unrotated image must NOT match the rotated reference.
        diffNone: D.diffPixels(ref.rgba, rot3, 24) / (W * H),
      };
    }, { o6: fixture('sample-orient6.jpg'), o3: fixture('sample-orient3.jpg') });
    expect(r.a).toEqual([447, 670]);
    expect(r.b).toEqual([670, 447]);
    expect(r.diff6).toBeLessThan(0.01);
    expect(r.diff3).toBeLessThan(0.01);
    expect(r.diffNone).toBeGreaterThan(0.2);
  });

  test('decode: TOO_BIG before allocating, UNSUPPORTED for garbage, downscale from a file', async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const file = await D.fetchBlob('/samples/sample.jpg');
      const out = {};
      try {
        await D.engine.decode(file, { maxPixels: 100_000 });
        out.big = 'resolved';
      } catch (err) {
        out.big = { code: err.code, width: err.width, height: err.height, message: err.message };
      }
      try {
        await D.engine.decode(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'x.png', { type: 'image/png' }));
        out.bad = 'resolved';
      } catch (err) {
        out.bad = { code: err.code };
      }
      const small = await D.engine.downscale(file, 100_000);
      out.small = { w: small.width, h: small.height, len: small.rgba.length };
      const img = await D.engine.decode(file);
      const same = await D.engine.downscale(img, 1e9);
      out.same = same === img;
      const half = await D.engine.downscale(img, 335 * 223);
      out.half = { w: half.width, h: half.height, mean: half.rgba.reduce((s, v) => s + v, 0) / half.rgba.length };
      out.fullMean = img.rgba.reduce((s, v) => s + v, 0) / img.rgba.length;
      return out;
    });
    expect(r.big.code).toBe('TOO_BIG');
    expect(r.big.width).toBe(670);
    expect(r.big.height).toBe(447);
    expect(r.bad.code).toBe('UNSUPPORTED');
    expect(r.small.w * r.small.h).toBeLessThanOrEqual(100_000);
    expect(r.small.w * r.small.h).toBeGreaterThan(98_000);
    expect(Math.abs(r.small.w / r.small.h - 670 / 447)).toBeLessThan(0.02);
    expect(r.small.len).toBe(r.small.w * r.small.h * 4);
    expect(r.same).toBe(true);
    expect(r.half.w * r.half.h).toBeLessThanOrEqual(335 * 223);
    expect(Math.abs(r.half.mean - r.fullMean)).toBeLessThan(3); // brightness preserved
  });

  test('resize: shrink, enlarge, both axes; progress events; caller Img stays valid', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const img = window.small;
      const before = img.rgba.slice();
      const progress = [];
      const shrink = await D.engine.resize(img, { width: img.width - 50 }, { onProgress: (f) => progress.push(f) });
      const enlarge = await D.engine.resize(img, { width: img.width + 60 });
      const both = await D.engine.resize(img, { width: img.width - 30, height: img.height + 20 });
      const tall = await D.engine.resize(img, { height: img.height - 40 });
      return {
        src: [img.width, img.height],
        shrink: [shrink.width, shrink.height, shrink.rgba.length, shrink.rgba instanceof Uint8ClampedArray],
        enlarge: [enlarge.width, enlarge.height, enlarge.rgba.length],
        both: [both.width, both.height, both.rgba.length],
        tall: [tall.width, tall.height],
        meta: [shrink.type, shrink.name],
        intact: img.rgba.length === before.length && D.diffPixels(img.rgba, before) === 0,
        progress: { n: progress.length, last: progress[progress.length - 1], sorted: progress.every((v, i) => i === 0 || v >= progress[i - 1]) },
      };
    });
    const [w, h] = r.src;
    expect(r.shrink).toEqual([w - 50, h, (w - 50) * h * 4, true]);
    expect(r.enlarge).toEqual([w + 60, h, (w + 60) * h * 4]);
    expect(r.both).toEqual([w - 30, h + 20, (w - 30) * (h + 20) * 4]);
    expect(r.tall).toEqual([w, h - 40]);
    expect(r.meta).toEqual(['image/jpeg', 'sample.jpg']);
    expect(r.intact).toBe(true);
    expect(r.progress.n).toBeGreaterThan(0);
    expect(r.progress.sorted).toBe(true);
    expect(r.progress.last).toBeLessThanOrEqual(1);
  });

  test('masks: protected area survives untouched, remove mask changes the result', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const img = window.small;
      const { width: w, height: h } = img;
      const keepW = Math.floor(w / 3);
      const protect = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) protect.fill(255, y * w, y * w + keepW);
      const remove = new Uint8Array(w * h);
      const rx = Math.floor(w / 2);
      for (let y = 0; y < h; y++) remove.fill(255, y * w + rx, y * w + rx + 30);
      const k = 40;
      const plain = await D.engine.resize(img, { width: w - k });
      const prot = await D.engine.resize(img, { width: w - k, protect });
      const rem = await D.engine.resize(img, { width: w - k, remove });
      const leftSrc = D.crop(img, 0, 0, keepW, h);
      return {
        protKept: D.diffPixels(D.crop(prot, 0, 0, keepW, h).rgba, leftSrc.rgba),
        plainKept: D.diffPixels(D.crop(plain, 0, 0, keepW, h).rgba, leftSrc.rgba),
        remDiff: D.diffPixels(rem.rgba, plain.rgba),
        sizes: [prot.width, rem.width],
        maskIntact: protect[0] === 255 && protect.length === w * h,
      };
    });
    expect(r.sizes).toEqual([r.sizes[0], r.sizes[0]]);
    expect(r.protKept).toBe(0); // no seam passed through the protected third
    expect(r.plainKept).toBeGreaterThan(0); // without the mask, seams did go there
    expect(r.remDiff).toBeGreaterThan(0);
    expect(r.maskIntact).toBe(true); // masks are copied, not detached
  });

  test('seamOrder + renderOrder equals resize on both axes', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const img = window.small;
      const out = [];
      for (const [axis, ks, faces] of [['x', [1, 17, 60], false], ['y', [1, 23, 50], false], ['x', [9], true]]) {
        const size = axis === 'x' ? img.width : img.height;
        const map = await D.engine.seamOrder(img, { axis, maxSeams: Math.floor(size * 0.6), faces });
        let frame;
        for (const k of ks) {
          frame = D.renderOrder(img.rgba, img.width, img.height, map.order, map.axis, k, frame);
          const opts = axis === 'x' ? { width: img.width - k, faces } : { height: img.height - k, faces };
          const exact = await D.engine.resize(img, opts);
          out.push({
            axis, k, faces,
            sizeOk: frame.width === exact.width && frame.height === exact.height,
            diff: D.diffPixels(frame.data, exact.rgba),
          });
        }
        out.push({ axis, meta: [map.axis, map.maxSeams, map.width, map.height, map.order.length, map.order instanceof Uint16Array] });
      }
      return { out, w: img.width, h: img.height };
    });
    for (const o of r.out) {
      if (o.meta) {
        const size = o.axis === 'x' ? r.w : r.h;
        expect(o.meta).toEqual([o.axis, Math.floor(size * 0.6), r.w, r.h, r.w * r.h, true]);
      } else {
        expect(o.sizeOk, `${o.axis} k=${o.k}`).toBe(true);
        expect(o.diff, `${o.axis} k=${o.k} faces=${o.faces}`).toBe(0);
      }
    }
  });

  test('renderOrder: enlarge preview, clamping, k=0, out reuse; renderNaive sizes', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const img = window.small;
      const { width: w, height: h } = img;
      const mx = await D.engine.seamOrder(img, { axis: 'x', maxSeams: 30 });
      const my = await D.engine.seamOrder(img, { axis: 'y', maxSeams: 20 });
      const copy = D.renderOrder(img.rgba, w, h, mx.order, 'x', 0);
      const ex = D.renderOrder(img.rgba, w, h, mx.order, 'x', -25);
      const ey = D.renderOrder(img.rgba, w, h, my.order, 'y', -12);
      const clampHi = D.renderOrder(img.rgba, w, h, mx.order, 'x', 500);
      const clampLo = D.renderOrder(img.rgba, w, h, my.order, 'y', -500);
      const a = D.renderOrder(img.rgba, w, h, mx.order, 'x', 10);
      const b = D.renderOrder(img.rgba, w, h, mx.order, 'x', 10, a);
      const c = D.renderOrder(img.rgba, w, h, mx.order, 'x', 11, a);
      // Enlarging keeps every source pixel: dropping the duplicates gives the source back.
      let dupOk = true;
      {
        const o32 = new Uint32Array(ex.data.buffer);
        const s32 = new Uint32Array(img.rgba.buffer, img.rgba.byteOffset, w * h);
        let o = 0;
        for (let i = 0; i < w * h && dupOk; i++) {
          if (o32[o++] !== s32[i]) dupOk = false;
          if (mx.order[i] < 25 && o32[o++] !== s32[i]) dupOk = false;
        }
      }
      const naive = D.renderNaive(img.rgba, w, h, w - 50, h + 10);
      const naiveSame = D.renderNaive(img.rgba, w, h, w, h);
      // Timing of a full-frame render on the small image, for information.
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) D.renderOrder(img.rgba, w, h, mx.order, 'x', i, a.width === w - i ? a : undefined);
      const ms = (performance.now() - t0) / 20;
      return {
        w, h,
        copy: [copy.width, copy.height, D.diffPixels(copy.data, img.rgba)],
        ex: [ex.width, ex.height], ey: [ey.width, ey.height],
        clampHi: [clampHi.width, clampHi.height], clampLo: [clampLo.width, clampLo.height],
        reuse: b === a, noReuse: c !== a,
        dupOk,
        naive: [naive.width, naive.height],
        naiveSameDiff: D.diffPixels(naiveSame.data, img.rgba),
        ms,
      };
    });
    expect(r.copy).toEqual([r.w, r.h, 0]);
    expect(r.ex).toEqual([r.w + 25, r.h]);
    expect(r.ey).toEqual([r.w, r.h + 12]);
    expect(r.clampHi).toEqual([r.w - 30, r.h]);
    expect(r.clampLo).toEqual([r.w, r.h + 20]);
    expect(r.reuse).toBe(true);
    expect(r.noReuse).toBe(true);
    expect(r.dupOk).toBe(true);
    expect(r.naive).toEqual([r.w - 50, r.h + 10]);
    expect(r.naiveSameDiff).toBe(0);
  });

  test('abort: running and queued jobs reject with AbortError, then new jobs work', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const e = D.engine;
      await e.ready;
      const big = await D.fetchImg('/samples/sample.jpg');
      const out = {};

      // Pre-aborted signal.
      const pre = new AbortController();
      pre.abort();
      out.pre = await e.resize(window.small, { width: 100 }, { signal: pre.signal }).then(() => 'resolved', (err) => err.name);

      // Abort a running job.
      const ctrl = new AbortController();
      const t0 = performance.now();
      const p = e.seamOrder(big, { axis: 'x', maxSeams: 600, signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 300);
      out.running = await p.then(() => 'resolved', (err) => err.name);
      out.abortMs = performance.now() - t0;

      // Fill the pool, queue one more, abort the queued one.
      const jobs = [];
      for (let i = 0; i < e.poolSize; i++) jobs.push(e.resize(window.small, { width: window.small.width - 20 - i }));
      const qc = new AbortController();
      const queued = e.resize(window.small, { width: 120 }, { signal: qc.signal });
      qc.abort();
      out.queued = await queued.then(() => 'resolved', (err) => err.name);
      const done = await Promise.all(jobs);
      out.poolWidths = done.map((d) => d.width);
      out.workers = e.workerCount;

      // A fresh job after the aborts.
      const after = await e.resize(window.small, { width: 150 });
      out.after = [after.width, after.height];
      return out;
    });
    expect(r.pre).toBe('AbortError');
    expect(r.running).toBe('AbortError');
    expect(r.abortMs).toBeLessThan(2000);
    expect(r.queued).toBe('AbortError');
    expect(r.poolWidths.length).toBeGreaterThan(0);
    r.poolWidths.forEach((w, i) => expect(w).toBe(r.poolWidths[0] - i));
    expect(r.after[0]).toBe(150);
  });

  test('parallel jobs use several workers and all finish correctly', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const e = D.engine;
      const img = window.small;
      let maxWorkers = 0;
      const timer = setInterval(() => { maxWorkers = Math.max(maxWorkers, e.workerCount); }, 5);
      const widths = [img.width - 10, img.width - 25, img.width + 15, img.width - 40, img.width - 5, img.width + 30];
      const results = await Promise.all([
        ...widths.map((w) => e.resize(img, { width: w })),
        e.seamOrder(img, { axis: 'y', maxSeams: 30 }),
      ]);
      clearInterval(timer);
      maxWorkers = Math.max(maxWorkers, e.workerCount);
      const seq = await e.resize(img, { width: widths[1] });
      return {
        widths,
        got: results.slice(0, widths.length).map((x) => x.width),
        order: results[widths.length].order.length,
        maxWorkers,
        poolSize: e.poolSize,
        sameAsSequential: D.diffPixels(results[1].rgba, seq.rgba),
        n: img.width * img.height,
      };
    });
    expect(r.got).toEqual(r.widths);
    expect(r.order).toBe(r.n);
    expect(r.maxWorkers).toBeLessThanOrEqual(r.poolSize);
    expect(r.maxWorkers).toBe(Math.min(r.poolSize, 7));
    expect(r.sameAsSequential).toBe(0);
  });

  test('queued jobs copy pixels only when they start, and running pixels stay within the budget', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const e = D.engine;
      await e.ready;
      const img = window.small; // ~26,800 px
      const n = img.width * img.height;
      const savedBudget = e.pixelBudget;
      e.pixelBudget = n * 2.5; // at most two of these at once
      // Count the full-size copies made (one per started job), spying on the buffers
      // that get transferred to workers.
      let copies = 0;
      let maxRunning = 0;
      let maxCopiesAhead = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, transfer) {
        if (msg && msg.rgba && msg.rgba.length === n * 4) copies++;
        return post.call(this, msg, transfer);
      };
      const timer = setInterval(() => {
        maxRunning = Math.max(maxRunning, e._runningPixels());
      }, 2);
      try {
        const jobs = [];
        for (let i = 0; i < 6; i++) jobs.push(e.resize(img, { width: img.width - 10 - i }));
        // Right after queueing, only the jobs that could start have been copied.
        maxCopiesAhead = copies;
        const out = await Promise.all(jobs);
        return {
          widths: out.map((o) => o.width), want: jobs.map((_, i) => img.width - 10 - i),
          copies, maxCopiesAhead, maxRunning, budget: e.pixelBudget, n, poolSize: e.poolSize,
          defaultBudget: savedBudget,
        };
      } finally {
        clearInterval(timer);
        Worker.prototype.postMessage = post;
        e.pixelBudget = savedBudget;
      }
    });
    expect(r.widths).toEqual(r.want);
    expect(r.copies).toBe(6);
    expect(r.maxCopiesAhead).toBeLessThanOrEqual(Math.min(2, r.poolSize));
    expect(r.maxRunning).toBeLessThanOrEqual(r.budget);
    expect(r.maxRunning).toBeGreaterThan(0);
    expect(r.defaultBudget).toBeGreaterThanOrEqual(12e6);
  });

  test('a job over the pixel budget runs alone; a small job may pass a big one that waits', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const e = window.squishlessDev.engine;
      await e.ready;
      const img = window.small;
      const n = img.width * img.height;
      const big = { rgba: new Uint8ClampedArray(n * 2 * 4).fill(120), width: img.width, height: img.height * 2 };
      const saved = e.pixelBudget;
      const started = [];
      let maxRunning = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, transfer) {
        if (msg && msg.op === 'resize') {
          started.push(msg.opts.width);
          maxRunning = Math.max(maxRunning, e._runningPixels());
        }
        return post.call(this, msg, transfer);
      };
      const run = async (jobs) => {
        started.length = 0;
        maxRunning = 0;
        await Promise.all(jobs());
        return { started: started.slice(), maxRunning };
      };
      try {
        // 1. Budget below one big job (2n): it still runs, and never next to another job.
        e.pixelBudget = n * 1.5;
        const alone = await run(() => [
          e.resize(big, { width: img.width - 5 }),
          e.resize(img, { width: img.width - 6 }),
          e.resize(big, { width: img.width - 7 }),
        ]);
        // 2. Budget 2.5n: small job A runs; big job B (2n) waits; small job C jumps ahead.
        e.pixelBudget = n * 2.5;
        const jump = await run(() => [
          e.resize(img, { width: img.width - 8 }),
          e.resize(big, { width: img.width - 9 }),
          e.resize(img, { width: img.width - 10 }),
        ]);
        return { alone, jump, n, w: img.width, poolSize: e.poolSize };
      } finally {
        Worker.prototype.postMessage = post;
        e.pixelBudget = saved;
      }
    });
    const w = r.w;
    expect(r.alone.started).toEqual([w - 5, w - 6, w - 7]);
    expect(r.alone.maxRunning).toBeLessThanOrEqual(2 * r.n); // only ever the big job alone
    if (r.poolSize >= 2) expect(r.jump.started).toEqual([w - 8, w - 10, w - 9]);
    else expect(r.jump.started).toEqual([w - 8, w - 9, w - 10]);
    expect(r.jump.maxRunning).toBeLessThanOrEqual(2.5 * r.n);
  });

  test('a worker is recycled after a job over 6 MP', async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const e = window.squishlessDev.engine;
      await e.ready;
      const w = 2600;
      const h = 2400; // 6.24 MP
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        const x = (i >> 2) % w;
        rgba[i] = x & 255; rgba[i + 1] = (i >> 10) & 255; rgba[i + 2] = 128; rgba[i + 3] = 255;
      }
      const img = { rgba, width: w, height: h, type: 'image/png', name: 'big.png' };
      const before = e.workerCount;
      const map = await e.seamOrder(img, { axis: 'x', maxSeams: 1, blur: 0 });
      const after = e.workerCount;
      const small = await e.resize({ rgba: new Uint8ClampedArray(64).fill(90), width: 4, height: 4 }, { width: 3 });
      return { before, after, len: map.order.length, again: small.width, workers: e.workerCount };
    });
    expect(r.before).toBe(1);
    expect(r.len).toBe(2600 * 2400);
    expect(r.after).toBe(0); // retired
    expect(r.again).toBe(3);
    expect(r.workers).toBe(1); // a fresh one was started for the next job
  });

  test('engine errors reject cleanly and the next job works', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const img = window.small;
      const bad = await D.engine.resize(img, { width: 100, protect: new Uint8Array(10) }).then(() => null, (e) => e.message);
      const badImg = await D.engine.resize({ rgba: new Uint8ClampedArray(12), width: 5, height: 5 }, { width: 3 }).then(() => null, (e) => e.name);
      const ok = await D.engine.resize(img, { width: 100 });
      return { bad, badImg, ok: ok.width };
    });
    expect(r.bad).toMatch(/protect/);
    expect(r.badImg).toBe('TypeError');
    expect(r.ok).toBe(100);
  });

  test('encode to JPEG, PNG and WebP (PNG fallback where WebP is unsupported)', async ({ page }) => {
    await openHarness(page);
    await defineSmall(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const img = window.small;
      const out = {};
      for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
        const blob = await D.engine.encode(img, { type, quality: 0.9 });
        const back = await D.engine.decode(blob);
        out[type] = {
          type: blob.type, size: blob.size, w: back.width, h: back.height,
          diff: D.diffPixels(back.rgba, img.rgba, 0), diffLoose: D.diffPixels(back.rgba, img.rgba, 40) / (img.width * img.height),
        };
      }
      // Transparent pixels become white in JPEG.
      const t = { rgba: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4, type: 'image/png', name: 't.png' };
      const tj = await D.engine.decode(await D.engine.encode(t, { type: 'image/jpeg' }));
      out.whiteBg = tj.rgba[0] > 240 && tj.rgba[1] > 240 && tj.rgba[2] > 240;
      const lo = await D.engine.encode(img, { type: 'image/jpeg', quality: 0.3 });
      out.qualityShrinks = lo.size < out['image/jpeg'].size;
      return out;
    });
    expect(r['image/jpeg'].type).toBe('image/jpeg');
    expect(r['image/png'].type).toBe('image/png');
    expect(['image/webp', 'image/png']).toContain(r['image/webp'].type);
    for (const t of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(r[t].size).toBeGreaterThan(100);
      expect(r[t].diffLoose).toBeLessThan(0.02);
    }
    expect(r['image/png'].diff).toBe(0); // lossless round trip
    expect(r.whiteBg).toBe(true);
    expect(r.qualityShrinks).toBe(true);
  });

  test('buildZip writes a valid STORE archive with unique UTF-8 names', async ({ page }) => {
    await openHarness(page);
    const names = ['photo.jpg', 'Photo.JPG', 'photo.jpg', 'résumé ✓.png', 'a/b\\c.png', ''];
    const payloads = names.map((_, i) => Array.from({ length: 100 + i * 37 }, (__, j) => (j * (i + 3)) & 255));
    const b64 = await page.evaluate(async ({ names, payloads }) => {
      const D = window.squishlessDev;
      const zip = await D.buildZip(names.map((name, i) => ({ name, blob: new Blob([new Uint8Array(payloads[i])]) })));
      return { type: zip.type, data: await D.blobToBase64(zip) };
    }, { names, payloads });
    expect(b64.type).toBe('application/zip');
    const buf = Buffer.from(b64.data, 'base64');

    // Parse: end of central directory, then the central directory, then local headers.
    const eocd = buf.length - 22;
    expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOff = buf.readUInt32LE(eocd + 16);
    expect(count).toBe(names.length);
    expect(cdOff + cdSize).toBe(eocd);
    const entries = [];
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      expect(buf.readUInt32LE(p)).toBe(0x02014b50);
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      const size = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const off = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      expect(flags & 0x0800).toBe(0x0800);
      expect(method).toBe(0);
      expect(buf.readUInt32LE(off)).toBe(0x04034b50);
      const lNameLen = buf.readUInt16LE(off + 26);
      const lExtra = buf.readUInt16LE(off + 28);
      expect(buf.subarray(off + 30, off + 30 + lNameLen).toString('utf8')).toBe(name);
      const data = buf.subarray(off + 30 + lNameLen + lExtra, off + 30 + lNameLen + lExtra + size);
      expect(zlib.crc32(data)).toBe(crc);
      expect(buf.readUInt32LE(off + 14)).toBe(crc);
      entries.push({ name, data: Array.from(data) });
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    expect(entries.map((e) => e.name)).toEqual(['photo.jpg', 'Photo (2).JPG', 'photo (3).jpg', 'résumé ✓.png', 'a_b_c.png', 'image']);
    entries.forEach((e, i) => expect(e.data).toEqual(payloads[i]));
  });

  test('handoff: files survive a navigation, takeFiles clears them', async ({ page }) => {
    await openHarness(page);
    const stashed = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const a = await D.fetchBlob('/samples/sample.jpg');
      const b = new File([new Uint8Array([1, 2, 3, 250])], 'notes ✓.png', { type: 'image/png', lastModified: 1700000000000 });
      return D.stashFiles([a, b]);
    });
    expect(stashed).toBe(true);
    await page.goto('/dev/engine?from=home');
    await page.waitForFunction(() => window.squishlessDevReady === true);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const files = await D.takeFiles();
      const again = await D.takeFiles();
      const info = [];
      for (const f of files) {
        info.push({ name: f.name, type: f.type, size: f.size, isFile: f instanceof File, lastModified: f.lastModified });
      }
      const img = files.length ? await D.engine.decode(files[0]) : null;
      const tiny = files[1] ? Array.from(new Uint8Array(await files[1].arrayBuffer())) : null;
      return { info, again: again.length, decoded: img && [img.width, img.height, img.name], tiny };
    });
    expect(r.info.map((f) => [f.name, f.type, f.isFile])).toEqual([
      ['sample.jpg', 'image/jpeg', true],
      ['notes ✓.png', 'image/png', true],
    ]);
    expect(r.info[1].lastModified).toBe(1700000000000);
    expect(r.tiny).toEqual([1, 2, 3, 250]);
    expect(r.decoded).toEqual([670, 447, 'sample.jpg']);
    expect(r.again).toBe(0);
  });

  test('handoff: an entry that is never taken is deleted (clearStale and on page load)', async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const D = window.squishlessDev;
      const H = await import('/assets/js/handoff.js');
      const file = () => new File([new Uint8Array(5000)], 'private-photo.jpg', { type: 'image/jpeg' });
      const count = () => new Promise((resolve) => {
        const req = indexedDB.open('squishless-handoff');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('files', 'readonly');
          const c = tx.objectStore('files').count();
          c.onsuccess = () => { db.close(); resolve(c.result); };
        };
      });
      const out = {};
      out.stashed = await D.stashFiles([file()]);
      out.records = await count();
      out.keptAge = await H.clearStale(60_000); // fresh: kept
      out.afterKeep = await count();
      out.cleared = await H.clearStale(0);
      out.afterClear = await count();
      out.taken = (await D.takeFiles()).length;
      // A stash that is already stale when a page without ?from=home loads.
      await D.stashFiles([file()]);
      return out;
    });
    expect(r.stashed).toBe(true);
    expect(r.records).toBe(2); // files + small meta record
    expect(r.keptAge).toBeGreaterThanOrEqual(0);
    expect(r.afterKeep).toBe(2);
    expect(r.cleared).toBe(-1);
    expect(r.afterClear).toBe(0);
    expect(r.taken).toBe(0);
    // Age the second stash past STALE_MS by rewriting its timestamps, then load a page.
    await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('squishless-handoff');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('files', 'readwrite');
        const st = tx.objectStore('files');
        const old = Date.now() - 60_000;
        st.get('pending').onsuccess = (ev) => st.put({ ...ev.target.result, savedAt: old }, 'pending');
        st.put({ savedAt: old }, 'pending-meta');
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    }));
    await page.goto('/dev/engine');
    await page.waitForFunction(() => window.squishlessDevReady === true);
    await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('squishless-handoff');
      req.onsuccess = () => {
        const db = req.result;
        const c = db.transaction('files', 'readonly').objectStore('files').count();
        c.onsuccess = () => { db.close(); resolve(c.result); };
      };
    })), { timeout: 10_000 }).toBe(0);
  });

  test('demo page: load, seam order, live slider', async ({ page }) => {
    const errors = await openHarness(page);
    await page.check('input[name=sample][value="/samples/sample.jpg"]');
    await expect(page.locator('#status')).toContainText('done', { timeout: 30_000 });
    await page.click('#order');
    await expect(page.locator('#slider')).toBeEnabled({ timeout: 60_000 });
    await page.locator('#slider').fill('100');
    await expect(page.locator('#sliderOut')).toContainText('570 × 447');
    expect(await page.locator('#live').evaluate((c) => c.width)).toBe(570);
    expect(errors).toEqual([]);
  });
});

test('timings on the sample photos (resize -350 px, seamOrder 60%)', async ({ page, browserName }, info) => {
  test.skip(!process.env.SQUISHLESS_PERF, 'set SQUISHLESS_PERF=1 to measure');
  test.setTimeout(600_000);
  await openHarness(page);
  const rows = await page.evaluate(async () => {
    const D = window.squishlessDev;
    const e = D.engine;
    const t0 = performance.now();
    await e.ready;
    const load = performance.now() - t0;
    const out = [{ name: 'engine load (first worker)', ms: load }];
    for (const name of ['portrait-field.jpg', 'lake-canoe.jpg', 'city-skyline.jpg', 'sample.jpg']) {
      const img = await D.fetchImg('/samples/' + name);
      let t = performance.now();
      await e.resize(img, { width: img.width - 350 });
      const resize = performance.now() - t;
      t = performance.now();
      await e.resize(img, { width: img.width - 350, faces: true });
      const resizeFaces = performance.now() - t;
      t = performance.now();
      const map = await e.seamOrder(img, { axis: 'x', maxSeams: Math.floor(img.width * 0.6) });
      const order = performance.now() - t;
      t = performance.now();
      let frame;
      for (let k = 0; k < 60; k++) frame = D.renderOrder(img.rgba, img.width, img.height, map.order, 'x', k * 5, frame && frame.width === img.width - k * 5 ? frame : undefined);
      const render = (performance.now() - t) / 60;
      out.push({ name: `${name} ${img.width}x${img.height}`, resize, resizeFaces, order, render });
    }
    return out;
  });
  for (const r of rows) {
    const line = Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(1) : v}`).join(' ');
    console.log(`[perf ${browserName}] ${line}`);
    info.annotations.push({ type: 'perf', description: line });
  }
});
