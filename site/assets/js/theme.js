/*
 * Squishless theme switcher (classic script, not a module).
 *
 * Load it in <head>, before the stylesheets, so the stored theme applies
 * before first paint (no flash):
 *   <script src="/assets/js/theme.js?v=__BUILD_ID__"></script>
 *
 * Preference: 'light' | 'dark' | 'system' (default), stored in
 * localStorage['squishless-theme']. 'light'/'dark' set <html data-theme>;
 * 'system' removes it so tokens.css follows prefers-color-scheme.
 * <html data-resolved-theme="light|dark"> is always set (handy for icons).
 *
 * API:
 *   squishlessTheme.get()        -> 'light' | 'dark' | 'system'
 *   squishlessTheme.resolved()   -> 'light' | 'dark' (what is showing now)
 *   squishlessTheme.set(pref)    -> stores and applies
 *   squishlessTheme.toggle()     -> flips between light and dark (stores it)
 * Event: document dispatches 'squishless:themechange' with
 *   detail { preference, resolved } whenever either changes.
 *
 * Toggle button, no extra JS needed: any element with [data-theme-toggle]
 * flips the theme on click and gets aria-pressed (true = dark) and an
 * aria-label kept up to date. Markup in /styleguide.html.
 */
(function () {
  'use strict';
  var KEY = 'squishless-theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function write(pref) {
    try {
      if (pref === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, pref);
    } catch (e) { /* storage blocked: the choice lasts for this page only */ }
  }

  var pref = read();

  function resolved() {
    if (pref === 'light' || pref === 'dark') return pref;
    return mq && mq.matches ? 'dark' : 'light';
  }

  function syncToggles(res) {
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', res === 'dark' ? 'true' : 'false');
      btns[i].setAttribute('aria-label', res === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  function apply() {
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
    else root.removeAttribute('data-theme');
    var res = resolved();
    root.setAttribute('data-resolved-theme', res);
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', res === 'dark' ? '#1a1216' : '#fdf6f4');
    syncToggles(res);
    try {
      document.dispatchEvent(new CustomEvent('squishless:themechange', { detail: { preference: pref, resolved: res } }));
    } catch (e) { /* very old browsers */ }
  }

  function set(next) {
    if (next !== 'light' && next !== 'dark' && next !== 'system') return;
    pref = next;
    write(next);
    apply();
  }

  apply();

  if (mq) {
    var onChange = function () { if (pref === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // Another tab changed the theme
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { pref = read(); apply(); }
  });

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-theme-toggle]') : null;
    if (t) set(resolved() === 'dark' ? 'light' : 'dark');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { syncToggles(resolved()); });
  }

  window.squishlessTheme = {
    get: function () { return pref; },
    resolved: resolved,
    set: set,
    toggle: function () { set(resolved() === 'dark' ? 'light' : 'dark'); }
  };
})();
