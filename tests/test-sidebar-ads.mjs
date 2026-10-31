import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import('../../../gameslop-games/node_modules/playwright/index.mjs'); }

const files = Object.fromEntries(await Promise.all([
  'index.html', 'about.html', 'privacy.html', 'assets/play-counts.js', 'assets/sidebar-ads.js',
].map(async name => [name, await readFile(new URL('../' + name, import.meta.url), 'utf8')])));
const gameIds = [...files['index.html'].matchAll(/data-game="([^"]+)"/g)].map(match => match[1]);
const counts = Object.fromEntries(gameIds.map(id => [id, 0]));
const payload = {
  counts, weeklyCounts: counts, lastUpdated: Object.fromEntries(gameIds.map(id => [id, null])),
  weeklyTrackingStartedAt: '2026-09-26T23:24:07.370Z', asOf: Date.now(),
};
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.PORTAL_BROWSER_CHANNEL ? { channel: process.env.PORTAL_BROWSER_CHANNEL } : {}) });
const sdkUrl = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3292344753796518';

async function fixture({ width = 1600, origin = 'https://gameslop.now', path = '/', blocked = false, unfilled = false, throws = false, holdSdk = false, mobile = false, deviceScaleFactor = 1, adStatus = unfilled ? 'unfilled' : 'filled', frameDimensions = { width: 160, height: 600 } } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor });
  const page = await context.newPage();
  const requests = [], unexpected = [], errors = [];
  let pendingSdk;
  const mockSdk = `
    window.testAdCalls = 0;
    window.adsbygoogle = { push() {
      window.testAdCalls += 1;
      if (${throws}) throw new Error('Mock blocked placement');
      const unit = [...document.querySelectorAll('.adsbygoogle')].find(el => !el.dataset.adsbygoogleStatus);
      if (!unit) throw new Error('No uninitialized unit');
      // Real SDK scaffolding may exist before it sets iframe dimensions or fill status.
      // A status-only mock misses the browser's default 300x150 iframe overflowing a 160px slot.
      const wrapper = document.createElement('ins');
      wrapper.style.cssText = 'display:inline-block;width:160px;height:600px;position:relative;border:none';
      const frame = document.createElement('iframe');
      frame.dataset.mockAdFrame = 'true';
      frame.title = 'Local mocked advertisement';
      const dimensions = ${JSON.stringify(frameDimensions)};
      if (dimensions) {
        frame.width = String(dimensions.width);
        frame.height = String(dimensions.height);
        frame.frameBorder = '0';
      }
      wrapper.append(frame);
      unit.append(wrapper);
      unit.dataset.adsbygoogleStatus = 'done';
      const status = ${JSON.stringify(adStatus)};
      if (status !== null) unit.dataset.adStatus = status;
    }};
  `;
  page.on('pageerror', error => errors.push(error.message));
  // Every request is intercepted. These tests must never contact Google or the live portal.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ url: request.url(), method: request.method() });
    if (request.url() === sdkUrl) {
      if (blocked) return route.abort('blockedbyclient');
      if (holdSdk) return new Promise(resolve => { pendingSdk = async () => { await route.fulfill({ contentType: 'text/javascript', body: mockSdk }); resolve(); }; });
      return route.fulfill({ contentType: 'text/javascript', body: mockSdk });
    }
    if (url.origin === origin) {
      if (url.pathname === '/api/plays') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      let name = url.pathname.slice(1);
      if (!name || name === 'unknown') name = 'index.html';
      if (files[name]) return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html', body: files[name] });
    }
    unexpected.push(request.url());
    return route.abort('blockedbyclient');
  });
  await page.goto(origin + path, { waitUntil: holdSdk ? 'domcontentloaded' : 'load' });
  await page.waitForFunction(() => document.querySelector('[data-game] [data-play-count]')?.textContent.includes('0 plays') || !document.querySelector('[data-game]'));
  return {
    page, context, requests, unexpected, errors,
    sdkRequests: () => requests.filter(request => request.url === sdkUrl).length,
    releaseSdk: async () => {
      assert.ok(pendingSdk, 'SDK request is pending');
      await pendingSdk();
      await page.waitForFunction(() => !!window.adsbygoogle);
    },
    close: async () => {
      assert.deepEqual(unexpected, [], 'No unmocked outbound requests');
      assert.deepEqual(errors, [], 'No browser exceptions');
      assert.ok(requests.every(request => request.method === 'GET'), 'No counter POSTs');
      await context.close();
    },
  };
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, y: box.y, width: box.width, height: box.height };
    };
    return {
      viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      content: rect(document.querySelector('.wrap')),
      rails: [...document.querySelectorAll('[data-sidebar-ad]')].map(element => ({ ...rect(element), hidden: element.hidden, position: getComputedStyle(element).position })),
      units: [...document.querySelectorAll('.sidebar-ad-unit')].map(element => ({ ...rect(element), display: getComputedStyle(element).display })),
    };
  });
}

async function assertFramesContained(page, { requireVisible = false } = {}) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      content: rect(document.querySelector('.wrap')),
      headline: rect(document.querySelector('h1')),
      frames: [...document.querySelectorAll('[data-mock-ad-frame]')].map(frame => ({
        ...rect(frame), unit: rect(frame.closest('.sidebar-ad-unit')),
        hidden: !frame.checkVisibility(),
        placementHidden: !frame.closest('.sidebar-ad-unit').checkVisibility(),
      })),
    };
  });
  assert.equal(layout.frames.length, 2, 'The mock must exercise actual SDK-created iframe elements');
  const intersects = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  for (const frame of layout.frames) {
    if (!requireVisible && frame.hidden) {
      assert.ok(frame.placementHidden, 'Hide the whole malformed placement, not an individual creative element');
      continue;
    }
    assert.equal(frame.hidden, false, 'A valid creative remains visible');
    assert.ok(frame.width > 0 && frame.height > 0, 'A filled or pending frame remains visible');
    assert.ok(frame.x >= frame.unit.x && frame.right <= frame.unit.right + 0.1,
      `Ad iframe must fit its slot: frame ${frame.x}..${frame.right}, slot ${frame.unit.x}..${frame.unit.right}`);
    assert.ok(frame.y >= frame.unit.y && frame.bottom <= frame.unit.bottom + 0.1, 'Ad iframe fits within the reserved slot height');
    assert.ok(!intersects(frame, layout.content), 'Ad iframe cannot intersect portal content');
    assert.ok(!intersects(frame, layout.headline), 'Ad iframe cannot cover the headline');
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Ad frames cannot cause horizontal page overflow');
}

test('manual sidebar ads stay confined to eligible portal screens', async t => {
  try {
    await t.test('wide homepage loads one SDK and exactly two separated static units', async () => {
      const f = await fixture();
      await f.page.waitForFunction(() => window.testAdCalls === 2);
      assert.equal(f.sdkRequests(), 1);
      assert.equal(await f.page.locator('.ad-label:visible').count(), 2);
      assert.deepEqual(await f.page.locator('.sidebar-ad-unit').evaluateAll(units => units.map(unit => unit.dataset.adSlot)), ['7574873616', '9982591281']);
      const layout = await geometry(f.page);
      assert.equal(layout.content.width, 1040);
      assert.equal(layout.content.x, (layout.viewport - 1040) / 2);
      assert.ok(layout.rails[0].right + 48 <= layout.content.x);
      assert.ok(layout.content.right + 48 <= layout.rails[1].x);
      assert.ok(layout.units.every(unit => unit.width === 160 && unit.height === 600));
      assert.ok(layout.rails.every(rail => !['fixed', 'sticky'].includes(rail.position)));
      assert.ok(layout.scrollWidth <= layout.viewport);
      await f.page.evaluate(() => window.scrollTo(0, 800));
      assert.ok((await geometry(f.page)).rails.every(rail => rail.y < 0), 'Ads scroll with page content');
      await f.close();
    });

    for (const width of [320, 1280, 1535]) {
      await t.test(`${width}px screens never request or initialize ads`, async () => {
        const f = await fixture({ width });
        assert.equal(f.sdkRequests(), 0);
        assert.equal(await f.page.evaluate(() => typeof window.adsbygoogle), 'undefined');
        const layout = await geometry(f.page);
        assert.ok(layout.units.every(unit => unit.display === 'none'));
        assert.ok(layout.rails.every(rail => rail.hidden));
        assert.ok(layout.scrollWidth <= width);
        await f.close();
      });
    }

    await t.test('a wide touch-only mobile screen never requests ads', async () => {
      const f = await fixture({ mobile: true });
      assert.equal(f.sdkRequests(), 0);
      assert.equal(await f.page.locator('.ad-rail:visible').count(), 0);
      assert.ok((await geometry(f.page)).units.every(unit => unit.display === 'none'));
      await f.close();
    });

    await t.test('the exact 1536px desktop threshold fits both sidebar units', async () => {
      const f = await fixture({ width: 1536 });
      await f.page.waitForFunction(() => window.testAdCalls === 2);
      const layout = await geometry(f.page);
      assert.equal(layout.content.width, 1040);
      assert.equal(layout.content.x, 248);
      assert.ok(layout.rails.every(rail => rail.x >= 0 && rail.right <= 1536));
      assert.equal(layout.scrollWidth, 1536);
      await f.close();
    });

    for (const [width, deviceScaleFactor] of [[1536, 1], [1600, 1], [1600, 1.25]]) {
      await t.test(`default-sized SDK iframes cannot overlap content at ${width}px and DPR ${deviceScaleFactor}`, async () => {
        const f = await fixture({ width, deviceScaleFactor, frameDimensions: null });
        try {
          await f.page.waitForFunction(() => window.testAdCalls === 2);
          assert.equal(await f.page.locator('[data-mock-ad-frame]').evaluateAll(frames => frames.every(frame => !frame.hasAttribute('width') && !frame.hasAttribute('height'))), true,
            'Exercise the browser fallback dimensions, not an artificially sized mock');
          await assertFramesContained(f.page);
          if (deviceScaleFactor === 1.25) {
            const screenshot = await f.page.screenshot({ clip: { x: 0, y: 0, width, height: 320 } });
            assert.equal(screenshot.readUInt32BE(16), width * 1.25, '125% display scale produces the expected physical screenshot width');
            assert.equal(screenshot.readUInt32BE(20), 400, '125% display scale produces the expected physical screenshot height');
          }
        } finally {
          await f.close();
        }
      });
    }

    await t.test('a correctly sized 160x600 creative stays within its reserved sidebar', async () => {
      const f = await fixture({ frameDimensions: { width: 160, height: 600 } });
      try {
        await f.page.waitForFunction(() => window.testAdCalls === 2);
        await assertFramesContained(f.page, { requireVisible: true });
        assert.deepEqual(await f.page.locator('[data-mock-ad-frame]').evaluateAll(frames => frames.map(frame => ({ width: frame.clientWidth, height: frame.clientHeight }))),
          [{ width: 160, height: 600 }, { width: 160, height: 600 }], 'Containment does not crop or shrink a valid creative');
      } finally {
        await f.close();
      }
    });

    await t.test('pending and stale fill statuses cannot expose an oversized iframe during resize', async () => {
      const f = await fixture({ adStatus: null, frameDimensions: null });
      try {
        await f.page.waitForFunction(() => window.testAdCalls === 2);
        await assertFramesContained(f.page);
        await f.page.evaluate(() => document.querySelectorAll('.sidebar-ad-unit').forEach(unit => { unit.dataset.adStatus = 'filled'; }));
        await assertFramesContained(f.page);
        await f.page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await f.page.locator('[data-mock-ad-frame]:visible').count(), 0);
        await f.page.evaluate(() => document.querySelectorAll('.sidebar-ad-unit').forEach(unit => { unit.dataset.adStatus = 'unfilled'; }));
        await f.page.setViewportSize({ width: 1600, height: 1000 });
        assert.equal(await f.page.locator('.ad-label:visible').count(), 0, 'Unfilled status survives a viewport change');
        assert.equal(await f.page.locator('[data-mock-ad-frame]:visible').count(), 0, 'Unfilled frames stay collapsed');
        // An asynchronous/stale SDK update can return after resizing; it still must be contained.
        await f.page.evaluate(() => document.querySelectorAll('.sidebar-ad-unit').forEach(unit => { unit.dataset.adStatus = 'filled'; }));
        await assertFramesContained(f.page);
        assert.equal(f.sdkRequests(), 1);
        assert.equal(await f.page.evaluate(() => window.testAdCalls), 2, 'Fill updates do not request new ads');
      } finally {
        await f.close();
      }
    });

    await t.test('a late SDK dimension change suppresses only the malformed placement', async () => {
      const f = await fixture();
      try {
        await f.page.waitForFunction(() => window.testAdCalls === 2);
        await assertFramesContained(f.page, { requireVisible: true });
        await f.page.locator('[data-mock-ad-frame]').first().evaluate(frame => frame.removeAttribute('width'));
        await assertFramesContained(f.page);
        assert.deepEqual(await f.page.locator('[data-sidebar-ad]').evaluateAll(rails => rails.map(rail => rail.hidden)), [true, false],
          'Only the malformed placement is hidden; the valid ad stays visible');
        assert.equal(await f.page.locator('.ad-label:visible').count(), 1);
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.setViewportSize({ width: 1600, height: 1000 });
        await assertFramesContained(f.page);
        assert.equal(await f.page.locator('[data-mock-ad-frame]:visible').count(), 1);
        assert.equal(f.sdkRequests(), 1);
        assert.equal(await f.page.evaluate(() => window.testAdCalls), 2, 'Suppressing an invalid frame never refreshes ads');
      } finally {
        await f.close();
      }
    });

    for (const origin of ['https://brainrotgame.shop', 'https://grove.gameslop.now', 'http://gameslop.now', 'http://127.0.0.1:3011']) {
      await t.test(`${origin} never requests ads even on wide screens`, async () => {
        const f = await fixture({ origin });
        assert.equal(f.sdkRequests(), 0);
        assert.equal(await f.page.locator('.ad-rail:visible').count(), 0);
        assert.equal((await geometry(f.page)).content.width, 1040);
        await f.close();
      });
    }

    for (const path of ['/about.html', '/privacy.html', '/unknown']) {
      await t.test(`${path} never requests ads`, async () => {
        const f = await fixture({ path });
        assert.equal(f.sdkRequests(), 0);
        await f.close();
      });
    }

    await t.test('crossing the width threshold initializes once and never refreshes units', async () => {
      const f = await fixture({ width: 1280 });
      assert.equal(f.sdkRequests(), 0);
      await f.page.setViewportSize({ width: 1600, height: 1000 });
      await f.page.waitForFunction(() => window.testAdCalls === 2);
      await f.page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await f.page.locator('.ad-rail:visible').count(), 0);
      await f.page.setViewportSize({ width: 1600, height: 1000 });
      await f.page.waitForFunction(() => document.querySelectorAll('.ad-rail:not([hidden])').length === 2);
      assert.equal(f.sdkRequests(), 1);
      assert.equal(await f.page.evaluate(() => window.testAdCalls), 2);
      await f.close();
    });

    await t.test('SDK completing after narrowing does not initialize hidden units', async () => {
      const f = await fixture({ holdSdk: true });
      assert.equal(f.sdkRequests(), 1);
      await f.page.setViewportSize({ width: 390, height: 844 });
      await f.releaseSdk();
      assert.equal(await f.page.evaluate(() => window.testAdCalls), 0);
      await f.page.setViewportSize({ width: 1600, height: 1000 });
      await f.page.waitForFunction(() => window.testAdCalls === 2);
      assert.equal(f.sdkRequests(), 1);
      await f.close();
    });

    await t.test('a blocked SDK leaves the normal portal usable without ad placeholders', async () => {
      const f = await fixture({ blocked: true });
      assert.equal(await f.page.locator('.ad-rail:visible').count(), 0);
      assert.equal((await geometry(f.page)).content.x, 280);
      await f.page.locator('#sort-order').selectOption('trending');
      assert.equal(await f.page.locator('#sort-order').inputValue(), 'trending');
      assert.equal(await f.page.locator('.card[data-game]').count(), 16);
      await f.close();
    });

    await t.test('unfilled placements collapse their labels without shifting the game catalog', async () => {
      const f = await fixture({ unfilled: true });
      await f.page.waitForFunction(() => window.testAdCalls === 2 && [...document.querySelectorAll('[data-sidebar-ad]')].every(rail => rail.hidden));
      const layout = await geometry(f.page);
      assert.equal(layout.content.width, 1040);
      assert.equal(layout.content.x, 280);
      assert.equal(await f.page.locator('.ad-label:visible').count(), 0);
      assert.equal(await f.page.locator('[data-mock-ad-frame]').count(), 2, 'Unfilled SDK scaffold remains present');
      assert.equal(await f.page.locator('[data-mock-ad-frame]:visible').count(), 0, 'Unfilled SDK frames are collapsed');
      await f.close();
    });

    await t.test('failed placement pushes do not recur on resize', async () => {
      const f = await fixture({ throws: true });
      await f.page.waitForFunction(() => window.testAdCalls === 2);
      assert.equal(await f.page.locator('.ad-rail:visible').count(), 0);
      await f.page.setViewportSize({ width: 390, height: 844 });
      await f.page.setViewportSize({ width: 1600, height: 1000 });
      assert.equal(await f.page.locator('.ad-rail:visible').count(), 0);
      assert.equal(await f.page.evaluate(() => window.testAdCalls), 2);
      await f.close();
    });
  } finally {
    await browser.close();
  }
});
