# Squishless web: architecture and contracts

Squishless is a static web app. All image processing runs in the visitor's browser: a Go
seam-carving engine compiled to WebAssembly, running in Web Workers. There is no backend.
Nothing the user loads is uploaded anywhere.

This file is the contract between the parts of the codebase. Change it first if an
interface has to change.

## Layout

```
engine/                 Go engine (package engine): seam carving, faces (pigo), masks
cmd/wasm/main.go        js/wasm entry: exposes the `squishless` global inside a worker
scripts/build-site.sh   builds dist/: copies site/, builds the wasm, copies wasm_exec.js
scripts/serve.mjs       local static server for dist/ (same headers as production)
site/                   static site source (served as-is, no bundler)
  index.html            landing page
  app/index.html        the app
  samples/              sample photos + CREDITS.txt
  assets/css/           tokens.css, base.css (design system), landing.css, app.css
  assets/js/            ES modules (no build step, no frameworks, no CDN)
  assets/fonts/         self-hosted fonts (no third-party requests)
  assets/img/           logo, icons, og image
  sw.js, manifest.webmanifest, 404.html, robots.txt
tests/e2e/              Playwright tests
vercel.json             build command, output dir, headers
dist/                   build output (gitignored), deployed to Vercel
```

Rules for all front-end code:
- Plain HTML/CSS and ES modules. No frameworks, no bundler, no CDN, no npm runtime deps.
- No network requests to other origins, ever (fonts self-hosted, no analytics).
- Content Security Policy (set in vercel.json and scripts/serve.mjs):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' blob: data:;
  font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'none';
  frame-ancestors 'none'`. So: no inline `<script>`, no inline `style=""` attributes in
  HTML, no `eval`. Setting `element.style.x = ...` from JS is fine (CSSOM is allowed).
- Must work in current Chrome, Edge, Firefox and Safari (desktop and iOS/Android).

## Go engine API (`engine` package)

Existing: `Resize(ctx, src image.Image, opt Options, progress func(float64)) (*image.NRGBA, error)`
with `Options{Width, Height int; ProtectFaces bool; Protect, Remove *image.Gray;
BlurRadius int; SobelThreshold float32}`, `DefaultBlurRadius = 2`, `DefaultSobelThreshold = 0`.

New:
- `ResizeRGBA(ctx, pix []byte, w, h int, opt Options, progress func(float64)) (out []byte, ow, oh int, err error)`:
  `pix` is straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major, len = 4*w*h.
- `SeamOrder(ctx, pix []byte, w, h int, opt Options, axis Axis, maxSeams int) ([]uint16, error)`:
  `Axis` is `AxisX` (remove vertical seams: width shrinks) or `AxisY` (height shrinks).
  Returns one value per source pixel (index y*w+x, original coordinates): the 0-based
  step at which that pixel is removed, or `NeverRemoved` (65535) if it survives
  `maxSeams` removals. `maxSeams` is clamped to [0, size-1] and at most 65534.
  Faces/masks/blur/threshold in `opt` apply; `opt.Width/Height` are ignored.
  Invariant (tested): keeping pixels with order >= k (in each row for AxisX, each column
  for AxisY) gives exactly `Resize` to size-k on that axis.
- `MaskFromBytes(b []byte, w, h int) *image.Gray`: 1 byte per pixel, > 127 = marked.

## Wasm API (inside a worker, `cmd/wasm`)

After `wasm_exec.js` and `squishless.wasm` load, `self.squishless` exists:

```js
squishless.version                       // string
squishless.resize(rgba, w, h, opts, onProgress)
  // rgba: Uint8Array (straight RGBA). opts: { width, height, faces, blur, sobel,
  //   protect: Uint8Array|null, remove: Uint8Array|null }  (masks: 1 byte/pixel, w*h)
  // onProgress: function(fraction 0..1) or null. Synchronous; throws Error on failure.
  // returns { rgba: Uint8Array, width, height }
squishless.seamOrder(rgba, w, h, opts)
  // opts: { axis: 'x'|'y', maxSeams, faces, blur, sobel, protect, remove }
  // returns { order: Uint16Array (w*h), axis, maxSeams }
```

## Browser modules (`site/assets/js/`)

`engine.js` (main thread):
```js
export function getEngine(): Engine          // singleton, lazily starts workers
Engine.ready: Promise<void>                  // resolves when one worker has loaded wasm
Engine.decode(fileOrBlob, { maxPixels }) -> Promise<Img>
  // Img = { rgba: Uint8ClampedArray, width, height, type (mime), name }
  // Honors EXIF orientation (createImageBitmap imageOrientation:'from-image').
  // Rejects with err.code = 'TOO_BIG' (err.width, err.height) when over maxPixels,
  //   'UNSUPPORTED' when the browser cannot decode it.
Engine.downscale(img, maxPixels) -> Promise<Img>   // high-quality canvas resample
Engine.resize(img, opts, { signal, onProgress }) -> Promise<Img>
  // opts: { width, height, faces, blur, sobel, protect, remove }
  // signal: AbortSignal; abort rejects with DOMException 'AbortError' (worker is recycled)
Engine.seamOrder(img, { axis, maxSeams, faces, blur, sobel, protect, remove, signal })
  -> Promise<{ order: Uint16Array, axis, maxSeams, width, height }>
Engine.encode(img, { type: 'image/jpeg'|'image/png'|'image/webp', quality: 0..1 }) -> Promise<Blob>
Engine.limits -> { maxPixels }               // 24 MP desktop, 12 MP on phones
```
Buffers are transferred to workers, not copied, when the caller no longer needs them
(the engine copies when needed so callers' Img objects stay valid).

`worker.js`: loads `/engine/wasm_exec.js` + `/engine/squishless.wasm`, answers
`{id, op, ...}` messages with `{id, ok, result|error}` and `{id, progress}`.

`livepreview.js` (pure functions, main thread):
```js
export function renderOrder(srcRGBA, w, h, order, axis, k, out?) -> ImageData
  // k > 0: remove k seams (keep order >= k). k < 0: insert -k seams by duplicating
  // pixels with order < -k (approximate preview of enlarging). k = 0: copy.
  // AxisX output is (w-k) x h, AxisY output is w x (h-k).
```

`handoff.js`: pass files from the landing page to the app.
```js
export async function stashFiles(files)  // IndexedDB, then caller navigates to /app?from=home
export async function takeFiles()         // returns File[] (and clears) or []
```

`compare.js` (UI component, owned by the design system):
```js
export function createCompare(container, { before, after, mode }) -> { set({before, after}), setMode('slider'|'side'|'normal'), destroy() }
  // before/after: image URLs or ImageBitmaps; keyboard accessible (role=slider)
```

`zip.js`: `export function buildZip(entries:[{name, blob}]) -> Promise<Blob>` (STORE, CRC32).

## Agreed additions (from the foundation build)

- **wasm glue:** `build-site.sh` appends `cmd/wasm/glue.js` to `dist/engine/wasm_exec.js`;
  it wraps the raw Go functions so `squishless.resize/seamOrder` throw real Errors. Load
  `wasm_exec.js` (importScripts) before `go.run(instance)`; do not await `go.run` (it never
  resolves); `self.squishless` exists synchronously after it. Wasm opts defaults: blur 2,
  sobel 0, axis 'x', maxSeams = max. Extra export: `engine.ClampSeams`.
- **Engine (JS):** `downscale()` also accepts the original File/Blob (for photos `decode()`
  rejected with TOO_BIG). Extra error codes `ENGINE_LOAD` (wasm/worker failed to load;
  `ready` rejects, later calls retry) and `ENGINE_CRASH` (worker died mid-job, e.g. out of
  memory). Extra members: `version`, `poolSize`, `isPhone`, `workerCount`, `pixelBudget`.
  Queued jobs hold no pixel copy: the copy for the worker is made when the job starts,
  and the pixels running at once (max of input and output per job) stay within
  `pixelBudget` (36 MP desktop, 12.5 MP phones); a bigger job runs alone, and jobs of
  <= 2 MP may start ahead of a big one that waits. So queueing a whole batch is safe. Worker protocol
  starts with `{id, op:'init'}`. `encode()` falls back to PNG where WebP encoding is
  unsupported: check `blob.type`. JPEG puts transparency on white.
- **livepreview.js:** `renderOrder` clamps k to [-maxSeams, maxSeams] of the map; use the
  returned ImageData size. `renderNaive(srcRGBA, w, h, newW, newH, out?)` exists (~8 ms on
  1000x650; `drawImage` scaling may be smoother for live "normal resize" frames).
- **handoff.js:** `stashFiles` resolves `true|false` and never rejects; entries expire after
  1 hour. `clearStale(maxAgeMs = 0)` deletes an entry older than that without reading it.
  Any page that imports handoff.js without `?from=home` runs `clearStale(15 s)` when idle
  (and again once a younger entry turns 15 s old), so an interrupted hand-off is not kept. Navigate with `if (await stashFiles(files)) location.href = '/app?from=home'`.
- **Service worker:** pages include `<script src="/sw-register.js?v=__BUILD_ID__" defer></script>`
  (Infra owns `site/sw-register.js`; it shows an "update available" banner).
  The precache (postbuild `isShellFile`) also holds the landing hero's default photo and
  "Watch it think" photo with their `.seams?v=BUILD_ID`, all thumbnails and the gallery;
  other `/assets/landing/` images are network-first with an offline copy, `.seams` cache-first.
- **compare.js** extras: options `labels`, `position`, `ariaLabel`; methods `setPosition`,
  `getPosition`, `setLabels`, `nudge`, `ready`, `element`; accepts URLs, ImageBitmap,
  HTMLImageElement, canvas, ImageData, Blob/File and engine Img. Cap its height with
  `--compare-max-h` on the container.
- **theme.js** extras: `squishlessTheme.toggle()`, `.resolved()`, `data-resolved-theme`,
  `squishless:themechange` event; any `[data-theme-toggle]` button works automatically.
- **Design system files** also include `site/assets/css/styleguide.css`,
  `site/assets/js/styleguide.js`, `site/assets/img/src/` (generators),
  `logo-dark.svg`, `demo-portrait-squishless.jpg`, `demo-portrait-normal.jpg`.
  Read `/styleguide.html` and the class index at the top of `base.css` before writing UI.
- **Avoid `<select>`:** Playwright's WebKit logs a CSP style error for any `<select>`
  under `style-src 'self'`. Use segmented controls, radio groups or a custom listbox.
- **Full-size speed (wasm, Chromium):** 20 MP (5472x3648) to 16:9, 570 rows removed:
  ~39 s on an upscaled sample (was ~100-130 s before updateDP stopped using the builtin
  float min, which is slow on GOARCH=wasm; see engine/fmin_wasm.go). Per seam at 20 MP:
  dp update ~38 ms, seam removal ~14 ms (of which memmove ~10 ms).
- **Measured speed (wasm, Chromium, 1000x650):** resize -350 px 0.5-2 s; seamOrder at 60%
  of width 1-4 s; first worker ready ~0.1-0.2 s; renderOrder frame ~1.5 ms.
  So: live-preview maps are built on a **proxy downscaled to display size** (long edge
  <= ~800 px), and the landing hero uses **precomputed seams** (see below).
- **Faces:** pigo finds no face in `portrait-field.jpg` (sunglasses); it finds faces in
  `sample.jpg` and `city-skyline.jpg`.

## Precomputed hero seams (Landing owns)

`cmd/heroseams` (Go, native) runs `engine.SeamOrder`-equivalent carving on the landing hero
photos at build time and writes compact seam paths to `dist/assets/landing/<name>.seams`
(per seam: start column + one 2-bit step per row in {-1,0,+1}, in the shrinking image's
coordinates). `build-site.sh` calls it (after the wasm build). The landing page rebuilds the
order map in JS (replaying removals with `copyWithin`) and renders with `renderOrder`, so the
hero is interactive before the wasm engine loads.

## Ownership (who edits what)

| Area | Files |
| --- | --- |
| Engine | `engine/`, `cmd/wasm/`, `scripts/build-site.sh` |
| Browser engine | `site/assets/js/{engine,worker,livepreview,handoff,zip}.js` |
| Design system | `site/assets/css/{tokens,base}.css`, `site/assets/fonts/`, `site/assets/img/`, `site/assets/js/compare.js`, `site/styleguide.html` |
| Infra | `vercel.json`, `scripts/serve.mjs`, `site/{sw.js,manifest.webmanifest,404.html,robots.txt}`, `.github/`, `playwright.config.*` |
| App | `site/app/`, `site/assets/js/app/`, `site/assets/css/app.css` |
| Landing | `site/index.html`, `site/assets/js/landing/`, `site/assets/css/landing.css` |

## Build pipeline conventions

- `scripts/build-site.sh` (Engine owns it): find or install Go, take the build lock
  (`.build-lock/`, builds run one at a time), build into `.dist-build-<pid>/` and rename it
  over `dist/` only when complete (servers never see a half-built dist). Steps: copy
  `site/` to the build folder, build `dist/engine/squishless.wasm` (`GOOS=js GOARCH=wasm`,
  `-trimpath -ldflags="-s -w"`), copy the matching `wasm_exec.js` from GOROOT
  (`lib/wasm/` on Go 1.24+, `misc/wasm/` before) to `dist/engine/wasm_exec.js`, compute
  `BUILD_ID` (first 12 hex of the sha256 of the wasm + site files), then run
  `node scripts/postbuild.mjs dist "$BUILD_ID"`.
- `scripts/postbuild.mjs` (Infra owns it): replaces the literal token `__BUILD_ID__` in
  every `dist/**/*.{html,js,css,webmanifest,json}`, writes the service-worker precache
  list, and removes `dist/dev/` when `process.env.VERCEL_ENV === 'production'`.
- Versioned URLs: reference the engine as `/engine/squishless.wasm?v=__BUILD_ID__` and
  `/engine/wasm_exec.js?v=__BUILD_ID__`, and stylesheets/scripts from HTML with
  `?v=__BUILD_ID__`. (Imports between ES modules stay plain relative paths.)
- `site/dev/` holds test harness pages (for Playwright); not linked from the site.

## Fixed asset names (Design system creates them; others reference them)

`/assets/img/logo.svg` (wordmark), `/assets/img/mark.svg` (icon only),
`/assets/img/favicon.svg`, `/assets/img/favicon-32.png`, `/assets/img/apple-touch-icon.png` (180),
`/assets/img/icon-192.png`, `/assets/img/icon-512.png`, `/assets/img/icon-maskable-512.png`,
`/assets/img/og-image.png` (1200x630), `/assets/css/tokens.css`, `/assets/css/base.css`.
Theme: light and dark via `prefers-color-scheme`, overridable with
`<html data-theme="light|dark">`; the choice is stored in `localStorage['squishless-theme']`
and applied by `/assets/js/theme.js` (Design system owns it; load it in `<head>` as a
module-free classic script so there is no flash: `<script src="/assets/js/theme.js?v=__BUILD_ID__"></script>`).

## Build and run

```sh
npm run build    # bash scripts/build-site.sh  -> dist/
npm run serve    # http://127.0.0.1:8787 serving dist/ with production headers
npx playwright test
```
Go: use the latest Go (go.mod minimum applies). On this machine Go is not on PATH:
`export PATH="/c/Users/mrhai/.local/gosdk/go/bin:$PATH"` first.
