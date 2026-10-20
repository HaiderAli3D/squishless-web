// Render the Squishless PNG icons and og-image with Playwright (Chromium).
// Run from the repo root, after `python site/assets/img/src/make_svgs.py`:
//   node site/assets/img/src/make_pngs.mjs
// Serves site/ through request interception, so no local server is needed.
// The demo photos (demo-portrait-*.jpg) are real engine output: portrait-field.jpg
// resized from 1000 to 560 px wide with engine.Resize (faces on) and with a plain
// Catmull-Rom scale.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const img = path.resolve(here, '..');
const site = path.resolve(here, '../../..');
const ORIGIN = 'http://squishless.local';
const types = {
  '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.js': 'text/javascript',
};

const RASPBERRY = '#ff3d6e', WINE = '#9c1043', BUTTER = '#ffcf4a';

// Full-bleed scene (no squircle) for platforms that apply their own mask.
// zoom < 1 pulls the scene towards the centre (maskable safe zone).
function fullBleed(size, zoom = 1) {
  const t = `translate(32 32) scale(${zoom}) translate(-32 -32)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
<rect width="64" height="64" fill="${RASPBERRY}"/>
<g transform="${t}">
<circle cx="45.5" cy="20" r="6.5" fill="${BUTTER}"/>
<path d="M-40 52C-20 44 -10 52 0 47C11 38 20 37.5 31 43.5S50 47 64 37C80 28 92 36 104 34V110H-40Z" fill="${WINE}"/>
<path d="M29 -40C34 -25 22 -12 29 -2C38 10 25 20.5 31 32S38 54 29 66C22 78 36 96 29 110" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</g></svg>`;
}

function page(body, size) {
  return `<!doctype html><html><head><style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}svg{display:block;width:100%;height:100%}.pad{box-sizing:border-box;width:${size}px;height:${size}px;padding:${Math.round(size * 0.04)}px}</style></head><body>${body}</body></html>`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
let renderBody = '';
await ctx.route(ORIGIN + '/**', (route) => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p === '/__render.html') return route.fulfill({ status: 200, contentType: 'text/html', body: renderBody });
  const f = path.join(site, p);
  if (!f.startsWith(site) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: 'not found' });
  route.fulfill({ status: 200, contentType: types[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
});
const p = await ctx.newPage();

async function render(html, size, out, transparent = true) {
  renderBody = html;
  await p.setViewportSize({ width: size, height: size });
  await p.goto(ORIGIN + '/__render.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: path.join(img, out), omitBackground: transparent });
  console.log('wrote', out);
}

const strip = (svg) => svg.replace(/ width="\d+" height="\d+"/, '').replace(/<title>.*?<\/title>/, '');
const markSvg = strip(fs.readFileSync(path.join(img, 'mark.svg'), 'utf8'));
const favSvg = strip(fs.readFileSync(path.join(img, 'favicon.svg'), 'utf8'));

await render(page(favSvg, 32), 32, 'favicon-32.png');
await render(page(fullBleed(180, 0.92), 180), 180, 'apple-touch-icon.png', false);
await render(page(`<div class="pad">${markSvg}</div>`, 192), 192, 'icon-192.png');
await render(page(`<div class="pad">${markSvg}</div>`, 512), 512, 'icon-512.png');
await render(page(fullBleed(512, 0.8), 512), 512, 'icon-maskable-512.png', false);

await p.setViewportSize({ width: 1200, height: 630 });
await p.goto(ORIGIN + '/assets/img/src/og.html', { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: path.join(img, 'og-image.png') });
console.log('wrote og-image.png');

await browser.close();
