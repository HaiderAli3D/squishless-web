/* Squishless service worker. Versioned per build: postbuild replaces __BUILD_ID__ and
   the precache placeholder below. Strategies:
   - navigations and shell JS/CSS/manifest: network-first, cached copy when offline
   - /engine/* and /assets/fonts/*: cache-first (immutable, versioned URLs)
   - /samples/* and /assets/img/*: stale-while-revalidate
   - /assets/landing/*.seams: cache-first (the URL carries ?v=BUILD_ID)
   - /assets/landing/* images: network-first, cached copy when offline (they are not
     versioned and must match the .seams of the same build)
   The landing hero (default photo, thumbnails, seams) and gallery are precached too.
   - never touches non-GET or cross-origin requests
   A new version waits until a page posts {type:'SKIP_WAITING'} (see /sw-register.js). */
'use strict';

const VERSION = '__BUILD_ID__';
const SHELL_CACHE = 'squishless-shell-' + VERSION;
const RUNTIME_CACHE = 'squishless-runtime-' + VERSION;
const PRECACHE = [/*__PRECACHE_LIST__*/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('squishless-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  else if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});

// Shell entries are stored under their pathname (no query), because HTML references
// them with ?v=BUILD_ID while module imports use plain paths.
function pathKey(url) {
  return url.origin + url.pathname;
}

function cacheable(res) {
  return res && res.status === 200 && res.type === 'basic' && !res.redirected;
}

async function put(cacheName, key, res) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, res);
  } catch (e) {
    /* quota or opaque issues: ignore */
  }
}

async function lookup(key) {
  return (
    (await caches.match(key, { cacheName: SHELL_CACHE })) ||
    (await caches.match(key, { cacheName: RUNTIME_CACHE }))
  );
}

const OFFLINE_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline - Squishless</title><h1>You are offline</h1>' +
  '<p>This page has not been saved for offline use yet. <a href="/app">Open the app</a>.</p>';

async function networkFirst(request, url, isNavigation) {
  const key = pathKey(url);
  try {
    const res = await fetch(request);
    if (cacheable(res)) put(isNavigation || isShellPath(url) ? SHELL_CACHE : RUNTIME_CACHE, key, res.clone());
    return res;
  } catch (err) {
    const cached = await lookup(key);
    if (cached) return cached;
    if (isNavigation) {
      return new Response(OFFLINE_HTML, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    throw err;
  }
}

async function cacheFirst(request, key) {
  const cached = await lookup(key);
  if (cached) return cached;
  const res = await fetch(request);
  if (cacheable(res)) put(RUNTIME_CACHE, key, res.clone());
  return res;
}

async function staleWhileRevalidate(event, request, key) {
  const cached = await lookup(key);
  const fresh = fetch(request)
    .then((res) => {
      if (cacheable(res)) return put(RUNTIME_CACHE, key, res.clone()).then(() => res);
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(fresh);
    return cached;
  }
  const res = await fresh;
  return res || Response.error();
}

function isShellPath(url) {
  return /\.(js|mjs|css|webmanifest)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range')) return;
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, url, true));
    return;
  }
  const p = url.pathname;
  if (p.startsWith('/engine/')) {
    // versioned by ?v=BUILD_ID: key includes the query
    event.respondWith(cacheFirst(request, url.href));
    return;
  }
  if (p.startsWith('/assets/fonts/')) {
    event.respondWith(cacheFirst(request, pathKey(url)));
    return;
  }
  if (p.startsWith('/assets/landing/')) {
    if (p.endsWith('.seams')) event.respondWith(cacheFirst(request, url.href));
    else event.respondWith(networkFirst(request, url, false));
    return;
  }
  if (p.startsWith('/samples/') || p.startsWith('/assets/img/')) {
    event.respondWith(staleWhileRevalidate(event, request, pathKey(url)));
    return;
  }
  if (isShellPath(url)) {
    event.respondWith(networkFirst(request, url, false));
  }
  // everything else: default browser handling
});
