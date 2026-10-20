// Hero demo: drag the photo's right edge and it narrows live with seam carving, or flip to
// "Normal resize" to see the same width squashed. Works before (and without) the wasm
// engine: the seams are precomputed at build time (cmd/heroseams) and rendered with
// livepreview.renderOrder.
import { renderOrder } from '../livepreview.js';
import { loadSeams, loadPixels } from './seams.js';

export const SAMPLES = {
  'portrait-field': {
    alt: 'A woman in sunglasses holding a bunch of daisies in a sunny field',
    carve: 'The field got shorter. She didn’t.',
    normal: 'Same width, normal resize. Poor thing got squeezed.',
  },
  'lake-canoe': {
    alt: 'A woman paddling a canoe on a turquoise lake below a pine forest',
    carve: 'Less lake, same paddler.',
    normal: 'Normal resize: the canoe is now a kayak.',
  },
  'city-skyline': {
    alt: 'A city skyline at sunset, towers along a lake shore',
    carve: 'Fewer blocks, same skyline.',
    normal: 'Normal resize: every tower went on a diet.',
  },
  sample: {
    alt: 'A smiling girl in a knitted sweater in front of a sunny hedge',
    carve: 'Less hedge, same smile.',
    normal: 'Normal resize: that smile got squished.',
  },
};

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// slight overshoot, like the --ease-spring token
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

export function initHero(root) {
  const stage = root.querySelector('.demo-stage');
  const img = root.querySelector('.demo-img');
  const canvas = root.querySelector('.demo-canvas');
  const handle = root.querySelector('.demo-handle');
  const readout = root.querySelector('.demo-readout');
  const tag = root.querySelector('.demo-tag');
  const caption = root.querySelector('.demo-caption');
  const gone = root.querySelector('.demo-gone');
  const ctx = canvas.getContext('2d');
  let frameBuf = null; // one pixel buffer reused for every renderOrder frame (no 2 MB garbage per frame)

  const state = {
    id: root.dataset.sample || 'portrait-field',
    mode: 'carve',
    frac: 1, // kept fraction of the width, minFrac..1
    minFrac: 0.38,
    data: null, // decoded seams for state.id
    pix: null, // { img, rgba, width, height } for state.id
    interacted: false,
    dragging: false,
    raf: 0,
    anim: 0, // rAF id of a tween/autoplay
    visible: true,
    token: 0,
  };

  // ---------- rendering ----------
  function width() {
    return state.data ? state.data.width : img.naturalWidth || Number(img.getAttribute('width'));
  }
  function seamsK() {
    const w = width();
    let k = Math.round(w * (1 - state.frac));
    if (state.data) k = Math.min(k, state.data.seams);
    return Math.max(0, k);
  }

  function draw() {
    state.raf = 0;
    const w = width();
    const k = seamsK();
    const pct = ((w - k) / w) * 100;
    stage.style.setProperty('--demo-frac', pct.toFixed(3) + '%');
    stage.dataset.width = String(w - k);
    readout.textContent = `${w - k} px`;
    const pctRound = Math.round(pct);
    handle.setAttribute('aria-valuenow', String(pctRound));
    handle.setAttribute('aria-valuetext', `${pctRound}% of the width, ${w - k} of ${w} pixels`);
    if (gone) {
      gone.textContent = `−${100 - pctRound}%`;
      gone.classList.toggle('is-shown', pct < 84);
    }
    const { pix, data } = state;
    if (!pix) return;
    if (canvas.width !== pix.width || canvas.height !== pix.height) {
      canvas.width = pix.width;
      canvas.height = pix.height;
    }
    const h = pix.height;
    if (state.mode === 'normal' || !data) {
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(pix.canvas, 0, 0, w, h, 0, 0, w - k, h);
    } else {
      if (!frameBuf || frameBuf.byteLength < w * h * 4) frameBuf = new ArrayBuffer(w * h * 4);
      const out = new ImageData(new Uint8ClampedArray(frameBuf, 0, (w - k) * h * 4), w - k, h);
      const frame = renderOrder(pix.rgba, w, h, data.order, 'x', k, out);
      ctx.putImageData(frame, 0, 0);
      if (k > 0) ctx.clearRect(frame.width, 0, w - frame.width, h);
    }
    if (!stage.classList.contains('is-live')) {
      stage.classList.add('is-live');
      canvas.hidden = false;
    }
    stage.dataset.mode = state.mode;
    stage.dataset.ready = data && state.mode === 'carve' ? 'carve' : state.mode === 'normal' ? 'normal' : 'loading';
  }
  function schedule() {
    if (!state.raf) state.raf = requestAnimationFrame(draw);
  }
  function setFrac(f) {
    state.frac = Math.min(1, Math.max(state.minFrac, f));
    schedule();
  }

  // ---------- loading a sample ----------
  async function load(id) {
    const token = ++state.token;
    state.id = id;
    stage.dataset.sample = id;
    stage.classList.add('is-loading');
    const src = `/assets/landing/${id}.jpg`;
    const pixP = loadPixels(src, img.getAttribute('src') === src ? img : null);
    const dataP = loadSeams(id);
    try {
      const pix = await pixP;
      if (token !== state.token) return;
      state.pix = pix;
      state.data = null;
      if (img.getAttribute('src') !== src) {
        img.src = src;
        if (SAMPLES[id]) img.alt = SAMPLES[id].alt;
      }
      schedule();
      const data = await dataP;
      if (token !== state.token) return;
      if (data.width !== pix.width || data.height !== pix.height) throw new Error('hero: seams do not match the photo');
      state.data = data;
      state.minFrac = (data.width - data.seams) / data.width;
      handle.setAttribute('aria-valuemin', String(Math.ceil(state.minFrac * 100)));
      stage.classList.remove('is-loading');
      setCaption();
      schedule();
    } catch (err) {
      if (token !== state.token) return;
      stage.classList.remove('is-loading');
      stage.classList.add('is-failed');
      console.warn('hero demo:', err);
    }
  }

  function setCaption() {
    const c = SAMPLES[state.id];
    if (c && caption) caption.textContent = state.mode === 'normal' ? c.normal : c.carve;
    if (tag) tag.textContent = state.mode === 'normal' ? 'Normal resize' : 'Squishless';
  }

  // ---------- motion ----------
  function stopAnim() {
    if (state.anim) cancelAnimationFrame(state.anim);
    state.anim = 0;
    stage.classList.remove('is-auto');
  }
  function tweenTo(to, ms = 520) {
    stopAnim();
    if (reducedMotion()) return setFrac(to);
    const from = state.frac;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      setFrac(from + (to - from) * easeOutBack(t));
      state.anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    state.anim = requestAnimationFrame(step);
  }

  // A gentle squeeze-and-release, twice, ending part-way in; stops on any interaction.
  function autoplay() {
    if (state.interacted || reducedMotion()) return;
    stopAnim();
    stage.classList.add('is-auto');
    const low = 0.52;
    const rest = 0.64;
    const keys = [
      // [time ms, frac] with ease-in-out between keys
      [0, 1], [1700, low], [2500, low], [3800, 1], [4600, 1], [6300, low], [7100, low], [8200, rest],
    ];
    const end = keys[keys.length - 1][0];
    let t0 = 0;
    let paused = 0;
    let last = 0;
    const step = (now) => {
      if (!t0) t0 = now;
      if (!state.visible || document.hidden) {
        // freeze the timeline while off screen
        paused += now - (last || now);
      }
      last = now;
      const t = now - t0 - paused;
      if (t >= end) {
        setFrac(rest);
        state.anim = 0;
        stage.classList.remove('is-auto');
        return;
      }
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1][0] <= t) i++;
      const [ta, fa] = keys[i];
      const [tb, fb] = keys[i + 1];
      const u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 1;
      setFrac(fa + (fb - fa) * easeInOut(u));
      state.anim = requestAnimationFrame(step);
    };
    state.anim = requestAnimationFrame(step);
  }

  function interacted() {
    if (!state.interacted) {
      state.interacted = true;
      stage.classList.add('is-touched');
    }
    stopAnim();
  }

  // ---------- pointer ----------
  let grabOffset = 0;
  function fracAt(clientX) {
    const r = stage.getBoundingClientRect();
    return (clientX - grabOffset - r.left) / r.width;
  }
  // Touch on the photo itself (not the handle) only starts a drag once the finger
  // clearly moves sideways, so swiping over the photo still scrolls the page.
  let pending = null; // { id, x, y } for a touch that has not decided yet
  function startDrag(e, onHandle) {
    interacted();
    state.dragging = true;
    stage.classList.add('is-dragging');
    const r = stage.getBoundingClientRect();
    const edge = r.left + r.width * ((width() - seamsK()) / width());
    // grabbing the handle keeps it under the pointer; elsewhere the edge jumps there
    grabOffset = onHandle ? e.clientX - edge : 0;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    if (!onHandle) setFrac(fracAt(e.clientX));
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const onHandle = handle.contains(e.target);
    if (e.pointerType === 'touch' && !onHandle) {
      pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    startDrag(e, onHandle);
    handle.focus({ preventScroll: true });
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (pending && e.pointerId === pending.id) {
      const dx = Math.abs(e.clientX - pending.x);
      const dy = Math.abs(e.clientY - pending.y);
      if (dx > 8 && dx > dy) {
        pending = null;
        startDrag(e, false);
      } else if (dy > 8) {
        pending = null;
      }
      return;
    }
    if (!state.dragging) return;
    setFrac(fracAt(e.clientX));
  });
  const end = () => {
    pending = null;
    state.dragging = false;
    stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', end);

  // ---------- keyboard ----------
  handle.addEventListener('keydown', (e) => {
    const steps = { ArrowLeft: -0.01, ArrowDown: -0.01, ArrowRight: 0.01, ArrowUp: 0.01, PageDown: -0.1, PageUp: 0.1 };
    let f = null;
    if (e.key in steps) f = state.frac + steps[e.key] * (e.shiftKey ? 5 : 1);
    else if (e.key === 'Home') f = state.minFrac;
    else if (e.key === 'End') f = 1;
    if (f === null) return;
    e.preventDefault();
    interacted();
    setFrac(f);
  });

  // ---------- controls ----------
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'demo-mode') {
      interacted();
      state.mode = t.value === 'normal' ? 'normal' : 'carve';
      setCaption();
      if (state.frac > 0.9) tweenTo(0.6);
      stage.classList.remove('is-boing');
      void stage.offsetWidth; // restart the animation
      if (state.mode === 'normal') stage.classList.add('is-boing');
      schedule();
    } else if (t.name === 'demo-sample') {
      interacted();
      load(t.value);
    }
  });
  stage.addEventListener('animationend', () => stage.classList.remove('is-boing'));

  // ---------- visibility ----------
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const en of entries) state.visible = en.isIntersecting;
    }).observe(stage);
  }

  // ---------- go ----------
  setCaption();
  schedule();
  load(state.id).then(() => {
    if (reducedMotion()) {
      if (!state.interacted) setFrac(0.6);
      return;
    }
    setTimeout(() => {
      if (!state.interacted) autoplay();
    }, 500);
  });

  return {
    state,
    setMode(m) {
      const input = root.querySelector(`input[name="demo-mode"][value="${m}"]`);
      if (input) input.click();
    },
  };
}
