# How Squishless is built

This is a guided tour of the code for people who want to understand it, fix something or
add a feature. The detailed contract between the parts (every function signature and
who owns which file) is in [ARCHITECTURE.md](../ARCHITECTURE.md) at the repo root. If the
two disagree, ARCHITECTURE.md wins.

## The big picture

Squishless is a **static website with no backend**. All the image work happens in the
visitor's browser:

```
                       your browser
 ┌──────────────────────────────────────────────────────────────┐
 │  page (main thread)                 Web Workers (2-3)         │
 │  ┌─────────────────────┐  messages  ┌──────────────────────┐  │
 │  │ app / landing UI    │ ─────────▶ │ worker.js            │  │
 │  │ engine.js (pool,    │ ◀───────── │  wasm_exec.js        │  │
 │  │  decode, encode)    │  progress, │  squishless.wasm (Go)│  │
 │  │ livepreview.js      │  results   └──────────────────────┘  │
 │  └─────────────────────┘                                      │
 └──────────────────────────────────────────────────────────────┘
           ▲ static files only (HTML, CSS, JS, .wasm, fonts)
           │
      Vercel (or any static host)
```

The server only hands out files. Photos are never sent anywhere, and the Content Security
Policy blocks requests to any other site, so the page couldn't send them even by mistake.

## The parts

### 1. The Go engine (`engine/`)

Plain Go with one dependency for face detection (esimov/pigo). It does three things:

- **`Resize`**: carve a photo to an exact width and height. Shrinking removes the
  lowest-energy seams; enlarging duplicates them. When both sides change in the same
  direction, the photo is first scaled proportionally and then carved on one axis.
- **`SeamOrder`**: for every pixel, the step at which it *would* be removed when the photo
  shrinks along one axis. This is what makes the live preview possible (see below). A
  test checks that keeping the pixels with order >= k gives exactly the same image as
  `Resize` to size minus k.
- **Faces and masks**: detected faces and "Keep" brush strokes get a big energy bonus so
  seams avoid them; "Remove" strokes get a big penalty so seams go through them first.

The engine runs natively too, so `go test ./...` tests it on your machine.

### 2. WebAssembly (`cmd/wasm/`)

`cmd/wasm/main.go` compiles the engine with `GOOS=js GOARCH=wasm` and exposes a small
`squishless` object inside a worker with `resize(...)` and `seamOrder(...)`. Pixels go in
and out as raw RGBA bytes, so no image formats are involved on the Go side. A short
`glue.js` (appended to Go's `wasm_exec.js` at build time) turns Go errors into real
JavaScript `Error`s.

The engine is about 3.6 MB raw and 0.95 MB with brotli compression, which is what
browsers actually download.

### 3. The browser engine (`site/assets/js/engine.js`, `worker.js`)

`engine.js` is the only module the pages talk to. It:

- **decodes** photos with `createImageBitmap` (which also applies camera rotation from EXIF)
  and reads their pixels;
- runs a **pool of workers** (2 on phones, up to 3 on desktops), each with its own copy of
  the wasm engine, and starts them lazily;
- **schedules jobs** so the photos being processed at once stay within a pixel budget
  (36 MP on desktop, 12.5 MP on phones). Queueing a whole batch is safe, and small jobs can
  start ahead of a big one that is waiting;
- **cancels** a job by stopping its worker and starting a fresh one (a running Go call
  can't be interrupted otherwise);
- **encodes** results to JPG, PNG or WebP with a canvas, which also drops all metadata;
- enforces the **size limits**: 24 MP on desktop and 12 MP on phones. Bigger photos are
  rejected with a `TOO_BIG` code, and the app offers `downscale()` instead.

### 4. The live preview (`site/assets/js/livepreview.js`)

Running the real engine on every mouse move would be far too slow (a resize takes about
half a second even for a small photo). Instead, when you start dragging, the app asks for a
**seam-order map** of a small copy of the photo (long edge about 800 px). From then on,
showing any width is pure arithmetic: in each row, keep the pixels whose order is at least
k. `renderOrder()` does that in about 1.5 ms per frame. To preview enlarging, it
duplicates the pixels that would be removed first, which is close to (but not exactly) what
the real enlarge does. When you let go, the exact result is computed with `resize()` and
swapped in.

### 5. The landing page demo (`cmd/heroseams/`, `site/assets/js/landing/`)

The landing page's hero has to be draggable straight away, before the 1 MB engine has
loaded. So at **build time**, `cmd/heroseams` runs the engine natively on the hero photos
and saves the removed seams in a compact file (`<name>.seams`: a start column plus one
2-bit step per row for each seam). In the browser, a few lines of JavaScript rebuild the
seam-order map from that file and use the same `renderOrder()`. The tool also renders the
before/after gallery images.

### 6. The pages (`site/`)

- `index.html` (landing) and `app/index.html` (the app) are plain HTML. Behaviour is in
  ES modules under `assets/js/landing/` and `assets/js/app/`. There is no framework, no
  bundler and no npm runtime dependency.
- The **design system** lives in `assets/css/tokens.css` (colours, spacing, type) and
  `assets/css/base.css` (components). `/styleguide.html` shows every component, and the
  top of `base.css` has an index of its classes. Shared widgets include `compare.js`
  (the before/after slider) and `theme.js` (light/dark).
- `handoff.js` passes photos dropped on the landing page to the app through IndexedDB.
  They are deleted as soon as the app reads them, or after a short time if it never does.
- `zip.js` writes the "Download all" ZIP in the browser.

### 7. Offline support (`site/sw.js`)

A service worker caches the site's files (the "app shell", the landing demo photos and
their seams) when you first visit, and the engine and sample photos when they are first
used. After that, the site works without a connection. When a new version is deployed,
a small banner offers to reload.

## Rules that keep it private and safe

- **No requests to other sites.** Fonts are self-hosted; there is no analytics and no CDN.
- **Strict Content Security Policy**, set in `vercel.json` and mirrored by the local server:

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' blob: data:;
  font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'none';
  frame-ancestors 'none'
  ```

  In practice this means: no inline `<script>` or `style="..."` attributes in HTML and no
  `eval`. Setting `element.style.x` from JavaScript is fine. `'wasm-unsafe-eval'` is the
  one exception, and it is needed to compile WebAssembly.
- **No `<select>` elements.** WebKit logs CSP errors for them under this policy, so the UI
  uses segmented controls and radio groups instead.

## The build (`scripts/build-site.sh`)

`npm run build` runs `scripts/build-site.sh`, which:

1. finds Go (or, on Linux x64 such as Vercel, downloads a pinned, checksum-verified release);
2. copies `site/` into a temporary build folder;
3. builds `engine/squishless.wasm` and copies the matching `wasm_exec.js` (plus `glue.js`);
4. runs `cmd/heroseams` to make the landing demo data;
5. computes a `BUILD_ID` (a hash of the engine and site files) and runs
   `scripts/postbuild.mjs`, which writes it into every `?v=__BUILD_ID__` URL and fills the
   service worker's precache list. Production builds on Vercel also drop the `dev/` test
   pages;
6. swaps the finished folder in as `dist/`. Builds take turns using a lock folder, so a
   server reading `dist/` never sees a half-built site.

Because every engine, script and stylesheet URL carries the `BUILD_ID`, those files can be
cached for a year while pages themselves always revalidate.

## Measured speed

In Chromium, the wasm engine is about 4 to 7 times slower than native Go.

| Task | Time |
| --- | --- |
| First worker ready | 0.1 to 0.2 s |
| Resize 1000 × 650 by -350 px | 0.5 to 2 s |
| Seam-order map at 60% of the width, 1000 × 650 | 1 to 4 s |
| One live-preview frame (`renderOrder`) | about 1.5 ms |
| 20 MP photo (5472 × 3648) to 16:9, 570 rows removed | about 39 s |

At 20 MP, each seam costs about 38 ms to update the energy table and 14 ms to remove. An
early version took 100 to 130 s for the 20 MP case; most of the win came from replacing
Go's built-in `min` for floats, which is slow under WebAssembly
(see `engine/fmin_wasm.go`).

## Tests

| Command | What it checks |
| --- | --- |
| `go test ./...` | The engine (including the seam-order invariant) and `cmd/heroseams` |
| `node scripts/wasm-smoke.mjs` | The built `.wasm` loads in Node and returns correct sizes, progress and errors |
| `npx playwright test` | The landing page and the app end to end, in Chromium, Firefox, WebKit, and Pixel 7 / iPhone 14 emulation: drag, presets, compare, brush, batch and ZIP, cancel, too-big photos, offline |
