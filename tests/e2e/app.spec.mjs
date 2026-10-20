// End-to-end tests of the app (/app): load, presets, handles, compare, brush, batch,
// export, too-big photos, hand-off from the landing page, phone layout.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES = path.join(ROOT, 'site/samples');
const sample = (n) => path.join(SAMPLES, n);

test.describe.configure({ mode: 'parallel' });
// The service worker is covered by smoke.spec; here it would only add "update available"
// prompts when dist/ is rebuilt while tests run.
test.use({ serviceWorkers: 'block' });

// ---------------------------------------------------------------- helpers

function watch(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const problems = { errors: [], foreign: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.errors.push(`pageerror: ${err.message}`));
  page.on('request', (req) => {
    const u = req.url();
    if (/^(data|blob|about):/.test(u)) return;
    if (new URL(u).origin !== origin) problems.foreign.push(u);
  });
  return problems;
}

function clean(p) {
  expect(p.errors, p.errors.join('\n')).toEqual([]);
  expect(p.foreign, p.foreign.join('\n')).toEqual([]);
}

const state = (page) => page.evaluate(() => window.squishlessApp.state);

async function openSample(page, name = 'sample.jpg') {
  await page.goto('/app');
  await page.click(`[data-sample="${name}"]`);
  await page.waitForFunction(() => window.squishlessApp.state.photos[0]?.status === 'ready');
}

/** Waits until the selected photo has an exact result; returns its size. */
async function waitResult(page, size) {
  await page.waitForFunction((want) => {
    const s = window.squishlessApp.state;
    const p = s.photos.find((x) => x.id === s.selected);
    if (!p || !p.result || p.working) return false;
    return !want || (p.result.width === want[0] && p.result.height === want[1]);
  }, size || null, { timeout: 45_000 });
  const s = await state(page);
  return s.photos.find((x) => x.id === s.selected).result;
}

async function choosePreset(page, id) {
  await page.locator(`.preset[data-preset="${id}"]`).click();
}

/** Opens the bottom sheet on narrow screens so everything in the panel is reachable. */
async function openSheet(page) {
  const toggle = page.locator('#sheet-toggle');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

async function download(page, trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 45_000 }), trigger()]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) };
}

function zipNames(buf) {
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const n = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + n).toString('utf8'));
      i += 45 + n;
    }
  }
  return names;
}

/** Image size from PNG / JPEG bytes. */
function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return null;
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** A plain grey RGB PNG of w x h (compresses to a few hundred KB even when huge). */
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(w * 3 + 1, 140); row[0] = 0;
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- tests

test('empty state: drop zone, samples, privacy, no errors', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await page.goto('/app');
  await expect(page.locator('#welcome h1')).toBeVisible();
  await expect(page.locator('#choose-btn')).toBeVisible();
  await expect(page.locator('[data-sample]')).toHaveCount(4);
  await expect(page.locator('.privacy')).toContainText('never leave this device');
  await expect(page.locator('a.brand[href="/"]')).toBeVisible();
  await expect(page.locator('a[href="https://github.com/HaiderAli3D/squishless-web"]')).toBeAttached();
  await expect(page.locator('a[href="/#how"]')).toBeAttached();
  await expect(page.locator('select')).toHaveCount(0);
  // the engine loads in the background (on phones, once the visitor touches the page)
  await page.locator('.welcome__samples-title').click();
  await page.waitForFunction(() => window.squishlessApp.state.engine === 'ready', null, { timeout: 30_000 });
  clean(p);
});

test('sample, Square preset, exact result and download', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await openSample(page, 'sample.jpg');
  const s = await state(page);
  expect([s.photos[0].width, s.photos[0].height]).toEqual([670, 447]);
  await choosePreset(page, 'square');
  const r = await waitResult(page, [447, 447]);
  expect(r).toEqual({ width: 447, height: 447 });
  await expect(page.locator('#readout-size')).toHaveText('447 × 447');
  const film = page.locator('.film').first();
  await expect(film).toHaveAttribute('data-status', 'done');
  // portrait 4:5 keeps the full height of a landscape photo: 358 x 447
  await choosePreset(page, 'portrait');
  await waitResult(page, [358, 447]);
  const dl = await download(page, () => page.locator('#download-btn').click());
  expect(dl.name).toBe('sample-358x447.jpg');
  expect(imageSize(dl.bytes)).toEqual([358, 447]);
  clean(p);
});

test('width handle works with the keyboard and with a drag', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await openSample(page, 'lake-canoe.jpg');
  const hx = page.locator('#handle-x');
  await expect(hx).toHaveAttribute('role', 'slider');
  await expect(hx).toHaveAttribute('aria-valuenow', '1000');
  await hx.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(hx).toHaveAttribute('aria-valuenow', '988');
  await waitResult(page, [988, 650]);
  // the height handle: Up makes the photo shorter
  const hy = page.locator('#handle-y');
  await hy.focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(hy).toHaveAttribute('aria-valuenow', '640');
  await waitResult(page, [988, 640]);

  // pointer drag on the width handle
  const box = await hx.boundingBox();
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx - 40, sy, { steps: 6 });
  await page.mouse.move(sx - 80, sy, { steps: 6 });
  await expect(page.locator('#stage')).toHaveClass(/is-dragging/);
  await page.mouse.up();
  // aria-valuenow follows on the next animation frame
  await expect.poll(async () => Number(await hx.getAttribute('aria-valuenow'))).toBeLessThan(988);
  const now = Number(await hx.getAttribute('aria-valuenow'));
  expect(now).toBeLessThan(988);
  expect(now).toBeGreaterThan(500);
  await waitResult(page, [now, 640]);
  clean(p);
});

test('compare: before/after, side by side, vs normal resize', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await openSample(page, 'city-skyline.jpg');
  await choosePreset(page, 'square');
  await waitResult(page, [650, 650]);
  await page.locator('label:has(input[name="view"][value="compare"])').click();
  const cmp = page.locator('#compare-wrap .compare');
  await expect(cmp).toBeVisible();
  await expect(cmp).toHaveAttribute('data-mode', 'slider');
  await expect(page.locator('#stage')).toBeHidden();
  const divider = cmp.locator('.compare__divider');
  await expect(divider).toHaveAttribute('role', 'slider');
  await divider.focus();
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '0');

  await page.locator('label:has(input[name="cmp"][value="side"])').click();
  await expect(cmp).toHaveAttribute('data-mode', 'side');
  await expect(cmp.locator('.compare__dims').nth(0)).toHaveText('1000 × 650');
  await expect(cmp.locator('.compare__dims').nth(1)).toHaveText('650 × 650');

  await page.locator('label:has(input[name="cmp"][value="normal"])').click();
  await expect(cmp).toHaveAttribute('data-mode', 'normal');
  await expect(cmp.locator('.compare__label--before')).toHaveText('Normal resize');
  await expect(cmp.locator('.compare__label--after')).toHaveText('Squishless');

  await page.locator('label:has(input[name="view"][value="edit"])').click();
  await expect(page.locator('#stage')).toBeVisible();
  clean(p);
});

test('Keep/Remove brush changes the result; undo restores it', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = watch(page, baseURL);
  await openSample(page, 'sample.jpg');
  await choosePreset(page, 'square');
  await waitResult(page, [447, 447]);
  const plain = await page.evaluate(() => window.squishlessApp.resultHash());

  await page.locator('#mark-btn').click();
  await expect(page.locator('#brush-bar')).toBeVisible();
  await expect(page.locator('#stage')).toHaveAttribute('data-mode', 'mark');
  await page.locator('label:has(input[name="brush"][value="remove"])').click();
  const frame = await page.locator('#stage-frame').boundingBox();
  // paint over the girl's face (centre-right of the photo)
  await page.mouse.move(frame.x + frame.width * 0.56, frame.y + frame.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.56, frame.y + frame.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).photos[0].marks).toBe(1);
  await expect(page.locator('#undo-btn')).toBeEnabled();
  await page.locator('#mark-done').click();
  await waitResult(page, [447, 447]);
  const marked = await page.evaluate(() => window.squishlessApp.resultHash());
  expect(marked).not.toBe(plain);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await state(page)).photos[0].marks).toBe(0);
  await waitResult(page, [447, 447]);
  await expect.poll(() => page.evaluate(() => window.squishlessApp.resultHash()), { timeout: 30_000 }).toBe(plain);
  clean(p);
});

test('batch of three: Resize all, then Download all as a ZIP', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = watch(page, baseURL);
  await page.goto('/app');
  await page.setInputFiles('#file-input', [sample('sample.jpg'), sample('lake-canoe.jpg'), sample('city-skyline.jpg')]);
  await page.waitForFunction(() => {
    const s = window.squishlessApp.state;
    return s.photos.length === 3 && s.photos.every((x) => x.status === 'ready');
  });
  await expect(page.locator('.film')).toHaveCount(3);
  await choosePreset(page, 'square');
  await expect(page.locator('#resize-all')).toHaveText('Resize all 3');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.waitForFunction(() => window.squishlessApp.state.photos.every((x) => x.result && !x.working), null, { timeout: 60_000 });
  await expect(page.locator('.film[data-status="done"]')).toHaveCount(3);
  const s = await state(page);
  expect(s.photos.map((x) => [x.result.width, x.result.height])).toEqual([[447, 447], [650, 650], [650, 650]]);

  // select another photo in the filmstrip
  await page.locator('.film').nth(1).locator('.film__thumb').click();
  await expect(page.locator('.film').nth(1)).toHaveClass(/is-selected/);
  await expect(page.locator('#readout-size')).toHaveText('650 × 650');

  const dl = await download(page, () => page.locator('#zip-btn').click());
  expect(dl.name).toBe('squishless-3-photos.zip');
  expect(zipNames(dl.bytes).sort()).toEqual(['city-skyline-650x650.jpg', 'lake-canoe-650x650.jpg', 'sample-447x447.jpg']);

  // remove one (the selected photo: on touch screens only it shows its remove button)
  await page.locator('.film').nth(1).locator('.film__remove').click();
  await expect(page.locator('.film')).toHaveCount(2);
  clean(p);
});

test('export formats: PNG, JPG and WebP (PNG where WebP is unsupported)', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = watch(page, baseURL);
  await openSample(page, 'portrait-field.jpg');
  await choosePreset(page, 'wide');
  await waitResult(page, [1000, 563]);
  await openSheet(page);
  await page.locator('label:has(input[name="fmt"][value="png"])').click();
  await expect(page.locator('#quality-row')).toBeHidden();
  let dl = await download(page, () => page.locator('#download-btn').click());
  expect(dl.name).toBe('portrait-field-1000x563.png');
  expect(imageSize(dl.bytes)).toEqual([1000, 563]);

  await page.locator('label:has(input[name="fmt"][value="jpeg"])').click();
  await expect(page.locator('#quality-row')).toBeVisible();
  dl = await download(page, () => page.locator('#download-btn').click());
  expect(dl.name).toBe('portrait-field-1000x563.jpg');
  expect(dl.bytes[0]).toBe(0xff);

  await page.locator('label:has(input[name="fmt"][value="webp"])').click();
  dl = await download(page, () => page.locator('#download-btn').click());
  expect(dl.name).toMatch(/^portrait-field-1000x563\.(webp|png)$/);
  if (dl.name.endsWith('.webp')) expect(dl.bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  else expect(dl.bytes[0]).toBe(0x89);

  // the choice is remembered
  await page.reload();
  await expect(page.locator('input[name="fmt"][value="webp"]')).toBeChecked();
  clean(p);
});

test('too-big photo gets a one-click shrink offer', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const p = watch(page, baseURL);
  await page.goto('/app');
  await page.setInputFiles('#file-input', { name: 'huge.png', mimeType: 'image/png', buffer: makePng(5000, 5000) });
  const notice = page.locator('#notice');
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#notice-title')).toHaveText('This photo is 25 MP');
  await expect(page.locator('.film').first()).toHaveAttribute('data-status', 'toobig');
  const shrink = notice.getByRole('button', { name: /Shrink to \d+ MP/ });
  const limit = Number((await shrink.textContent()).match(/(\d+) MP/)[1]) * 1e6;
  await shrink.click();
  await page.waitForFunction(() => window.squishlessApp.state.photos[0].status === 'ready', null, { timeout: 90_000 });
  await expect(notice).toBeHidden();
  const s = await state(page);
  expect(s.photos[0].width * s.photos[0].height).toBeLessThanOrEqual(limit);
  expect(s.photos[0].width).toBe(s.photos[0].height);
  clean(p);
});

test('unsupported file shows a clear message', async ({ page }) => {
  await page.goto('/app');
  await page.setInputFiles('#file-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('.toast')).toContainText('is not a photo');
  await page.setInputFiles('#file-input', { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a jpeg') });
  await expect(page.locator('#notice-title')).toHaveText('This file can’t be opened');
});

test('hand-off from the landing page opens the photo', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await page.goto('/app');
  const ok = await page.evaluate(async () => {
    const { stashFiles } = await import('/assets/js/handoff.js');
    const blob = await (await fetch('/samples/lake-canoe.jpg')).blob();
    return stashFiles([new File([blob], 'lake-canoe.jpg', { type: 'image/jpeg' })]);
  });
  expect(ok).toBe(true);
  // let the engine finish loading first: WebKit logs an aborted wasm fetch as a console error
  await page.locator('.welcome__samples-title').click(); // phones start the engine on first touch
  await page.waitForFunction(() => window.squishlessApp.state.engine === 'ready', null, { timeout: 30_000 });
  await page.goto('/app?from=home');
  await page.waitForFunction(() => window.squishlessApp.state.photos[0]?.status === 'ready');
  const s = await state(page);
  expect(s.photos[0].name).toBe('lake-canoe.jpg');
  expect(new URL(page.url()).search).toBe('');
  await expect(page.locator('#editor')).toBeVisible();
  clean(p);
});

test('settings are remembered and fine-tune resets', async ({ page }) => {
  await openSample(page, 'sample.jpg');
  await choosePreset(page, 'story');
  await openSheet(page);
  await page.locator('#fine summary').click();
  await page.locator('#opt-faces').uncheck();
  await page.locator('#opt-blur').fill('5');
  await page.reload();
  await expect(page.locator('input[name="preset"][value="story"]')).toBeChecked();
  await expect(page.locator('#opt-faces')).not.toBeChecked();
  await expect(page.locator('#opt-blur')).toHaveValue('5');
  await openSample(page, 'sample.jpg');
  await openSheet(page);
  await page.locator('#fine summary').click();
  await page.locator('#fine-reset').click();
  await expect(page.locator('#opt-faces')).toBeChecked();
  await expect(page.locator('#opt-blur')).toHaveValue('2');
});

test('custom size in pixels and percent', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await openSample(page, 'lake-canoe.jpg');
  await choosePreset(page, 'custom');
  await expect(page.locator('#custom')).toBeVisible();
  await page.locator('#c-w').fill('800');
  await page.locator('#c-h').fill('600');
  await waitResult(page, [800, 600]);
  await page.locator('label:has(input[name="cmode"][value="percent"])').click();
  await page.locator('#c-w').fill('50');
  await page.locator('#c-h').fill('100');
  await waitResult(page, [500, 650]);
  await page.locator('label:has(input[name="cmode"][value="height"])').click();
  await expect(page.locator('#c-w')).toBeHidden();
  await page.locator('#c-h').fill('500');
  await waitResult(page, [1000, 500]);
  clean(p);
});

test('filmstrip keeps still on updates; remove can be undone; focus is kept', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const p = watch(page, baseURL);
  await page.goto('/app');
  // opening from the keyboard moves focus into the editor, not to <body>
  await page.locator('[data-sample="lake-canoe.jpg"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.squishlessApp.state.photos[0]?.status === 'ready');
  await expect(page.locator('#editor-title')).toBeFocused();
  await expect(page.locator('#editor-title')).toHaveText('Editing lake-canoe.jpg');
  await page.waitForTimeout(800); // entrance animation done
  const film = page.locator('.film').first();
  await page.evaluate(() => { window.__film = document.querySelector('.film'); });
  await choosePreset(page, 'square');
  await page.waitForTimeout(40);
  expect(Number(await film.evaluate((n) => getComputedStyle(n).opacity))).toBe(1);
  expect(await page.evaluate(() => document.querySelector('.film') === window.__film)).toBe(true);

  // brush mode: visible explanation; Escape returns focus to the Mark button
  await page.locator('#mark-btn').click();
  await expect(page.locator('#brush-hint')).toBeVisible();
  await page.locator('#brush-size').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#brush-bar')).toBeHidden();
  await expect(page.locator('#mark-btn')).toBeFocused();

  // removing the only photo: back to the start, focus on Choose photos, and Undo restores it
  await film.locator('.film__remove').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#choose-btn')).toBeFocused();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('.film')).toHaveCount(1);
  const s = await state(page);
  expect(s.photos[0].status).toBe('ready');
  await waitResult(page, [650, 650]);
  clean(p);
});

test('cancelling a resize leaves a clear "Not resized" state with a Resize button', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const p = watch(page, baseURL);
  await openSample(page, 'lake-canoe.jpg');
  await choosePreset(page, 'custom');
  await page.locator('#c-w').fill('1990');
  await page.locator('#c-h').fill('1290');
  // Press Cancel the moment the full-size job runs (it can finish quickly on a fast machine).
  await page.waitForFunction(() => {
    const p = window.squishlessApp.state.photos[0];
    const btn = document.querySelector('#job-cancel');
    if (!(p.working && p.target.w === 1990 && p.target.h === 1290) || btn.closest('[hidden]') || btn.hidden) return false;
    btn.click();
    return true;
  }, null, { timeout: 45_000, polling: 'raf' });
  await expect(page.locator('#job-text')).toHaveText('Not resized');
  // phones: Custom opened the bottom sheet over the photo; close it to reach the stage
  if ((await page.locator('#sheet-toggle').getAttribute('aria-expanded')) === 'true') await page.locator('#sheet-toggle').click();
  await expect(page.locator('#job-retry')).toBeVisible();
  if (!(await page.locator('#sheet-toggle').isVisible())) await expect(page.locator('#job-retry')).toBeFocused();
  await page.waitForTimeout(1000);
  expect((await state(page)).photos[0].working).toBe(false); // it does not restart by itself
  await page.locator('#job-retry').click();
  expect((await state(page)).photos[0].working).toBe(true);
  await page.locator('#job-cancel').click();
  clean(p);
});

test('compare labels sit on their own image when the shapes differ', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await openSample(page, 'lake-canoe.jpg');
  await choosePreset(page, 'square');
  await waitResult(page, [650, 650]);
  await page.locator('label:has(input[name="view"][value="compare"])').click();
  await expect(page.locator('#compare-wrap .compare__label--after')).toBeVisible();
  const frame = await page.locator('#compare-wrap .compare__frame').boundingBox();
  const after = await page.locator('#compare-wrap .compare__label--after').boundingBox();
  // the 650-wide result is centred in the 1000-wide frame: its right edge is at 82.5%
  expect(after.x + after.width).toBeLessThan(frame.x + frame.width * 0.83);
  expect(after.x + after.width).toBeGreaterThan(frame.x + frame.width * 0.7);
  clean(p);
});

test('short viewports: the settings follow the photo and nothing covers the handles', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  for (const [w, h] of [[640, 400], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await openSample(page, 'lake-canoe.jpg');
    await expect(page.locator('#panel')).toHaveCSS('position', 'static');
    await expect(page.locator('#stage')).toHaveClass(/has-photo/);
    await expect.poll(() => page.evaluate(() => ['#handle-x', '#handle-y', '#stage-frame'].filter((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !e || !document.querySelector('#stage').contains(e);
    })), { message: `${w}x${h}`, timeout: 30_000 }).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  }
  clean(p);
});

test('phone: the Mark button has a visible name and the sheet has a visible "more" button', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page, 'sample.jpg');
  await expect(page.getByRole('button', { name: 'Mark', exact: true })).toBeVisible();
  const more = page.locator('#more-btn');
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.locator('#panel-more')).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  clean(p);
});

test('download names drop bidi controls and stay short', async ({ page }) => {
  await page.goto('/app');
  const names = await page.evaluate(async () => {
    const { fileName } = await import('/assets/js/app/exporter.js');
    return [
      fileName('a' + String.fromCharCode(0x202e) + 'gpj.exe.jpg', 447, 447, 'image/jpeg'),
      fileName('x'.repeat(300) + '.jpg', 1080, 1350, 'image/jpeg'),
    ];
  });
  expect(names[0]).toBe('agpj.exe-447x447.jpg');
  expect(names[1].length).toBeLessThanOrEqual(255);
  expect(names[1].endsWith('-1080x1350.jpg')).toBe(true);
});

test('phone layout: bottom sheet and touch-sized handles', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page, 'sample.jpg');
  const panel = page.locator('#panel');
  await expect(panel).toHaveCSS('position', 'fixed');
  const toggle = page.locator('#sheet-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#panel-more')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#panel-more')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const hb = await page.locator('#handle-x').boundingBox();
  expect(hb.width).toBeGreaterThanOrEqual(44);
  expect(hb.height).toBeGreaterThanOrEqual(44);
  // no horizontal scrolling
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await choosePreset(page, 'square');
  await waitResult(page, [447, 447]);
  clean(p);
});
