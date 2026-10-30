(() => {
  'use strict';

  // Only the portal homepage participates; the alias, games and local previews do not.
  if (location.origin !== 'https://gameslop.now' || !['/', '/index.html'].includes(location.pathname)) return;
  if (document.documentElement.dataset.sidebarAdsBooted) return;
  document.documentElement.dataset.sidebarAdsBooted = 'true';

  const wideScreen = matchMedia('(min-width: 1536px) and (hover: hover) and (pointer: fine)');
  const rails = [...document.querySelectorAll('[data-sidebar-ad]')];
  const units = rails.map(rail => rail.querySelector('.adsbygoogle'));
  if (units.length !== 2 || units.some(unit => !unit || !/^\d+$/.test(unit.dataset.adSlot || ''))) return;

  const initialized = new WeakSet();
  const failedUnits = new WeakSet();
  let sdkRequested = false;
  let sdkReady = false;
  let sdkFailed = false;

  const updateVisibility = () => {
    const visible = wideScreen.matches && sdkReady && !sdkFailed;
    document.body.classList.toggle('has-sidebar-ads', visible);
    for (let i = 0; i < rails.length; i += 1) {
      rails[i].hidden = !visible || failedUnits.has(units[i]) || units[i].dataset.adStatus === 'unfilled';
    }
  };

  const initializeVisibleUnits = () => {
    if (!sdkReady || sdkFailed || !wideScreen.matches) return;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      if (initialized.has(unit) || rails[i].hidden || unit.getBoundingClientRect().width === 0) continue;
      // Queue exactly once per placement, including when the viewport is resized.
      initialized.add(unit);
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        failedUnits.add(unit);
        rails[i].hidden = true;
      }
    }
  };

  const loadSdk = () => {
    if (sdkRequested || sdkFailed || !wideScreen.matches) return;
    sdkRequested = true;
    const sdk = document.createElement('script');
    sdk.async = true;
    sdk.crossOrigin = 'anonymous';
    sdk.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3292344753796518';
    sdk.dataset.gameslopAdsense = 'true';
    sdk.addEventListener('load', () => {
      sdkReady = true;
      updateVisibility();
      initializeVisibleUnits();
    }, { once: true });
    sdk.addEventListener('error', () => {
      sdkFailed = true;
      updateVisibility();
    }, { once: true });
    // Google's published consent messages and TCF processing are delivered by this SDK.
    // Do not substitute a timer, an assumed consent choice or a home-grown consent gate.
    document.head.append(sdk);
  };

  new MutationObserver(updateVisibility).observe(document.querySelector('.portal-layout'), {
    subtree: true, attributes: true, attributeFilter: ['data-ad-status'],
  });
  wideScreen.addEventListener('change', () => {
    updateVisibility();
    loadSdk();
    initializeVisibleUnits();
  });
  updateVisibility();
  loadSdk();
})();
