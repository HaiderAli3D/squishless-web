# Squishless on the web: implementation plan

> ARCHITECTURE.md is the source of truth for interfaces and file ownership; where the two differ, follow ARCHITECTURE.md.

Goal: a public, free web app at (Vercel URL / your domain) where anyone can resize photos
with seam carving, plus a fun landing page. Everything runs **in the visitor's browser**
(Go engine compiled to WebAssembly). No uploads, no server, no running cost. Based on the
Squishless (fast) app, not the Studio.

## What we know already (measured)

| Fact | Value |
| --- | --- |
| Engine compiles to WebAssembly unchanged | yes (`engine/`, pure Go + pigo) |
| Engine bundle size | 3.7 MB raw, 1.2 MB gzip, 0.96 MB brotli (Vercel serves brotli) |
| Speed in WebAssembly vs native | 4-7x slower: ~0.5 s (faces 0.6 s, blur 7 0.85 s) for 1000 × 650, -350 px |
| Large photos | ~12 MP natively 4-6 s, so roughly 20-40 s in a browser |
| Memory | roughly 30-40 bytes per pixel while carving (estimate), so a 16 MP photo uses ~600 MB |
| Seam-order map | possible: the carver already tracks each pixel's original column |
| Vercel CLI | v56.5 installed locally; Vercel build images don't ship Go, so the build script installs it |

## The product

### 1. Landing page (`/`)

Tone: playful, confident, uncluttered. Headline along the lines of
**"Resize photos without the squish."**

- **Interactive hero (the "wow").** A sample photo with a big drag handle on its right
  edge. Drag it and the photo narrows *live*, with no squish, at 60 fps. A toggle (or a
  split view) flips to **"Normal resize"**, which visibly squashes the people, so the
  difference is obvious in one second. Before you touch it, the handle gently wiggles and
  auto-plays a short squeeze. 3-4 sample photos to switch between (city, portrait, canoe,
  girl). This is powered by the *seam-order map* (below), so it is instant.
- **"Watch it think" strip.** The same photo with seams drawn as glowing lines that get
  peeled away one by one, captioned in plain words: *finds the most boring path of pixels,
  removes it, repeats*.
- **Drop zone CTA:** "Try it with your photo". Drop/choose/paste on the landing page goes
  straight into the app with that photo loaded.
- **Feature cards:** Private (never leaves your device), Fast, Batch + ZIP, Keep/Remove
  brush, Face protection, Any size or social preset, Free and open source.
- **Before/after gallery** (3 examples, the same slider as in the app).
- **Short FAQ** (Is it free? Are photos uploaded? Which formats? Why is a huge photo slow?)
  and a footer with GitHub, credits (seam carving paper, esimov/caire, pigo), privacy note.

### 2. The app (`/app`)

Built from today's Squishless UI, redesigned to be simpler for first-time users:

- **Stage-first layout.** The current photo is big in the middle with **drag handles on
  its right and bottom edges**. Dragging resizes with an instant live preview (seam-order
  map, one axis at a time), with W × H readout. On release, the exact result is computed
  (~0.5 s) and swapped in.
- **Size presets by purpose, not just pixels:** Square 1:1, Portrait 4:5, Story 9:16,
  Widescreen 16:9, Banner 3:1, plus Custom (exact px / percent / fit width / fit height,
  as today). Aspect presets keep as much of each image as possible.
- **Compare:** before/after slider, side by side, and a fun **"vs normal resize"** mode
  showing what a plain squish would have looked like.
- **Keep / Remove brush** directly on the stage (today's Mark areas, made inline).
- **Batch:** a filmstrip of all photos; each can have its own marks; "Resize all".
- **Export:** Download, Download all (.zip, the existing in-browser ZIP writer), and on
  phones a **Share / Save to Photos** button (Web Share API). Formats: JPG, PNG, WebP.
- **Advanced (collapsed):** Protect faces, Blur radius, Edge threshold, JPG/WebP quality.
- **Feedback:** progress bar per image, time estimate for big photos, Cancel.
- **Too big?** Photos over the browser limit get a one-click "Shrink to 12 MP first" offer
  instead of an error.
- Responsive (phone, tablet, desktop), keyboard friendly, light/dark, remembered settings.
- **Installable + offline** (PWA): after the first visit it works without a connection.

### 3. Fixes that come for free in the browser

- **Photo rotation (EXIF) is handled**: `createImageBitmap(file, {imageOrientation: "from-image"})`.
  This was a known limitation of the desktop app.
- **Metadata is stripped** from exports (privacy).
- Accepts whatever the browser can decode: JPEG, PNG, WebP, GIF, BMP, AVIF; HEIC on Safari.

## Architecture

```
site/                         static site source (new)
  index.html                  landing page
  app/index.html              the app
  assets/
    landing.js, landing.css
    app.js, app.css           evolved from cmd/squishless/web
    engine.js                 Engine API used by both pages (worker pool, cancel, progress)
    worker.js                 Web Worker: loads wasm_exec.js + squishless.wasm
    zip.js, compare.js, brush.js, livepreview.js (shared modules)
    samples/, fonts/ (self-hosted), icons, og-image.png
  manifest.webmanifest, sw.js (service worker), 404.html
cmd/wasm/main.go   js/wasm entry: resize + seamOrder, bytes in / bytes out
engine/                      + SeamOrder API, + RGBA-buffer entry points
scripts/build-site.sh         installs Go if missing, builds wasm, copies wasm_exec.js,
                              fingerprints engine files, writes site/dist
vercel.json                   build + output dir + headers (CSP, caching, wasm type)
```

### Engine changes (Go)

1. `engine.ResizeRGBA(ctx, pix []byte, w, h int, opt, progress) ([]byte, w, h, error)`:
   a thin wrapper so the worker hands over raw RGBA from a canvas without image.Image
   round trips. Masks arrive as 1-byte-per-pixel buffers.
2. `engine.SeamOrder(ctx, pix, w, h, opt, axis, maxSeams) []uint16`: for every
   pixel, the step at which it would be removed (or "never" for the last ones). Showing
   width `W - k` = keep pixels with order >= k, per row. Exact match with `Resize` for a
   one-axis shrink (same carver, same sequence); enlarging previews by duplicating pixels
   with order < k (close to, not identical to, the final enlarge; the final export always
   runs the real `Resize`). Faces and masks are included in the map.
3. `cmd/wasm`: registers `squishless.resize` and `squishless.seamOrder`;
   progress callbacks posted to the page; built with `-trimpath -ldflags="-s -w"`.
4. Tests: SeamOrder map rendering equals `Resize` output for width and height shrinks;
   wasm build and `go test` under Node in CI (Linux).

### Browser engine (`engine.js` + `worker.js`)

- **Decode** on the main thread or worker via `createImageBitmap` (EXIF aware), read pixels
  with `OffscreenCanvas` (`getImageData` gives straight, non-premultiplied RGBA, matching
  the engine).
- **Worker pool:** `min(navigator.hardwareConcurrency - 1, 3)` workers (2 on phones), each
  with its own engine instance; pixel buffers are *transferred*, not copied.
- **Cancel** = terminate that worker and start a fresh one (Go wasm cannot be interrupted
  mid-call otherwise).
- **Encode** with `OffscreenCanvas.convertToBlob({type, quality})`.
- **Limits:** 24 MP on desktop, 12 MP on phones (configurable); bigger photos get the
  "shrink first" offer. The engine loads lazily, with a skeleton state, and is cached
  by the service worker.

## Deployment (Vercel)

- `vercel.json`: `buildCommand: bash scripts/build-site.sh`, `outputDirectory: site/dist`,
  `cleanUrls: true`.
- **Go on Vercel:** the build script downloads a pinned Go release into the build cache
  when `go` is missing, then builds the wasm. (Fallback: build in GitHub Actions and
  `vercel deploy --prebuilt`.)
- **Headers:** `Content-Type: application/wasm`; immutable caching for fingerprinted
  `*.wasm`/`*.js`/fonts; short caching for HTML; strict CSP
  (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:;
  worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`), plus
  `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy`.
- No analytics by default (keeps the "nothing leaves your device" promise honest).
  Vercel Web Analytics (cookieless) can be switched on later if you want visitor counts.
- Deploy: local `vercel build` first to prove it, then a preview deploy, then production
  once you approve. You will need to log in / link the project (`vercel login`,
  `vercel link`), or connect the GitHub repo in the Vercel dashboard for automatic
  deploys on every push.

## Quality bar (definition of done)

- Works in current Chrome, Edge, Firefox and Safari, desktop and phone.
- Lighthouse: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95 on the
  landing page (the engine loads after first paint).
- No network requests after load except the site's own files (verifiable in DevTools).
- First live preview in under ~1.5 s on a laptop for the hero image.
- Automated: Go tests (incl. SeamOrder), wasm build, Playwright end-to-end tests of the
  landing demo and the app (load sample, resize, compare, brush, batch, ZIP, cancel, too-big
  flow, offline reload), run in CI.
- Docs: README gets the live link at the top; new `docs/web-app.md` (how it works,
  privacy, limits, self-hosting); credits and sample photo licences carried over.

## Build order

1. **Engine:** `ResizeRGBA`, `SeamOrder` + tests; `cmd/squishless-wasm`; build script.
   (Everything else depends on this API.)
2. **In parallel:** (a) shared browser engine (`engine.js`, `worker.js`, live preview
   renderer); (b) app UI; (c) landing page; (d) Vercel config, PWA, headers, CI.
3. **Integrate:** full end-to-end pass in real browsers.
4. **Review:** independent reviewers for correctness, UX on phone and desktop,
   accessibility, performance/memory with large photos, and security headers; fix findings.
5. **Ship:** `vercel build` locally, preview deploy, screenshots for you, then production
   on your go-ahead. Commit and push only when you say so.

## Decisions I've made (tell me if you want otherwise)

- This is its own repo (squishless-web). The engine is a copy of the Squishless desktop engine (github.com/HaiderAli3D/Squishless, internal/fastcarve).
- No analytics, no cookies, self-hosted fonts.
- Free, no accounts, no limits beyond what a browser can handle.
- Name and brand stay "Squishless"; credits to caire and the seam carving paper in the footer.
