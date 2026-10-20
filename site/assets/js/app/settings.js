// App settings: presets, custom size, carving options, export format.
// Remembered in localStorage (wrapped so blocked storage never breaks the app).

import { loadJSON, saveJSON, clamp } from './util.js';

const KEY = 'squishless-app-settings-v1';

/** Size presets by purpose. ratio = width / height; null = keep the photo's own size. */
export const PRESETS = [
  { id: 'original', name: 'Original', use: 'No change', ratio: null },
  { id: 'square', name: 'Square', use: 'Profiles', ratio: 1, label: '1:1' },
  { id: 'portrait', name: 'Portrait', use: 'Posts', ratio: 4 / 5, label: '4:5' },
  { id: 'story', name: 'Story', use: 'Stories', ratio: 9 / 16, label: '9:16' },
  { id: 'landscape', name: 'Landscape', use: 'Prints', ratio: 3 / 2, label: '3:2' },
  { id: 'wide', name: 'Wide', use: 'Screens', ratio: 16 / 9, label: '16:9' },
  { id: 'banner', name: 'Banner', use: 'Headers', ratio: 3, label: '3:1' },
  { id: 'custom', name: 'Custom', use: 'Pixels, percent', ratio: null },
];

export const FINE_DEFAULTS = Object.freeze({ faces: true, blur: 2, sobel: 0 });

export const DEFAULTS = Object.freeze({
  preset: 'original',
  custom: { mode: 'px', w: 1080, h: 1080, lock: false, pw: 75, ph: 100, fw: 1080, fh: 1080 },
  ...FINE_DEFAULTS,
  format: 'same',
  quality: 90,
  brush: 48,
});

/** Largest enlargement the app offers per side (the engine allows 4x). */
export const MAX_GROW = 2;

function sanitize(s) {
  const d = DEFAULTS;
  const out = { ...d, custom: { ...d.custom } };
  if (!s || typeof s !== 'object') return out;
  if (PRESETS.some((p) => p.id === s.preset)) out.preset = s.preset;
  const c = s.custom || {};
  if (['px', 'percent', 'width', 'height'].includes(c.mode)) out.custom.mode = c.mode;
  const int = (v, lo, hi, def) => (Number.isFinite(+v) ? clamp(Math.round(+v), lo, hi) : def);
  out.custom.w = int(c.w, 1, 30000, d.custom.w);
  out.custom.h = int(c.h, 1, 30000, d.custom.h);
  out.custom.fw = int(c.fw, 1, 30000, d.custom.fw);
  out.custom.fh = int(c.fh, 1, 30000, d.custom.fh);
  out.custom.pw = int(c.pw, 5, 200, d.custom.pw);
  out.custom.ph = int(c.ph, 5, 200, d.custom.ph);
  out.custom.lock = !!c.lock;
  if (typeof s.faces === 'boolean') out.faces = s.faces;
  out.blur = int(s.blur, 0, 7, d.blur);
  out.sobel = int(s.sobel, 0, 64, d.sobel);
  if (['same', 'jpeg', 'png', 'webp'].includes(s.format)) out.format = s.format;
  out.quality = int(s.quality, 40, 100, d.quality);
  out.brush = int(s.brush, 8, 160, d.brush);
  return out;
}

export function loadSettings() {
  return sanitize(loadJSON(KEY, null));
}

export function saveSettings(s) {
  saveJSON(KEY, s);
}

/** Carving options passed to the engine (and part of every cache key). */
export function carveOpts(s) {
  return { faces: !!s.faces, blur: s.blur, sobel: s.sobel };
}
export function carveSig(s) {
  return `${s.faces ? 1 : 0}|${s.blur}|${s.sobel}`;
}

/** Limits for a target of a W x H photo. */
export function sizeLimits(W, H, maxPixels) {
  return {
    minW: Math.max(8, Math.round(W * 0.1)),
    minH: Math.max(8, Math.round(H * 0.1)),
    maxW: W * MAX_GROW,
    maxH: H * MAX_GROW,
    maxPixels,
  };
}

/** Clamps a target to the limits; also keeps w*h under maxPixels. */
export function clampTarget(W, H, w, h, maxPixels) {
  const L = sizeLimits(W, H, maxPixels);
  let cw = clamp(Math.round(w) || W, L.minW, L.maxW);
  let ch = clamp(Math.round(h) || H, L.minH, L.maxH);
  if (cw * ch > maxPixels) {
    const s = Math.sqrt(maxPixels / (cw * ch));
    cw = Math.max(L.minW, Math.floor(cw * s));
    ch = Math.max(L.minH, Math.floor(ch * s));
  }
  return { w: cw, h: ch, clamped: cw !== Math.round(w) || ch !== Math.round(h) };
}

/** Target size of a W x H photo for the batch settings (ignores per-photo overrides). */
export function batchTarget(W, H, s, maxPixels) {
  let w = W, h = H;
  const p = PRESETS.find((x) => x.id === s.preset) || PRESETS[0];
  if (p.ratio) {
    // Keep as much of the photo as possible: shrink only the side that is too long.
    if (W / H > p.ratio) { h = H; w = Math.round(H * p.ratio); }
    else { w = W; h = Math.round(W / p.ratio); }
  } else if (p.id === 'custom') {
    const c = s.custom;
    switch (c.mode) {
      case 'percent': w = Math.round(W * c.pw / 100); h = Math.round(H * c.ph / 100); break;
      case 'width': w = c.fw; h = H; break;
      case 'height': w = W; h = c.fh; break;
      default: w = c.w; h = c.h;
    }
  }
  return clampTarget(W, H, w, h, maxPixels);
}
