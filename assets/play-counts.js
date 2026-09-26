(() => {
  'use strict';

  const grid = document.querySelector('.grid');
  if (!grid) return;
  const cards = [...grid.querySelectorAll('.card[data-game]')].map((element, order) => ({
    element,
    order,
    slug: element.dataset.game,
    label: element.querySelector('[data-play-count]'),
  }));
  const rankingTitle = document.getElementById('ranking-title');
  const rankingNote = document.getElementById('ranking-note');
  const sortControl = document.getElementById('sort-order');
  const formatter = new Intl.NumberFormat(document.documentElement.lang || 'en');
  const dateFormatter = new Intl.DateTimeFormat(document.documentElement.lang || 'en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const sortModes = ['plays', 'updated', 'trending'];
  const storageKey = 'gameslop-sort-order';
  const week = 7 * 24 * 60 * 60 * 1000;
  let selectedSort = 'plays';
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (sortModes.includes(saved)) selectedSort = saved;
  } catch { /* Sorting also works when browser storage is unavailable. */ }
  if (sortControl) sortControl.value = selectedSort;
  let counts = null;
  let weeklyCounts = null;
  let lastUpdated = null;
  let trackingStartedAt = null;
  let latestAsOf = null;
  let acceptedRequest = 0;
  let requestNumber = 0;
  let latestRead = 0;
  let refreshFailed = false;
  let pendingRender = false;
  let refreshTimer;
  const pressedPointers = new Set();
  const pressedKeys = new Set();

  // Finish a click/keypress before moving its target, but never lock the ranking
  // for the rest of the visit just because a card was hovered or focused.
  const isCardEvent = event => event.target instanceof Element && event.target.closest('.card[data-game]');
  grid.addEventListener('pointerdown', event => {
    if (isCardEvent(event)) pressedPointers.add(event.pointerId);
  }, { passive: true });
  grid.addEventListener('keydown', event => {
    if (isCardEvent(event) && ['Enter', ' '].includes(event.key)) pressedKeys.add(event.key);
  });
  const finishPointer = event => setTimeout(() => {
    pressedPointers.delete(event.pointerId);
    flushRender();
  }, 0);
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, finishPointer, { passive: true });
  window.addEventListener('keyup', event => setTimeout(() => {
    pressedKeys.delete(event.key);
    flushRender();
  }, 0));
  const clearGesture = () => {
    pressedPointers.clear();
    pressedKeys.clear();
  };
  window.addEventListener('blur', () => { clearGesture(); flushRender(); });

  function flushRender() {
    if (pendingRender) render();
    else rankCards();
  }

  function parseCountMap(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const values = {};
    for (const { slug } of cards) {
      const value = source[slug];
      if (!Number.isSafeInteger(value) || value < 0) return null;
      values[slug] = value;
    }
    return values;
  }

  function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function parseUpdateMap(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    return Object.fromEntries(cards.map(({ slug }) => [slug, parseDate(source[slug])]));
  }

  function effectiveSort() {
    if (selectedSort === 'trending' && weeklyCounts) return 'trending';
    if (selectedSort === 'updated' && lastUpdated && cards.some(({ slug }) => lastUpdated[slug] !== null)) return 'updated';
    return 'plays';
  }

  function displayStatus() {
    if (pressedPointers.size || pressedKeys.size) { pendingRender = true; return; }
    const mode = effectiveSort();
    if (rankingTitle) rankingTitle.textContent = !counts ? 'All games' : { plays: 'Most played', updated: 'Recently updated', trending: 'Trending' }[mode];
    if (!rankingNote) return;
    if (!counts) {
      rankingNote.textContent = refreshFailed ? 'Play counts unavailable' : 'Loading game statistics…';
      return;
    }
    const notes = [];
    if (selectedSort !== mode) {
      notes.push(`${selectedSort === 'trending' ? 'Weekly plays' : 'Update dates'} unavailable. Showing lifetime play order.`);
    } else if (mode === 'trending') {
      notes.push('Play clicks in the last 7 days.');
      if (trackingStartedAt !== null && latestAsOf !== null && latestAsOf - trackingStartedAt < week) {
        notes.push(`Weekly tracking started ${dateFormatter.format(trackingStartedAt)}; earlier clicks aren’t included.`);
      }
    } else if (mode === 'updated') {
      notes.push('Newest game updates first; unknown dates appear last.');
    }
    if (refreshFailed) notes.push('Couldn’t refresh; showing last loaded data.');
    rankingNote.textContent = notes.join(' ');
  }

  function rankCards() {
    if (!counts || pressedPointers.size || pressedKeys.size) return;
    const mode = effectiveSort();
    const value = slug => mode === 'trending' ? weeklyCounts[slug] : mode === 'updated' ? (lastUpdated[slug] ?? -Infinity) : counts[slug];
    const ordered = [...cards].sort((left, right) => value(right.slug) - value(left.slug) || left.order - right.order);
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    for (const [index, { element }] of ordered.entries()) {
      if (grid.children[index] !== element) grid.insertBefore(element, grid.children[index] ?? null);
    }
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  function render() {
    // Even a helper line disappearing can move a held pointer's link. Defer all
    // layout-changing updates until its click has finished, not just card order.
    if (pressedPointers.size || pressedKeys.size) { pendingRender = true; return; }
    pendingRender = false;
    for (const { slug, label } of cards) {
      if (!label) continue;
      if (!counts) {
        label.textContent = 'Play count unavailable';
        continue;
      }
      const number = document.createElement('span');
      number.className = 'count-value';
      number.textContent = formatter.format(counts[slug]);
      label.replaceChildren(number, document.createTextNode(counts[slug] === 1 ? ' play' : ' plays'));
      label.title = 'Lifetime shared play clicks';
      if (selectedSort !== 'plays') {
        const detail = document.createElement('span');
        detail.className = 'count-detail';
        if (selectedSort === 'trending') {
          detail.textContent = weeklyCounts ? `${formatter.format(weeklyCounts[slug])} in the last 7 days` : 'Weekly plays unavailable';
        } else {
          const updated = lastUpdated?.[slug];
          detail.textContent = updated == null ? 'Update date unavailable' : `Updated ${dateFormatter.format(updated)}`;
          if (updated != null) detail.title = new Date(updated).toISOString();
        }
        label.append(detail);
      }
    }
    rankCards();
    displayStatus();
  }

  function acceptSnapshot(payload, serial) {
    const values = parseCountMap(payload?.counts);
    if (!values) throw new Error('Invalid play totals');
    const asOf = payload.asOf;
    if (asOf !== undefined && (!Number.isSafeInteger(asOf) || asOf < 0)) throw new Error('Invalid snapshot date');
    // Weekly totals can decrease as old clicks leave the window. Use the server's
    // snapshot date across GET and POST responses, never a per-game maximum.
    if (asOf === undefined ? latestAsOf !== null || serial < acceptedRequest : latestAsOf !== null && asOf < latestAsOf) return;
    if (asOf === latestAsOf && serial < acceptedRequest) return;
    acceptedRequest = Math.max(acceptedRequest, serial);
    latestAsOf = asOf ?? null;
    counts = Object.fromEntries(cards.map(({ slug }) => [slug, Math.max(counts?.[slug] ?? 0, values[slug])]));
    weeklyCounts = asOf === undefined ? null : parseCountMap(payload.weeklyCounts);
    lastUpdated = asOf === undefined ? null : parseUpdateMap(payload.lastUpdated);
    trackingStartedAt = parseDate(payload.weeklyTrackingStartedAt);
    refreshFailed = false;
    render();
  }

  async function refreshCounts() {
    const serial = ++requestNumber;
    latestRead = serial;
    try {
      const response = await fetch('/api/plays', { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Play counts unavailable');
      acceptSnapshot(await response.json(), serial);
    } catch {
      if (serial !== latestRead || serial < acceptedRequest) return;
      refreshFailed = true;
      displayStatus();
    }
  }

  function recordPlay(event) {
    if (event.type === 'click' ? event.button !== 0 : event.button !== 1) return;
    const link = event.target instanceof Element ? event.target.closest('a.play') : null;
    const card = link?.closest('.card[data-game]');
    if (!card || !grid.contains(card)) return;
    const serial = ++requestNumber;
    // Do not prevent navigation or wait for analytics, including new-tab clicks.
    fetch(`/api/plays/${encodeURIComponent(card.dataset.game)}`, {
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      keepalive: true,
      headers: { Accept: 'application/json' },
    }).then(response => {
      if (!response.ok) throw new Error('Play click was not recorded');
      return response.json();
    }).then(payload => acceptSnapshot(payload, serial)).catch(() => {});
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (document.visibilityState === 'visible') refreshTimer = setTimeout(() => {
      void refreshCounts();
      scheduleRefresh();
    }, 60000);
  }

  sortControl?.addEventListener('change', () => {
    selectedSort = sortModes.includes(sortControl.value) ? sortControl.value : 'plays';
    try { sessionStorage.setItem(storageKey, selectedSort); } catch { /* Optional preference. */ }
    render();
  });
  grid.addEventListener('click', recordPlay);
  grid.addEventListener('auxclick', recordPlay);
  window.addEventListener('pageshow', event => {
    // Back/forward cache restores an old DOM, so refresh its ranking as well.
    if (event.persisted) { clearGesture(); void refreshCounts(); scheduleRefresh(); }
  });
  window.addEventListener('pagehide', () => { clearGesture(); clearTimeout(refreshTimer); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshCounts();
    else clearGesture();
    scheduleRefresh();
  });
  displayStatus();
  void refreshCounts();
  scheduleRefresh();
})();
