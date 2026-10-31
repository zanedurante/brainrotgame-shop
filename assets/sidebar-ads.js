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
    for (let i = 0; i < rails.length; i += 1) {
      rails[i].hidden = !visible || failedUnits.has(units[i]) || units[i].dataset.adStatus === 'unfilled';
    }
  };

  const checkPlacementBounds = () => {
    if (!wideScreen.matches || !sdkReady || sdkFailed) return;
    for (let i = 0; i < units.length; i += 1) {
      if (rails[i].hidden || failedUnits.has(units[i])) continue;
      const slot = units[i].getBoundingClientRect();
      const rail = rails[i].getBoundingClientRect();
      const outside = box => box.width > 0 && box.height > 0 && (
        box.left < rail.left - 1 || box.right > rail.right + 1 ||
        box.top < slot.top - 1 || box.bottom > slot.top + 601
      );
      // A blocked or incompletely initialized iframe can keep the browser's default
      // 300px width. Suppress the entire malformed placement; never crop or resize
      // Google's creative, and never refresh it in an attempt to recover.
      if (outside(slot) || [...units[i].querySelectorAll('iframe')].some(frame => outside(frame.getBoundingClientRect()))) {
        failedUnits.add(units[i]);
        rails[i].hidden = true;
      }
    }
  };

  const placementSizes = new ResizeObserver(checkPlacementBounds);
  for (const unit of units) placementSizes.observe(unit);
  const observeFrames = () => {
    for (const unit of units) {
      for (const frame of unit.querySelectorAll('iframe')) placementSizes.observe(frame);
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
        observeFrames();
        checkPlacementBounds();
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

  const placementChanges = new MutationObserver(() => {
    updateVisibility();
    observeFrames();
    checkPlacementBounds();
  });
  for (const unit of units) placementChanges.observe(unit, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-ad-status', 'style', 'width', 'height', 'class'],
  });
  wideScreen.addEventListener('change', () => {
    updateVisibility();
    loadSdk();
    initializeVisibleUnits();
    checkPlacementBounds();
  });
  updateVisibility();
  loadSdk();
})();
