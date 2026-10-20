// Landing page entry (module). Everything here is optional sugar: without JS the page
// still reads fine, the photos show, and the links work.
import { initHero } from './hero.js';
import { initThink } from './think.js';
import { initTry } from './try.js';

function onIdle(fn) {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 300);
}

const hero = document.querySelector('.hero-demo');
const heroApi = hero ? initHero(hero) : null;

const think = document.querySelector('.think');
// The think loop holds still while the visitor drags the hero, so the two renderers do not
// fight over the main thread on slower devices.
if (think) initThink(think, think.dataset.sample || 'lake-canoe', { isBusy: () => !!(heroApi && heroApi.state.dragging) });

const zone = document.querySelector('#try-zone');
if (zone) {
  initTry({
    zone,
    input: document.querySelector('#try-input'),
    pickers: Array.from(document.querySelectorAll('[data-pick-photo]')),
    status: document.querySelector('#try-status'),
  });
}

// Before/after gallery: compare.js sliders, created when they come near the viewport.
// Until then each slot is a focusable placeholder, so a forward Tab pass does not skip
// the sliders: focusing one builds it and hands focus to its slider.
const slots = Array.from(document.querySelectorAll('.gallery__slot'));
if (slots.length) {
  let comparePromise = null;
  const built = new Map(); // slot -> Promise<compare>
  const create = (slot) => {
    if (!built.has(slot)) built.set(slot, build(slot));
    return built.get(slot);
  };
  const build = async (slot) => {
    comparePromise ||= import('../compare.js');
    const { createCompare } = await comparePromise;
    const hadFocus = document.activeElement === slot;
    const cmp = createCompare(slot, {
      before: slot.dataset.before,
      after: slot.dataset.after,
      mode: 'normal',
      position: 50,
      ariaLabel: slot.dataset.label || 'Normal resize compared with Squishless',
    });
    // the slider exists now: the placeholder steps out of the tab order
    slot.removeAttribute('tabindex');
    slot.removeAttribute('role');
    slot.removeAttribute('aria-label');
    if (hadFocus || document.activeElement === slot) {
      const slider = slot.querySelector('[role="slider"]');
      if (slider) slider.focus({ preventScroll: true });
    }
    try {
      await cmp.ready;
    } catch { /* image failed: compare shows its stage colour */ }
    slot.classList.add('is-ready');
    const fallback = slot.querySelector('.gallery__fallback');
    if (fallback) fallback.remove();
    // a little wiggle the first time each one scrolls into view
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setTimeout(() => cmp.nudge && cmp.nudge(), 250);
        }
      }, { threshold: 0.6 });
      io.observe(slot);
    }
    return cmp;
  };
  for (const slot of slots) {
    slot.tabIndex = 0;
    slot.setAttribute('role', 'group');
    slot.setAttribute('aria-label', slot.dataset.label || 'Normal resize compared with Squishless');
    slot.addEventListener('focus', () => create(slot), { once: true });
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.unobserve(e.target);
          create(e.target);
        }
      }
    }, { rootMargin: '300px 0px' });
    slots.forEach((s) => io.observe(s));
  } else {
    onIdle(() => slots.forEach(create));
  }
}
