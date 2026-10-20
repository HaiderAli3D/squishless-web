// Landing page (/): hero demo (drag, keyboard, samples, normal resize), precomputed seams
// vs the wasm engine, "Try it with your photo" hand-off, FAQ, hygiene (console errors,
// third-party requests, horizontal scroll).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PHOTO = path.join(ROOT, 'site/samples/lake-canoe.jpg');

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

const stage = (page) => page.locator('.demo-stage');
const shownWidth = async (page) => Number(await stage(page).getAttribute('data-width'));

/** Hero with deterministic state: reduced motion = no autoplay, rests at 60% width. */
async function openHero(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
  await expect(stage(page)).toHaveClass(/is-live/);
}

/** Cheap fingerprint of the hero canvas pixels. */
const canvasHash = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.demo-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619);
    return h >>> 0;
  });

test('page loads cleanly: no console errors, no other origins, all sections there', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  const res = await page.goto('/', { waitUntil: 'load' });
  expect(res.status()).toBe(200);
  await expect(page).toHaveTitle(/Squishless/);
  await expect(page.locator('h1')).toHaveText('Resize photos without the squish.');
  await expect(page.locator('a.btn', { hasText: 'Open the app' }).first()).toHaveAttribute('href', '/app');
  await expect(page.locator('#how')).toBeAttached();
  await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
  // scroll through so lazy parts (Watch it think, gallery sliders) load too
  for (const sel of ['#how', '#try', '#features', '#gallery', '#faq', '.site-footer']) {
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
  }
  await expect(page.locator('.think')).toHaveClass(/is-live/);
  await expect(page.locator('.gallery__slot .compare')).toHaveCount(3);
  await page.waitForLoadState('networkidle');
  expect(p.errors, p.errors.join('\n')).toEqual([]);
  expect(p.foreign, p.foreign.join('\n')).toEqual([]);
  // the wasm engine is not needed (or fetched) for any of that
  const engineFetched = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((e) => /squishless\.wasm/.test(e.name)));
  expect(engineFetched).toBe(false);
});

test('dragging the handle with the mouse changes the rendered width', async ({ page }) => {
  await openHero(page);
  expect(await shownWidth(page)).toBe(540); // 60% of 900 (reduced-motion resting point)
  const box = await stage(page).boundingBox();
  const handle = await page.locator('.demo-handle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => shownWidth(page)).toBeLessThan(430);
  expect(await shownWidth(page)).toBeGreaterThan(380);
  // the canvas is transparent right of the new edge
  const alpha = await page.evaluate(() => {
    const c = document.querySelector('.demo-canvas');
    return c.getContext('2d').getImageData(c.width - 5, 100, 1, 1).data[3];
  });
  expect(alpha).toBe(0);
  // and dragging right widens it again
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => shownWidth(page)).toBeGreaterThan(820);
});

test('touch: sideways drag on the photo resizes, a vertical swipe does not', async ({ page }) => {
  await openHero(page);
  const touch = (type, x, y) =>
    page.evaluate(([type, x, y]) => {
      const el = document.querySelector('.demo-canvas');
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
        button: type === 'pointermove' ? -1 : 0, clientX: x, clientY: y,
      }));
    }, [type, x, y]);
  const box = await stage(page).boundingBox();
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.3;
  const start = await shownWidth(page);
  // vertical swipe: the page would scroll, the photo stays put
  await touch('pointerdown', x0, y);
  await touch('pointermove', x0 + 2, y + 30);
  await touch('pointermove', x0 + 30, y + 60);
  await touch('pointerup', x0 + 30, y + 60);
  expect(await shownWidth(page)).toBe(start);
  // sideways drag: the edge follows the finger
  await touch('pointerdown', x0, y);
  await touch('pointermove', x0 + 20, y + 2);
  await touch('pointermove', box.x + box.width * 0.5, y + 2);
  await touch('pointerup', box.x + box.width * 0.5, y + 2);
  await expect.poll(() => shownWidth(page)).toBeLessThan(start - 50);
});

test('the handle is a keyboard slider', async ({ page }) => {
  await openHero(page);
  const handle = page.locator('.demo-handle[role="slider"]');
  await handle.focus();
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '100');
  expect(await shownWidth(page)).toBe(900);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => shownWidth(page)).toBe(891);
  await page.keyboard.press('PageDown');
  await expect.poll(() => shownWidth(page)).toBe(801);
  await page.keyboard.press('Home');
  await expect.poll(() => shownWidth(page)).toBe(900 - 558);
  await expect(handle).toHaveAttribute('aria-valuenow', '38');
  await expect(handle).toHaveAttribute('aria-valuetext', /342 of 900 pixels/);
});

test('switching sample photos loads their seams', async ({ page }) => {
  await openHero(page);
  const before = await canvasHash(page);
  await page.locator('.demo-sample', { has: page.locator('input[value="city-skyline"]') }).click();
  await expect(stage(page)).toHaveAttribute('data-sample', 'city-skyline');
  await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
  await expect(page.locator('.demo-img')).toHaveAttribute('src', '/assets/landing/city-skyline.jpg');
  await expect(page.locator('.demo-caption')).toHaveText(/skyline/i);
  expect(await canvasHash(page)).not.toBe(before);
  // the 670 px photo has its own width range
  await page.locator('.demo-sample', { has: page.locator('input[value="sample"]') }).click();
  await expect(stage(page)).toHaveAttribute('data-sample', 'sample');
  await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
  const handle = page.locator('.demo-handle');
  await handle.focus();
  await page.keyboard.press('End');
  await expect.poll(() => shownWidth(page)).toBe(670);
});

test('the "Normal resize" toggle squashes the same width', async ({ page }) => {
  await openHero(page);
  const width = await shownWidth(page);
  const carved = await canvasHash(page);
  await page.locator('.demo-mode label', { hasText: 'Normal resize' }).click();
  await expect(stage(page)).toHaveAttribute('data-mode', 'normal');
  await expect(page.locator('.demo-tag')).toHaveText('Normal resize');
  await expect(page.locator('.demo-caption')).toHaveText(/squeezed/);
  expect(await shownWidth(page)).toBe(width);
  await expect.poll(() => canvasHash(page)).not.toBe(carved);
  await page.locator('.demo-mode label', { hasText: 'Squishless' }).click();
  await expect(stage(page)).toHaveAttribute('data-mode', 'carve');
  await expect.poll(() => canvasHash(page)).toBe(carved);
});

test('precomputed seams match the wasm engine exactly', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || testInfo.project.name !== 'chromium', 'one engine run is enough');
  test.setTimeout(120_000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { decodeSeams } = await import('/assets/js/landing/seams.js');
    const { getEngine } = await import('/assets/js/engine.js');
    const id = 'lake-canoe';
    const buf = await (await fetch(`/assets/landing/${id}.seams`)).arrayBuffer();
    const s = decodeSeams(buf);
    // the exact (lossless) pixels the build computed the seams on
    const img = new Image();
    img.src = `/dev/landing/${id}.png`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
    const engine = getEngine();
    await engine.ready;
    const r = await engine.seamOrder({ rgba, width: c.width, height: c.height, type: 'image/png', name: id },
      { axis: 'x', maxSeams: s.seams, faces: true, blur: 2, sobel: 0 });
    let diff = 0;
    let first = -1;
    for (let i = 0; i < r.order.length; i++) {
      if (r.order[i] !== s.order[i]) {
        diff++;
        if (first < 0) first = i;
      }
    }
    return { w: s.width, h: s.height, seams: s.seams, pw: c.width, ph: c.height, n: r.order.length, diff, first };
  });
  expect(result.pw).toBe(result.w);
  expect(result.ph).toBe(result.h);
  expect(result.n).toBe(result.w * result.h);
  expect(result.seams).toBe(Math.round(result.w * 0.62));
  expect(result.diff, `first difference at pixel ${result.first}`).toBe(0);
});

test('"Try it with your photo" hands the file to the app', async ({ page }) => {
  await page.goto('/');
  await page.locator('#try-input').setInputFiles(PHOTO);
  await page.waitForURL(/\/app\?from=home$/);
  // the app reads the stash; if it has not yet, the record is still in IndexedDB
  expect(new URL(page.url()).pathname).toBe('/app');
});

test('dropping a non-image says so and stays on the page', async ({ page }) => {
  await page.goto('/');
  await page.locator('#try-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.locator('#try-status')).toHaveText(/doesn’t look like a photo/);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('FAQ entries open and close', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.faq__item', { hasText: 'Are my photos uploaded anywhere?' });
  await expect(item).not.toHaveAttribute('open', '');
  await item.locator('summary').click();
  await expect(item).toHaveAttribute('open', '');
  await expect(item.locator('p')).toBeVisible();
  await item.locator('summary').click();
  await expect(item).not.toHaveAttribute('open', '');
});

test('phone viewport: no horizontal scroll, touch-sized demo', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
  for (const sel of ['#how', '#features', '#gallery', '.site-footer']) {
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    expect(sw, `horizontal scroll near ${sel}`).toBeLessThanOrEqual(iw);
  }
  const grip = await page.locator('.demo-handle__grip').boundingBox();
  expect(grip.width).toBeGreaterThanOrEqual(40);
  expect(grip.height).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

test('no horizontal scroll at 320, 390, 834 and 1024 px, even with the hero at full width', async ({ browser, baseURL }) => {
  for (const [width, height] of [[320, 640], [390, 844], [834, 1112], [1024, 768]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, baseURL, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
    await page.locator('.demo-handle').focus();
    await page.keyboard.press('End');
    await expect(stage(page)).toHaveAttribute('data-width', '900');
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    expect(sw, `horizontal scroll at ${width} px`).toBeLessThanOrEqual(iw);
    // whatever stays in the header fits inside the viewport
    const right = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('.site-header a, .site-header button'))
      .filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(width);
    await ctx.close();
  }
});

test('Tab reaches each gallery slider on the first forward pass', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(stage(page)).toHaveAttribute('data-ready', 'carve');
  await page.locator('[data-pick-photo]').last().focus(); // "Choose photos"; the gallery is far below
  const seen = [];
  for (let i = 0; i < 20 && seen.length < 3; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      const slot = a.closest('.gallery__slot');
      return slot ? { role: a.getAttribute('role'), label: a.getAttribute('aria-label') } : null;
    });
    if (info && info.role === 'slider') seen.push(info.label);
    else if (info) await page.waitForTimeout(300); // placeholder: the slider is being built
  }
  expect(seen).toHaveLength(3);
  expect(new Set(seen).size).toBe(3);
});

test('touch phones get the "pick a photo" copy, not drop/paste hints', async ({ browser, baseURL, browserName }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL, hasTouch: true, isMobile: browserName !== 'firefox' });
  const page = await ctx.newPage();
  await page.goto('/');
  // the media query decides; desktop browsers without touch emulation keep the desktop copy
  const touch = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
  await expect(page.locator('.try__text--touch')).toBeVisible({ visible: touch });
  await expect(page.locator('.try__text--desk')).toBeVisible({ visible: !touch });
  await expect(page.locator('.try__paste')).toBeVisible({ visible: !touch });
  await ctx.close();
});
