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
  let interactionStarted = false;
  let ranked = false;
  let readNumber = 0;

  // Once someone reaches a card, keep every link where they found it.
  const lockOrder = event => {
    if (event.target instanceof Element && event.target.closest('.card[data-game]')) interactionStarted = true;
  };
  for (const type of ['pointerdown', 'pointerover', 'focusin', 'keydown']) grid.addEventListener(type, lockOrder, { passive: true });

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

  function displayCounts(values, mayRank) {
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
    if (mayRank && !interactionStarted && !grid.contains(document.activeElement)) {
      const ordered = [...cards].sort((left, right) => counts[right.slug] - counts[left.slug] || left.order - right.order);
      const fragment = document.createDocumentFragment();
      for (const { element } of ordered) fragment.append(element);
      grid.append(fragment);
      ranked = true;
    }
    if (rankingTitle) rankingTitle.textContent = ranked ? 'Most played' : 'All games';
    if (rankingNote) rankingNote.textContent = ranked ? 'Ranked by shared play clicks' : 'Shared play clicks';
  }

  async function refreshCounts(mayRank) {
    const requestNumber = ++readNumber;
    try {
      const response = await fetch('/api/plays', { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Play counts unavailable');
      const values = parseCounts(await response.json());
      if (requestNumber === readNumber) displayCounts(values, mayRank);
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
    interactionStarted = true;
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
    }).then(payload => displayCounts(parseCounts(payload), false)).catch(() => {});
  }

  grid.addEventListener('click', recordPlay);
  grid.addEventListener('auxclick', recordPlay);
  window.addEventListener('pageshow', event => {
    // Back/forward cache restores the old DOM. Refresh totals without moving it.
    if (event.persisted) void refreshCounts(false);
  });
  void refreshCounts(true);
})();
