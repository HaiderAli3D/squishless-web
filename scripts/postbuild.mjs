#!/usr/bin/env node
// Post-build step, run by scripts/build-site.sh after dist/ is assembled:
//   node scripts/postbuild.mjs <distDir> <BUILD_ID>
// 1. Removes dist/dev/ when VERCEL_ENV === 'production'.
// 2. Replaces the literal token __BUILD_ID__ in dist/**/*.{html,js,mjs,css,webmanifest,json}.
// 3. Writes the service-worker precache list (the app shell) into dist/sw.js, replacing
//    the placeholder array `[/*__PRECACHE_LIST__*/]`.
// 4. Replaces __SITE_URL__ in HTML with the absolute site origin (SITE_URL, else Vercel's
//    production domain, else https://squishless.vercel.app) for og:image and canonical links.
// If BUILD_ID is omitted, one is derived from the sha256 of every file in dist/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TOKEN = '__BUILD_ID__';
const SITE_TOKEN = '__SITE_URL__';
const PRECACHE_PLACEHOLDER = '[/*__PRECACHE_LIST__*/]';
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.webmanifest', '.json']);

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, out);
    else if (ent.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function deriveBuildId(dist) {
  const h = crypto.createHash('sha256');
  for (const rel of walk(dist)) {
    h.update(rel + '\0');
    h.update(fs.readFileSync(path.join(dist, rel)));
  }
  return h.digest('hex').slice(0, 12);
}

// Which dist files belong to the app shell (precached at install).
// Excluded: the engine and samples (runtime-cached), sw.js itself, dev pages,
// the 404 page, the social preview image, and non-shell files.
export function isShellFile(rel) {
  if (rel === 'sw.js' || rel === '404.html') return false;
  if (/^(engine|samples|dev)\//.test(rel)) return false;
  // design sources/previews and the styleguide are not part of the app shell
  if (/^assets\/img\/src\//.test(rel)) return false;
  if (/(^|\/)styleguide\.(html|css|js)$/.test(rel)) return false;
  if (rel === 'manifest.webmanifest') return true;
  if (/\.html$/.test(rel)) return true;
  if (/\.(js|mjs|css)$/.test(rel)) return true;
  if (/^assets\/fonts\/.+\.(woff2|woff)$/.test(rel)) return true;
  if (/^assets\/img\/(logo|mark|favicon|apple-touch-icon|icon-)[^/]*\.(svg|png|ico)$/.test(rel)) return true;
  if (isLandingPrecache(rel)) return true;
  return false;
}

// Landing page media precached for offline use: the default hero photo and the photo of
// "Watch it think" with their seams, every sample thumbnail and the gallery. The other
// hero photos are cached by the service worker when they are first used.
const LANDING_PRECACHE_PHOTOS = ['portrait-field', 'lake-canoe'];
export function isLandingPrecache(rel) {
  const m = /^assets\/landing\/(.+)$/.exec(rel);
  if (!m) return false;
  const name = m[1];
  if (/^gallery\/[^/]+\.(jpg|jpeg|png|webp)$/.test(name)) return true;
  if (/^[^/]+-thumb\.(jpg|jpeg|png|webp)$/.test(name)) return true;
  const photo = /^([^/]+)\.(jpg|seams)$/.exec(name);
  return !!photo && LANDING_PRECACHE_PHOTOS.includes(photo[1]);
}

// cleanUrls: index.html -> /, app/index.html -> /app, foo.html -> /foo
export function urlFor(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  if (rel.endsWith('.html')) return '/' + rel.slice(0, -'.html'.length);
  return '/' + rel;
}

function main() {
  const [distArg, idArg] = process.argv.slice(2);
  if (!distArg) {
    console.error('usage: node scripts/postbuild.mjs <distDir> [BUILD_ID]');
    process.exit(2);
  }
  const dist = path.resolve(distArg);
  if (!fs.existsSync(dist)) {
    console.error(`postbuild: ${dist} does not exist`);
    process.exit(1);
  }

  // 1. drop dev pages in production
  const devDir = path.join(dist, 'dev');
  if (process.env.VERCEL_ENV === 'production' && fs.existsSync(devDir)) {
    fs.rmSync(devDir, { recursive: true, force: true });
    console.log('postbuild: removed dist/dev (production)');
  }

  const buildId = idArg || deriveBuildId(dist);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(buildId)) {
    console.error(`postbuild: invalid BUILD_ID ${JSON.stringify(buildId)}`);
    process.exit(1);
  }

  // 2. token replacement
  const files = walk(dist);
  let replaced = 0;
  for (const rel of files) {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
    const p = path.join(dist, rel);
    const src = fs.readFileSync(p, 'utf8');
    if (!src.includes(TOKEN)) continue;
    fs.writeFileSync(p, src.split(TOKEN).join(buildId));
    replaced++;
  }

  // 4. absolute site URL (link previews ignore relative og:image URLs)
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const siteUrl = (process.env.SITE_URL || (prodHost ? `https://${prodHost}` : 'https://squishless.vercel.app')).replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(siteUrl)) {
    console.error(`postbuild: invalid SITE_URL ${JSON.stringify(siteUrl)}`);
    process.exit(1);
  }
  for (const rel of files) {
    if (path.extname(rel).toLowerCase() !== '.html') continue;
    const p = path.join(dist, rel);
    const src = fs.readFileSync(p, 'utf8');
    if (src.includes(SITE_TOKEN)) fs.writeFileSync(p, src.split(SITE_TOKEN).join(siteUrl));
  }

  // 3. precache list
  // .seams URLs are versioned the way the page requests them (the SW caches them by full URL).
  const shell = files
    .filter(isShellFile)
    .map((rel) => (rel.endsWith('.seams') ? `${urlFor(rel)}?v=${buildId}` : urlFor(rel)));
  const swPath = path.join(dist, 'sw.js');
  if (fs.existsSync(swPath)) {
    const sw = fs.readFileSync(swPath, 'utf8');
    if (!sw.includes(PRECACHE_PLACEHOLDER)) {
      console.error(`postbuild: ${PRECACHE_PLACEHOLDER} not found in dist/sw.js`);
      process.exit(1);
    }
    fs.writeFileSync(swPath, sw.replace(PRECACHE_PLACEHOLDER, JSON.stringify(shell, null, 2)));
  } else {
    console.warn('postbuild: dist/sw.js not found; skipping precache list');
  }

  console.log(`postbuild: BUILD_ID=${buildId}, SITE_URL=${siteUrl}, token replaced in ${replaced} file(s), ${shell.length} precache entries`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
