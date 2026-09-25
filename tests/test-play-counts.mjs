import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Install Playwright locally, or use the adjacent game repository's dev dependency.
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import('../../../gameslop-games/node_modules/playwright/index.mjs'); }

const originalOrder = ['primordial', 'primordial-tactics', 'bagbrawl', 'deadpoint', 'headsup', 'grove', 'emberwild', 'emberfell', 'pelaglyph'];
const seeds = () => ({ primordial: 10, 'primordial-tactics': 0, bagbrawl: 30, deadpoint: 225, headsup: 0, grove: 0, emberwild: 0, emberfell: 0, pelaglyph: 0 });
const html = await readFile(new URL('../index.html', import.meta.url));
const script = await readFile(new URL('../assets/play-counts.js', import.meta.url));
let state;
const reset = () => { state = { counts: seeds(), requests: [], getStatus: 200, postStatus: 200, holdGet: false, holdPost: false, pendingGet: [], pendingPost: [] }; };
reset();

const server = createServer(async (request, response) => {
  const requestState = state;
  if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
  if (request.url === '/assets/play-counts.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(script); return; }
  if (request.url.startsWith('/opened/')) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Opened game</title><p>The game opened.</p>'); return; }
  const game = /^\/api\/plays\/([a-z-]+)$/.exec(request.url ?? '');
  if (request.url === '/api/plays' && request.method === 'GET') {
    requestState.requests.push({ method: 'GET' });
    const send = () => { response.writeHead(requestState.getStatus, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ counts: requestState.counts })); };
    if (requestState.holdGet) requestState.pendingGet.push(send); else send();
    return;
  }
  if (game && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    requestState.requests.push({ method: 'POST', slug: game[1], body });
    if (requestState.postStatus === 200) requestState.counts[game[1]] += 1;
    const send = () => { response.writeHead(requestState.postStatus, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ counts: requestState.counts })); };
    if (requestState.holdPost) requestState.pendingPost.push(send); else send();
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await playwright.chromium.launch({ headless: true, ...(process.env.PORTAL_BROWSER_CHANNEL ? { channel: process.env.PORTAL_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Opened game</title><p>The game opened.</p>' }));

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), message);
}
async function open({ waitCounts = true } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  if (waitCounts) await page.waitForFunction(() => document.querySelector('[data-game="deadpoint"] [data-play-count]').textContent.includes('225'));
  return { page, errors };
}
const order = page => page.locator('.card[data-game]').evaluateAll(elements => elements.map(element => element.dataset.game));
const countText = (page, slug) => page.locator(`[data-game="${slug}"] [data-play-count]`).textContent();

test('shared play counts keep navigation native, totals truthful, and ranking stable', async t => {
  try {
    await t.test('loads all nine shared totals, ranks descending, and keeps original ties', async () => {
      reset();
      const { page, errors } = await open();
      assert.deepEqual(await order(page), ['deadpoint', 'bagbrawl', 'primordial', 'primordial-tactics', 'headsup', 'grove', 'emberwild', 'emberfell', 'pelaglyph']);
      assert.equal(await countText(page, 'deadpoint'), '225 plays');
      assert.equal(await countText(page, 'grove'), '0 plays');
      assert.equal(await page.locator('.art svg').count(), 9);
      assert.equal(await page.locator('[data-game="primordial"] a.play').getAttribute('href'), 'https://primordial-action.gameslop.now');
      assert.equal(await page.locator('#ranking-note').textContent(), 'Ranked by shared play clicks');
      assert.deepEqual(errors, []);
      await page.close();
    });

    for (const [name, activate] of [
      ['normal click', link => link.click()],
      ['keyboard Enter', async link => { await link.focus(); await link.press('Enter'); }],
      ['Ctrl-click', link => link.click({ modifiers: ['Control'] })],
      ['Meta-click', link => link.click({ modifiers: ['Meta'] })],
      ['middle click', link => link.click({ button: 'middle' })],
    ]) await t.test(`${name} records exactly one empty POST and opens the game`, async () => {
      reset();
      const { page, errors } = await open();
      const link = page.locator('[data-game="primordial"] a.play');
      // Exercise real tab navigation against a local destination, without relying on live game servers.
      await link.evaluate((element, href) => { element.href = href; }, `${origin}/opened/primordial`);
      await activate(link);
      await until(() => state.requests.some(request => request.method === 'POST'), 'Play POST arrives');
      await delay(150);
      assert.deepEqual(state.requests.filter(request => request.method === 'POST'), [{ method: 'POST', slug: 'primordial', body: '' }]);
      await until(() => context.pages().some(candidate => candidate.url() === `${origin}/opened/primordial`), 'Native link navigation opens the game');
      assert.deepEqual(errors, []);
      for (const openPage of context.pages()) await openPage.close();
    });

    await t.test('waiting on a slow increment never delays navigation', async () => {
      reset(); state.holdPost = true;
      const { page } = await open();
      await page.locator('[data-game="grove"] a.play').click({ timeout: 2500 });
      assert.equal(page.url(), 'https://grove.gameslop.now/');
      await until(() => state.pendingPost.length === 1, 'A pending play increment is held open');
      state.pendingPost[0]();
      await page.close();
    });

    for (const [name, interact] of [
      ['focused', page => page.locator('[data-game="primordial"] a.play').focus()],
      ['pressed', async page => { const box = await page.locator('[data-game="primordial"] .art').boundingBox(); await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); }],
    ]) await t.test(`a ${name} card is not moved by a late startup response`, async () => {
      reset(); state.holdGet = true;
      const { page, errors } = await open({ waitCounts: false });
      await until(() => state.pendingGet.length === 1, 'Initial count request waits');
      await interact(page);
      state.pendingGet[0]();
      await page.waitForFunction(() => document.querySelector('[data-game="deadpoint"] [data-play-count]').textContent.includes('225'));
      assert.deepEqual(await order(page), originalOrder);
      if (name === 'focused') assert.equal(await page.evaluate(() => document.activeElement.closest('.card').dataset.game), 'primordial');
      else await page.mouse.up();
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('back/forward restoration refreshes numbers without moving restored cards', async () => {
      reset();
      const { page } = await open();
      const before = await order(page);
      state.counts.pelaglyph = 12345;
      state.counts.grove = 1;
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.waitForFunction(() => document.querySelector('[data-game="pelaglyph"] [data-play-count]').textContent.includes('12,345'));
      assert.equal(await countText(page, 'grove'), '1 play');
      assert.deepEqual(await order(page), before);
      assert.equal(state.requests.filter(request => request.method === 'GET').length, 2);
      await page.close();
    });

    await t.test('API failures leave original links usable and never invent counts', async () => {
      reset(); state.getStatus = 503; state.postStatus = 503;
      const { page, errors } = await open({ waitCounts: false });
      await page.waitForFunction(() => document.getElementById('ranking-note').textContent === 'Play counts unavailable');
      assert.deepEqual(await order(page), originalOrder);
      assert.equal(await countText(page, 'deadpoint'), 'Play count unavailable');
      await page.locator('[data-game="bagbrawl"] a.play').click();
      assert.equal(page.url(), 'https://bagbrawl.app/');
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('invalid API numbers are rejected as unavailable', async () => {
      reset(); state.counts.deadpoint = -1;
      const { page } = await open({ waitCounts: false });
      await page.waitForFunction(() => document.getElementById('ranking-note').textContent === 'Play counts unavailable');
      assert.equal(await countText(page, 'deadpoint'), 'Play count unavailable');
      assert.deepEqual(await order(page), originalOrder);
      await page.close();
    });

    await t.test('counts sit below play links and fit a narrow phone viewport', async () => {
      reset();
      const { page } = await open();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
      for (const slug of originalOrder) {
        const card = page.locator(`[data-game="${slug}"]`);
        const linkBox = await card.locator('a.play').boundingBox();
        const countBox = await card.locator('[data-play-count]').boundingBox();
        assert.ok(countBox.y > linkBox.y + linkBox.height, `${slug} count is below its play button`);
        assert.ok(countBox.width <= 354, `${slug} count fits inside its card`);
      }
      await page.close();
    });
  } finally {
    await context.close();
    await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
