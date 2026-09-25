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
  const formatter = new Intl.NumberFormat(document.documentElement.lang || 'en');
  let counts = null;
  let ranked = false;
  let readNumber = 0;
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
    rankCards();
  }, 0);
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, finishPointer, { passive: true });
  window.addEventListener('keyup', event => setTimeout(() => {
    pressedKeys.delete(event.key);
    rankCards();
  }, 0));
  const clearGesture = () => {
    pressedPointers.clear();
    pressedKeys.clear();
  };
  window.addEventListener('blur', () => { clearGesture(); rankCards(); });

  function parseCounts(payload) {
    if (!payload || typeof payload.counts !== 'object' || payload.counts === null || Array.isArray(payload.counts)) throw new Error('Invalid play totals');
    const values = {};
    for (const { slug } of cards) {
      const value = payload.counts[slug];
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid play total');
      values[slug] = value;
    }
    return values;
  }

  function rankCards() {
    if (!counts || pressedPointers.size || pressedKeys.size) return;
    const ordered = [...cards].sort((left, right) => counts[right.slug] - counts[left.slug] || left.order - right.order);
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    for (const [index, { element }] of ordered.entries()) {
      if (grid.children[index] !== element) grid.insertBefore(element, grid.children[index] ?? null);
    }
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    ranked = true;
    if (rankingTitle) rankingTitle.textContent = 'Most played';
    if (rankingNote) rankingNote.textContent = 'Ranked by shared play clicks';
  }

  function displayCounts(values) {
    // Totals only increase. An older GET/POST response must not erase a newer total.
    counts = Object.fromEntries(cards.map(({ slug }) => [slug, Math.max(counts?.[slug] ?? 0, values[slug])]));
    for (const { slug, label } of cards) {
      if (!label) continue;
      const number = document.createElement('span');
      number.className = 'count-value';
      number.textContent = formatter.format(counts[slug]);
      label.replaceChildren(number, document.createTextNode(counts[slug] === 1 ? ' play' : ' plays'));
      label.title = 'Shared play clicks';
    }
    rankCards();
    if (rankingTitle) rankingTitle.textContent = ranked ? 'Most played' : 'All games';
    if (rankingNote) rankingNote.textContent = ranked ? 'Ranked by shared play clicks' : 'Shared play clicks';
  }

  async function refreshCounts() {
    const requestNumber = ++readNumber;
    try {
      const response = await fetch('/api/plays', { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Play counts unavailable');
      const values = parseCounts(await response.json());
      if (requestNumber === readNumber) displayCounts(values);
    } catch {
      if (requestNumber !== readNumber) return;
      if (rankingNote) rankingNote.textContent = counts ? 'Last loaded play clicks' : 'Play counts unavailable';
    }
  }

  function recordPlay(event) {
    if (event.type === 'click' ? event.button !== 0 : event.button !== 1) return;
    const link = event.target instanceof Element ? event.target.closest('a.play') : null;
    const card = link?.closest('.card[data-game]');
    if (!card || !grid.contains(card)) return;
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
    }).then(payload => displayCounts(parseCounts(payload))).catch(() => {});
  }

  grid.addEventListener('click', recordPlay);
  grid.addEventListener('auxclick', recordPlay);
  window.addEventListener('pageshow', event => {
    // Back/forward cache restores an old DOM, so refresh its ranking as well.
    if (event.persisted) { clearGesture(); void refreshCounts(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshCounts();
    else clearGesture();
  });
  void refreshCounts();
})();
