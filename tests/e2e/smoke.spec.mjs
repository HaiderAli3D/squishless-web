// Smoke tests: pages load cleanly, production headers and MIME types are right.
import { test, expect } from '@playwright/test';

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
  "img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' blob: data:; " +
  "font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'none'; " +
  "frame-ancestors 'none'";

// Collects console errors, page errors and requests to other origins.
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

test('home page loads with 200, no console errors, no other origins', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  const res = await page.goto('/', { waitUntil: 'load' });
  expect(res.status()).toBe(200);
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveTitle(/Squishless/i);
  expect(p.errors, p.errors.join('\n')).toEqual([]);
  expect(p.foreign, p.foreign.join('\n')).toEqual([]);
});

test('/app loads with 200, no console errors, no other origins', async ({ page, baseURL }) => {
  const p = watch(page, baseURL);
  const res = await page.goto('/app', { waitUntil: 'load' });
  expect(res.status()).toBe(200);
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveTitle(/Squishless/i);
  expect(p.errors, p.errors.join('\n')).toEqual([]);
  expect(p.foreign, p.foreign.join('\n')).toEqual([]);
});

test('unknown path shows the 404 page with status 404', async ({ page }) => {
  const res = await page.goto('/nope', { waitUntil: 'load' });
  expect(res.status()).toBe(404);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('a[href="/"]').first()).toBeAttached();
  await expect(page.locator('a[href="/app"]').first()).toBeAttached();
});

test('security headers are present', async ({ request }) => {
  for (const path of ['/', '/app', '/nope']) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h['content-security-policy'], path).toBe(CSP);
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(h['permissions-policy'], path).toContain('camera=()');
  }
  const html = await request.get('/');
  expect(html.headers()['cache-control']).toBe('public, max-age=0, must-revalidate');
});

test('clean URLs: .html and trailing slash redirect', async ({ request }) => {
  const a = await request.get('/app/', { maxRedirects: 0 });
  expect(a.status()).toBe(308);
  expect(a.headers()['location']).toBe('/app');
  const b = await request.get('/index.html', { maxRedirects: 0 });
  expect(b.status()).toBe(308);
  expect(b.headers()['location']).toBe('/');
});

test('engine wasm is served as application/wasm and immutable', async ({ request }) => {
  const res = await request.get('/engine/squishless.wasm?v=test');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/wasm');
  expect(res.headers()['cache-control']).toContain('immutable');
  const body = await res.body();
  expect(body.subarray(0, 4).toString('hex')).toBe('0061736d'); // "\0asm"
});

test('service worker, manifest and robots are served correctly', async ({ request }) => {
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toContain('javascript');
  expect(sw.headers()['cache-control']).toBe('public, max-age=0, must-revalidate');
  const swText = await sw.text();
  expect(swText).not.toContain('__BUILD_ID__');
  expect(swText).not.toContain('__PRECACHE_LIST__');

  const mf = await request.get('/manifest.webmanifest');
  expect(mf.status()).toBe(200);
  expect(mf.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await mf.json();
  expect(manifest.start_url).toBe('/app');

  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain('Disallow: /dev/');
});

test('service worker installs and the app shell works offline after one visit', async ({ page, context }) => {
  await page.goto('/', { waitUntil: 'load' });
  const hasRegister = await page.locator('script[src^="/sw-register.js"]').count();
  test.skip(!hasRegister, 'page does not include /sw-register.js');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Wait until the page is controlled (clients.claim) and the shell is precached.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  await context.setOffline(true);
  try {
    const res = await page.goto('/app', { waitUntil: 'load' });
    expect(res && res.ok()).toBeTruthy();
    await expect(page).toHaveTitle(/Squishless/i);
  } finally {
    await context.setOffline(false);
  }
});

test('the landing page hero, thumbnails and gallery work offline after one visit', async ({ page, context }) => {
  await page.goto('/', { waitUntil: 'load' });
  const hasRegister = await page.locator('script[src^="/sw-register.js"]').count();
  test.skip(!hasRegister, 'page does not include /sw-register.js');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  // The precache finished before the worker activated (install waits for it).
  await context.setOffline(true);
  try {
    const failed = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    await page.reload({ waitUntil: 'load' });
    // Bring every image into view once: WebKit's lazy-load margin is small, so on a phone
    // viewport a lazy image far from the gallery (the footer logo) would never start loading.
    await page.evaluate(async () => {
      for (const img of document.images) {
        img.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await expect.poll(() => page.evaluate(() => {
      const pending = [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0));
      pending[0]?.scrollIntoView({ block: 'center', behavior: 'instant' });
      return pending.map((i) => i.getAttribute('src'));
    }), { timeout: 10_000 }).toEqual([]);
    expect(failed.filter((u) => /\/assets\/landing\//.test(u))).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
