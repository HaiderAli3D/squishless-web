// "Watch it think": the same precomputed seams, drawn as glowing paths and peeled away one
// by one, with three captions that light up in step:
//   1. score every pixel (energy map)  2. trace the most boring path  3. remove it, repeat.
import { renderOrder } from '../livepreview.js';
import { loadSeams, loadPixels } from './seams.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (t) => t * t * (3 - 2 * t);

// Timeline (ms)
const T_FADE_IN = 600, T_ENERGY = 1400, T_TRACE = 2700, T_TRACED = 4000, T_BACK = 4700, T_PEEL = 5200;
const PEEL_MS = 5600, HOLD_MS = 1500, SPRING_MS = 800;
const LOOP_MS = T_PEEL + PEEL_MS + HOLD_MS + SPRING_MS;

/** Energy map as a colour image: dark plum (boring) -> raspberry -> butter (busy). */
function energyCanvas(rgba, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  const mag = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w, y0 = y * w, yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const gx = gray[ym + xp] + 2 * gray[y0 + xp] + gray[yp + xp] - gray[ym + xm] - 2 * gray[y0 + xm] - gray[yp + xm];
      const gy = gray[yp + xm] + 2 * gray[yp + x] + gray[yp + xp] - gray[ym + xm] - 2 * gray[ym + x] - gray[ym + xp];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[y0 + x] = m;
      hist[Math.min(255, m >> 2)]++;
    }
  }
  // normalise at the 97th percentile so a few hard edges do not flatten the rest
  let acc = 0, p97 = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= 0.97 * w * h) { p97 = Math.max(1, i); break; }
  }
  const scale = 1 / (p97 * 4);
  const stops = [[42, 7, 22], [120, 14, 60], [255, 61, 110], [255, 224, 138]];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  const d = out.data;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const v = Math.sqrt(clamp01(mag[i] * scale)) * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(v));
    const f = v - j;
    const a = stops[j], b = stops[j + 1];
    d[p] = a[0] + (b[0] - a[0]) * f;
    d[p + 1] = a[1] + (b[1] - a[1]) * f;
    d[p + 2] = a[2] + (b[2] - a[2]) * f;
    d[p + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

export function initThink(root, id = 'lake-canoe', { isBusy = () => false } = {}) {
  const canvas = root.querySelector('.think__canvas');
  const steps = Array.from(root.querySelectorAll('.think__step'));
  const toggle = root.querySelector('.think__toggle');
  const counter = root.querySelector('.think__count');
  const ctx = canvas.getContext('2d');
  let pix = null, data = null, energy = null;
  let playing = !reducedMotion();
  let visible = false;
  let raf = 0;
  let t0 = 0, elapsed = 0, lastNow = 0;
  let loading = null;
  let frameBuf = null; // one pixel buffer reused for every renderOrder frame (no 2 MB garbage per frame)

  function setStep(i) {
    steps.forEach((s, j) => {
      s.classList.toggle('is-active', j === i);
      if (j === i) s.setAttribute('aria-current', 'step');
      else s.removeAttribute('aria-current');
    });
  }

  function seamPath(s, ox, rows, src) {
    const h = data.height;
    ctx.beginPath();
    for (let y = 0; y < rows; y++) {
      const x = ox + src[s * h + y] + 0.5;
      if (y === 0) ctx.moveTo(x, 0);
      ctx.lineTo(x, y + 1);
    }
  }
  function glow(widthScale = 1) {
    const s = canvas.width / 900;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255, 224, 138, 0.38)';
    ctx.lineWidth = 9 * s * widthScale;
    ctx.stroke();
    ctx.strokeStyle = '#fffaf0';
    ctx.lineWidth = 2.6 * s * widthScale;
    ctx.stroke();
  }

  function drawPhoto(k) {
    const w = data.width, h = data.height;
    if (k <= 0) {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(pix.canvas, 0, 0);
      return 0;
    }
    if (!frameBuf || frameBuf.byteLength < w * h * 4) frameBuf = new ArrayBuffer(w * h * 4);
    const ow = w - Math.min(k, data.seams);
    const out = new ImageData(new Uint8ClampedArray(frameBuf, 0, ow * h * 4), ow, h);
    const frame = renderOrder(pix.rgba, w, h, data.order, 'x', k, out);
    const ox = Math.floor((w - frame.width) / 2);
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(frame, ox, 0);
    return ox;
  }

  /** Draws the animation at time t (ms within the loop). */
  function render(t) {
    const w = data.width, h = data.height;
    const peelMax = Math.min(data.seams, Math.round(w * 0.55));
    if (t < T_PEEL) {
      drawPhoto(0);
      // energy cross-fade in, then out again after the trace
      let a = 0;
      if (t >= T_FADE_IN && t < T_TRACED) a = smooth(clamp01((t - T_FADE_IN) / (T_ENERGY - T_FADE_IN)));
      else if (t >= T_TRACED) a = 1 - smooth(clamp01((t - T_TRACED) / (T_BACK - T_TRACED)));
      if (a > 0) {
        ctx.globalAlpha = a;
        ctx.drawImage(energy, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (t >= T_TRACE) {
        const rows = Math.max(1, Math.round(h * smooth(clamp01((t - T_TRACE) / (T_TRACED - T_TRACE - 300)))));
        seamPath(0, 0, rows, data.path);
        glow(1.2);
      }
      setStep(t < T_TRACE ? 0 : 1);
      counter.textContent = '';
      return;
    }
    let k;
    const tp = t - T_PEEL;
    if (tp < PEEL_MS) {
      k = Math.floor(peelMax * Math.pow(tp / PEEL_MS, 2.1));
    } else if (tp < PEEL_MS + HOLD_MS) {
      k = peelMax;
    } else {
      const u = clamp01((tp - PEEL_MS - HOLD_MS) / SPRING_MS);
      k = Math.round(peelMax * (1 - smooth(u)));
    }
    const ox = drawPhoto(k);
    if (tp < PEEL_MS && k < data.seams) {
      seamPath(k, ox, h, data.path);
      glow();
    }
    setStep(2);
    counter.textContent = tp < PEEL_MS + HOLD_MS ? `${k} ${k === 1 ? 'path' : 'paths'} removed, ${w - k} px wide` : '';
  }

  /** Still picture (reduced motion or paused before the first play): many seams at once. */
  function renderStill() {
    drawPhoto(0);
    const n = Math.min(data.seams, 120);
    for (let s = 0; s < n; s += 10) {
      seamPath(s, 0, data.height, data.orig);
      glow(0.55);
    }
    setStep(-1);
    counter.textContent = '';
  }

  function frame(now) {
    raf = 0;
    if (!playing || !visible || document.hidden) {
      lastNow = 0;
      return;
    }
    if (isBusy()) {
      // hold the current frame (and the timeline) while the hero is being dragged
      lastNow = 0;
      raf = requestAnimationFrame(frame);
      return;
    }
    if (lastNow) elapsed += Math.min(100, now - lastNow);
    lastNow = now;
    render(elapsed % LOOP_MS);
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!raf && playing && visible && data) raf = requestAnimationFrame(frame);
  }

  function setPlaying(p) {
    playing = p;
    toggle.querySelector('.think__toggle-label').textContent = p ? 'Pause' : 'Play';
    root.classList.toggle('is-paused', !p);
    if (p) kick();
    else if (data && elapsed === 0) renderStill();
  }

  async function ensureLoaded() {
    if (!loading) {
      loading = Promise.all([loadPixels(`/assets/landing/${id}.jpg`), loadSeams(id)]).then(([p, d]) => {
        pix = p;
        data = d;
        canvas.width = d.width;
        canvas.height = d.height;
        energy = energyCanvas(p.rgba, d.width, d.height);
        root.classList.add('is-live');
        canvas.hidden = false;
        if (playing) kick();
        else renderStill();
      });
      loading.catch((err) => {
        loading = null;
        console.warn('watch it think:', err);
      });
    }
    return loading;
  }

  toggle.addEventListener('click', () => setPlaying(!playing));
  document.addEventListener('visibilitychange', kick);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) ensureLoaded();
      }
    }, { rootMargin: '400px 0px' }).observe(root);
    new IntersectionObserver((entries) => {
      for (const en of entries) visible = en.isIntersecting;
      kick();
    }, { threshold: 0.25 }).observe(canvas);
  } else {
    visible = true;
    ensureLoaded();
  }
  setPlaying(playing);
}
