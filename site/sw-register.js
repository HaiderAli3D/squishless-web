/* Registers /sw.js and reports updates. Classic script; include with
     <script src="/sw-register.js?v=__BUILD_ID__" defer></script>
   When a new version is installed and waiting, it dispatches a cancelable
   'squishless:update-available' event on window (detail: { apply }) and sets
   window.squishlessSW.updateAvailable = true. Pages show their own
   "Update available - reload" UI and call window.squishlessSW.applyUpdate().
   If no page handler calls event.preventDefault(), a small default banner is shown
   (opt out with <html data-sw-banner="off">). Nothing ever reloads by itself. */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  var api = {
    updateAvailable: false,
    registration: null,
    applyUpdate: function () {
      var reg = api.registration;
      if (!reg || !reg.waiting) {
        location.reload();
        return;
      }
      api._reloadOnChange = true;
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    },
    _reloadOnChange: false,
  };
  window.squishlessSW = api;

  var hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    // Only reload when the user asked for the update (first install also fires this).
    if (api._reloadOnChange && hadController) {
      api._reloadOnChange = false;
      location.reload();
    }
    hadController = true;
  });

  function showDefaultBanner() {
    if (document.documentElement.getAttribute('data-sw-banner') === 'off') return;
    if (document.getElementById('sw-update-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'sw-update-banner';
    bar.className = 'sw-update-banner';
    bar.setAttribute('role', 'status');
    var s = bar.style; // CSSOM is allowed by the CSP (no inline style attribute)
    s.position = 'fixed';
    s.left = '50%';
    s.bottom = '16px';
    s.transform = 'translateX(-50%)';
    s.zIndex = '2147483000';
    s.display = 'flex';
    s.gap = '12px';
    s.alignItems = 'center';
    s.padding = '10px 14px';
    s.borderRadius = '12px';
    s.font = '14px/1.3 system-ui, sans-serif';
    s.background = 'var(--color-surface-inverse, #1f1f1f)';
    s.color = 'var(--color-text-inverse, #ffffff)';
    s.boxShadow = '0 6px 24px rgba(0,0,0,.25)';
    var text = document.createElement('span');
    text.textContent = 'Update available';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.className = 'btn btn--sm';
    btn.addEventListener('click', function () {
      api.applyUpdate();
    });
    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  function announce() {
    if (api.updateAvailable) return;
    api.updateAvailable = true;
    var ev;
    try {
      ev = new CustomEvent('squishless:update-available', {
        cancelable: true,
        detail: { apply: api.applyUpdate },
      });
    } catch (e) {
      return;
    }
    var notCanceled = window.dispatchEvent(ev);
    if (notCanceled) showDefaultBanner();
  }

  function track(reg) {
    if (!reg) return; // e.g. registration blocked by an automation tool
    api.registration = reg;
    // A version already waiting from an earlier visit.
    if (reg.waiting && navigator.serviceWorker.controller) announce();
    reg.addEventListener('updatefound', function () {
      var sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', function () {
        // installed + an existing controller = an update (not the first install)
        if (sw.state === 'installed' && navigator.serviceWorker.controller) announce();
      });
    });
  }

  function register() {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(function (reg) {
        track(reg);
        // Check for updates when the tab becomes visible again (long-lived app tabs).
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      })
      .catch(function (err) {
        if (window.console) console.warn('Service worker registration failed:', err);
      });
  }

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
})();
