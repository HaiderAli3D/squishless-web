// Small DOM and timing helpers for the app (no dependencies).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, cls, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (attrs) for (const k in attrs) {
    if (k === 'text') n.textContent = attrs[k];
    else n.setAttribute(k, attrs[k]);
  }
  return n;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

export function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- storage (never throws) ----
export function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
export function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* blocked storage */ }
}

// ---- screen reader announcements ----
let announceTimer = 0;
export function announce(text) {
  const n = document.getElementById('announcer');
  if (!n) return;
  // Clear first so repeating the same message is still read out.
  n.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { n.textContent = text; }, 60);
}

// ---- toasts (base.css .toast) ----
const toastHooks = { place: null, focusFallback: null };
/**
 * place(region): positions the region just before a toast shows.
 * focusFallback(): the element to focus when a toast closes while focus is inside it.
 */
export function setToastHooks(hooks) { Object.assign(toastHooks, hooks); }

export function toast(message, { kind = '', action = null, timeout = 5000, onClose = null } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return () => {};
  if (toastHooks.place) toastHooks.place(region);
  const t = el('div', 'toast' + (kind ? ' toast--' + kind : ''), { role: kind === 'danger' ? 'alert' : 'status' });
  const body = el('div', 'toast__body', { text: message });
  t.appendChild(body);
  let closed = false;
  let timer = 0;
  let hovered = false, focused = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (onClose) onClose();
    clearTimeout(timer);
    const hadFocus = t.contains(document.activeElement);
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), reducedMotion() ? 0 : 260);
    if (hadFocus) {
      const f = toastHooks.focusFallback && toastHooks.focusFallback();
      if (f && typeof f.focus === 'function') f.focus({ preventScroll: true });
    }
  };
  // The timer pauses while the pointer is over the toast or focus is inside it (WCAG 2.2.1).
  const arm = () => {
    clearTimeout(timer);
    if (timeout && !closed && !hovered && !focused) timer = setTimeout(close, timeout);
  };
  t.addEventListener('mouseenter', () => { hovered = true; clearTimeout(timer); });
  t.addEventListener('mouseleave', () => { hovered = false; arm(); });
  t.addEventListener('focusin', () => { focused = true; clearTimeout(timer); });
  t.addEventListener('focusout', (e) => { if (!t.contains(e.relatedTarget)) { focused = false; arm(); } });
  if (action) {
    const b = el('button', 'btn btn--secondary btn--sm toast__action', { type: 'button', text: action.label });
    b.addEventListener('click', () => { close(); action.fn(); });
    t.appendChild(b);
  }
  const x = el('button', 'btn btn--ghost btn--sm btn--icon toast__close', { type: 'button', 'aria-label': 'Dismiss' });
  x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  x.addEventListener('click', close);
  t.appendChild(x);
  t._close = close;
  region.appendChild(t);
  // Keep at most three on screen.
  const all = region.querySelectorAll('.toast:not(.is-leaving)');
  if (all.length > 3) { if (all[0]._close) all[0]._close(); else all[0].remove(); }
  arm();
  return close;
}

// ---- pixels ----

/** A canvas holding an engine Img's pixels. */
export function imgToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  const data = img.rgba instanceof Uint8ClampedArray ? img.rgba : new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength);
  ctx.putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return c;
}

/** Size with the long edge at most `max`, same aspect ratio. */
export function fitLongEdge(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export function formatMP(w, h) {
  const mp = (w * h) / 1e6;
  return (mp >= 10 ? Math.round(mp) : Math.round(mp * 10) / 10) + ' MP';
}

/** Longest file-name stem kept (UTF-8 bytes), so "-WxH.ext" still fits in a 255-byte name. */
const MAX_STEM = 200;

export function baseName(name) {
  let n = String(name || 'photo')
    // Bidi and invisible format characters can disguise the real extension.
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .trim();
  if (n.length * 3 > MAX_STEM) {
    let bytes = 0, out = '';
    for (const ch of n) {
      const b = ch.codePointAt(0) < 0x80 ? 1 : ch.codePointAt(0) < 0x800 ? 2 : ch.codePointAt(0) < 0x10000 ? 3 : 4;
      if (bytes + b > MAX_STEM) break;
      bytes += b;
      out += ch;
    }
    n = out.trim();
  }
  return n || 'photo';
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
