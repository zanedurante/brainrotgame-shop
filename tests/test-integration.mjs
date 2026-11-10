import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import('../../../gameslop-games/node_modules/playwright/index.mjs'); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'gameslop-integration-'));
const python = process.env.PORTAL_PYTHON || 'python';
const database = join(temporary, 'plays.sqlite3');
const updatesFile = join(temporary, 'updates.json');
const apiGames = ['primordial', 'primordial-tactics', 'bagbrawl', 'deadpoint', 'headsup', 'grove', 'emberwild', 'emberfell', 'pelaglyph', 'hypercycle', 'litigation', 'hollowtide', 'grandstrat', 'vipertcg', 'battlelines', 'wowzaworka', 'scramble', 'elderhold', 'tabby', 'billionaire-simulator', 'half-and-half', 'marble-mayhem'];
const hiddenGames = new Set(['primordial-tactics', 'headsup', 'emberwild', 'pelaglyph']);
const originalOrder = apiGames.filter(slug => !hiddenGames.has(slug));
const expectedPlays = ['deadpoint', 'bagbrawl', 'primordial', 'grove', 'emberfell', 'hypercycle', 'litigation', 'hollowtide', 'grandstrat', 'vipertcg', 'battlelines', 'wowzaworka', 'scramble', 'elderhold', 'tabby', 'billionaire-simulator', 'half-and-half', 'marble-mayhem'];
const expectedUpdated = ['hypercycle', 'primordial', 'bagbrawl', 'deadpoint', 'grove', 'emberfell', 'litigation', 'hollowtide', 'grandstrat', 'vipertcg', 'battlelines', 'wowzaworka', 'scramble', 'elderhold', 'tabby', 'billionaire-simulator', 'half-and-half', 'marble-mayhem'];
const expectedTrending = ['primordial', 'bagbrawl', 'deadpoint', 'grove', 'emberfell', 'hypercycle', 'litigation', 'hollowtide', 'grandstrat', 'vipertcg', 'battlelines', 'wowzaworka', 'scramble', 'elderhold', 'tabby', 'billionaire-simulator', 'half-and-half', 'marble-mayhem'];
await writeFile(updatesFile, JSON.stringify({ lastUpdated: { ...Object.fromEntries(apiGames.map(slug => [slug, null])), hypercycle: '2026-10-02T09:00:00Z', pelaglyph: '2026-09-26T09:00:00Z', emberwild: '2026-09-25T09:00:00Z', primordial: '2026-09-24T09:00:00Z', 'primordial-tactics': '2026-09-24T09:00:00Z' } }));
function fixture(code) {
  const result = spawnSync(python, ['-c', `import sys, time, sqlite3\nfrom counter.server import PlayStore\nstore = PlayStore(sys.argv[1])\nconnection = store.connect()\nnow = int(time.time() * 1000)\n${code}\nconnection.close()`, database], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}
fixture("connection.executemany('INSERT INTO play_events (slug, played_at_ms) VALUES (?, ?)', [('primordial', now - 1000)] * 8 + [('bagbrawl', now - 1000)] * 2 + [('deadpoint', now - 1000)] + [('deadpoint', now - 7 * 86400000 - 10000)] * 40)");
const child = spawn(python, ['counter/server.py', '--db', database, '--port', '0', '--site-root', '.', '--updates-file', updatesFile], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic += chunk; });
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${diagnostic}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${diagnostic}`)); });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.PORTAL_BROWSER_CHANNEL ? { channel: process.env.PORTAL_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('https://**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Game opened</title>' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.card').dataset.game === 'deadpoint');
  const order = () => page.locator('.card').evaluateAll(cards => cards.map(card => card.dataset.game));
  assert.deepEqual(await order(), expectedPlays);
  assert.equal(await page.locator('.card').count(), originalOrder.length);
  assert.equal(await page.locator('[data-game="tabby"] .count-value').textContent(), '0');
  assert.equal(await page.locator('[data-game="tabby"] .play').getAttribute('href'), 'https://tabby.gameslop.now');
  assert.equal(await page.locator('[data-game="hypercycle"] .count-value').textContent(), '0');
  assert.equal(await page.locator('[data-game="battlelines"] .count-value').textContent(), '0');
  assert.equal(await page.locator('[data-game="wowzaworka"] .count-value').textContent(), '0');
  assert.equal(await page.locator('[data-game="scramble"] .count-value').textContent(), '0');
  assert.equal(await page.locator('[data-game="elderhold"] .count-value').textContent(), '0');
  assert.match(await page.locator('[data-game="deadpoint"] [data-play-count]').textContent(), /225\s*plays/);
  const screenshots = join(root, 'test-results');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true });
  await page.locator('#sort-order').selectOption('updated');
  assert.deepEqual(await order(), expectedUpdated);
  assert.equal(await page.locator('[data-game="hypercycle"] .count-detail').textContent(), 'Updated Oct 2, 2026');
  assert.equal(await page.locator('[data-game="primordial"] .count-detail').textContent(), 'Updated Sep 24, 2026');
  assert.equal(await page.locator('[data-game="grove"] .count-detail').textContent(), 'Update date unavailable');
  await page.screenshot({ path: join(screenshots, 'desktop-updated.png'), fullPage: true });
  await page.locator('#sort-order').selectOption('trending');
  assert.deepEqual(await order(), expectedTrending);
  assert.equal(await page.locator('[data-game="deadpoint"] .count-value').textContent(), '225');
  assert.equal(await page.locator('[data-game="deadpoint"] .count-detail').textContent(), '1 in the last 7 days', 'Expired real events are excluded from the weekly window');
  assert.equal(await page.locator('#ranking-note').textContent(), '');
  await page.screenshot({ path: join(screenshots, 'desktop-trending.png'), fullPage: true });
  fixture("connection.execute('UPDATE play_events SET played_at_ms = ? WHERE slug = ?', (now - 7 * 86400000 - 10000, 'primordial'))");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => document.querySelector('[data-game="primordial"] .count-detail').textContent === '0 in the last 7 days');
  assert.deepEqual(await order(), ['bagbrawl', 'deadpoint', ...originalOrder.filter(slug => !['bagbrawl', 'deadpoint'].includes(slug))]);
  assert.equal(await page.locator('[data-game="primordial"] .count-value').textContent(), '10', 'Lifetime count survives weekly expiry');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const sort of ['plays', 'updated', 'trending']) {
      await page.locator('#sort-order').selectOption(sort);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${sort} fits ${width}px`);
    }
  }
  await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true });
  await page.locator('#sort-order').selectOption('plays');
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url() === `${origin}/api/plays/grove`);
  await page.locator('[data-game="grove"] .play').click();
  assert.equal((await (await posted).allHeaders()).origin, origin);
  await page.waitForURL('https://grove.gameslop.now/');
  await assertEventually(async () => (await (await fetch(`${origin}/api/plays`)).json()).counts.grove === 1);
  const secondVisitor = await browser.newContext();
  const secondPage = await secondVisitor.newPage();
  await secondPage.goto(origin);
  await secondPage.waitForFunction(() => document.querySelector('[data-game="grove"] .count-value')?.textContent === '1');
  const ranking = await secondPage.locator('.card').evaluateAll(cards => cards.map(card => card.dataset.game));
  assert.equal(ranking[3], 'grove');
  const hypercycle = secondPage.locator('[data-game="hypercycle"] .play');
  assert.equal(await hypercycle.getAttribute('href'), 'https://hypercycle.gameslop.now');
  await hypercycle.evaluate(element => { element.href = '#opened-hypercycle'; });
  const hypercyclePosted = secondPage.waitForRequest(request => request.method() === 'POST' && request.url() === `${origin}/api/plays/hypercycle`);
  await hypercycle.click();
  assert.equal((await (await hypercyclePosted).allHeaders()).origin, origin);
  await secondPage.waitForFunction(() => document.querySelector('[data-game="hypercycle"] .count-value')?.textContent === '1');
  const allCounts = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(Object.keys(allCounts.counts).length, 22, 'Unlisted games remain available to the backend');
  assert.equal(allCounts.counts.hypercycle, 1);
  assert.equal(allCounts.weeklyCounts.hypercycle, 1);
  assert.equal(allCounts.counts.deadpoint, 225);
  assert.equal(allCounts.counts.grove, 1);
  const grandstrat = secondPage.locator('[data-game="grandstrat"] .play');
  assert.equal(await grandstrat.getAttribute('href'), 'https://grandstrat.gameslop.now');
  await grandstrat.evaluate(element => { element.href = '#opened-grandstrat'; });
  await grandstrat.click();
  await secondPage.waitForFunction(() => document.querySelector('[data-game="grandstrat"] .count-value')?.textContent === '1');
  const afterGrandstrat = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(afterGrandstrat.counts.grandstrat, 1);
  assert.equal(afterGrandstrat.weeklyCounts.grandstrat, 1);
  assert.equal(afterGrandstrat.weeklyTrackingStartedAt, allCounts.weeklyTrackingStartedAt);
  for (const slug of apiGames.filter(slug => slug !== 'grandstrat')) assert.equal(afterGrandstrat.counts[slug], allCounts.counts[slug]);
  const vipertcg = secondPage.locator('[data-game="vipertcg"] .play');
  assert.equal(await vipertcg.getAttribute('href'), 'https://vipertcg.gameslop.now');
  await vipertcg.evaluate(element => { element.href = '#opened-vipertcg'; });
  await vipertcg.click();
  await secondPage.waitForFunction(() => document.querySelector('[data-game="vipertcg"] .count-value')?.textContent === '1');
  const afterViper = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(afterViper.counts.vipertcg, 1);
  assert.equal(afterViper.weeklyCounts.vipertcg, 1);
  assert.equal(afterViper.weeklyTrackingStartedAt, allCounts.weeklyTrackingStartedAt);
  for (const slug of apiGames.filter(slug => slug !== 'vipertcg')) assert.equal(afterViper.counts[slug], afterGrandstrat.counts[slug]);
  const battlelines = secondPage.locator('[data-game="battlelines"] .play');
  assert.equal(await battlelines.getAttribute('href'), 'https://battlelines.gameslop.now');
  assert.equal(await secondPage.locator('[data-game="battlelines"] .meta').textContent(), '1 playerSoloKeyboard + mouse');
  await battlelines.evaluate(element => { element.href = '#opened-battlelines'; });
  await battlelines.click();
  await secondPage.waitForFunction(() => document.querySelector('[data-game="battlelines"] .count-value')?.textContent === '1');
  const afterBattleLines = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(afterBattleLines.counts.battlelines, 1);
  assert.equal(afterBattleLines.weeklyCounts.battlelines, 1);
  assert.equal(afterBattleLines.weeklyTrackingStartedAt, allCounts.weeklyTrackingStartedAt);
  for (const slug of apiGames.filter(slug => slug !== 'battlelines')) assert.equal(afterBattleLines.counts[slug], afterViper.counts[slug]);
  await secondPage.locator('#sort-order').selectOption('trending');
  assert.equal(await secondPage.locator('[data-game="battlelines"] .count-detail').textContent(), '1 in the last 7 days');
  const wowzaworka = secondPage.locator('[data-game="wowzaworka"] .play');
  assert.equal(await wowzaworka.getAttribute('href'), 'https://wowzaworka.gameslop.now');
  assert.equal(await secondPage.locator('[data-game="wowzaworka"] .meta').textContent(), '1 playerSoloKeyboard + touch');
  await wowzaworka.evaluate(element => { element.href = '#opened-wowzaworka'; });
  await wowzaworka.click();
  await secondPage.waitForFunction(() => document.querySelector('[data-game="wowzaworka"] .count-value')?.textContent === '1');
  const afterWowzaworka = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(afterWowzaworka.counts.wowzaworka, 1);
  assert.equal(afterWowzaworka.weeklyCounts.wowzaworka, 1);
  assert.equal(afterWowzaworka.weeklyTrackingStartedAt, allCounts.weeklyTrackingStartedAt);
  for (const slug of apiGames.filter(slug => slug !== 'wowzaworka')) assert.equal(afterWowzaworka.counts[slug], afterBattleLines.counts[slug]);
  assert.equal(await secondPage.locator('[data-game="wowzaworka"] .count-detail').textContent(), '1 in the last 7 days');
  const scramble = secondPage.locator('[data-game="scramble"] .play');
  assert.equal(await scramble.getAttribute('href'), 'https://scramble.gameslop.now');
  assert.equal(await secondPage.locator('[data-game="scramble"] .meta').textContent(), '1–8 playersSolo + online co-opKeyboard + mouse');
  await scramble.evaluate(element => { element.href = '#opened-scramble'; });
  await scramble.click();
  await secondPage.waitForFunction(() => document.querySelector('[data-game="scramble"] .count-value')?.textContent === '1');
  const afterScramble = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(afterScramble.counts.scramble, 1);
  assert.equal(afterScramble.weeklyCounts.scramble, 1);
  assert.equal(afterScramble.weeklyTrackingStartedAt, allCounts.weeklyTrackingStartedAt);
  for (const slug of apiGames.filter(slug => slug !== 'scramble')) assert.equal(afterScramble.counts[slug], afterWowzaworka.counts[slug]);
  assert.equal(await secondPage.locator('[data-game="scramble"] .count-detail').textContent(), '1 in the last 7 days');
  const elderhold = secondPage.locator('[data-game="elderhold"] .play');
  assert.equal(await elderhold.getAttribute('href'), 'https://elderhold.gameslop.now');
  assert.equal(await secondPage.locator('[data-game="elderhold"] .meta').textContent(), '1 playerSoloMouse');
  await elderhold.evaluate(element => { element.href = '#opened-elderhold'; });
  await elderhold.click();
  await secondPage.waitForFunction(() => document.querySelector('[data-game="elderhold"] .count-value')?.textContent === '1');
  const afterElderhold = await (await fetch(`${origin}/api/plays`)).json();
  assert.equal(afterElderhold.counts.elderhold, 1);
  assert.equal(afterElderhold.weeklyCounts.elderhold, 1);
  assert.equal(afterElderhold.weeklyTrackingStartedAt, allCounts.weeklyTrackingStartedAt);
  for (const slug of apiGames.filter(slug => slug !== 'elderhold')) assert.equal(afterElderhold.counts[slug], afterScramble.counts[slug]);
  assert.equal(await secondPage.locator('[data-game="elderhold"] .count-detail').textContent(), '1 in the last 7 days');
  let previousArcade = afterElderhold;
  for (const slug of ['billionaire-simulator', 'half-and-half', 'marble-mayhem']) {
    const link = secondPage.locator(`[data-game="${slug}"] .play`);
    assert.equal(await link.getAttribute('href'), `https://${slug}.gameslop.now`);
    assert.equal(previousArcade.counts[slug], 0);
    await link.evaluate((element, slug) => { element.href = `#opened-${slug}`; }, slug);
    await link.click();
    await secondPage.waitForFunction(slug => document.querySelector(`[data-game="${slug}"] .count-value`)?.textContent === '1', slug);
    const current = await (await fetch(`${origin}/api/plays`)).json();
    assert.equal(current.counts[slug], 1);
    assert.equal(current.weeklyCounts[slug], 1);
    assert.equal(current.weeklyTrackingStartedAt, previousArcade.weeklyTrackingStartedAt);
    for (const other of apiGames.filter(value => value !== slug)) assert.equal(current.counts[other], previousArcade.counts[other]);
    previousArcade = current;
  }
  assert.deepEqual(errors, []);
  await secondVisitor.close();
  console.log('PASS real API: three metric-based sorts, stable ties, unknown dates, lifetime totals, weekly expiry, native navigation, persistence, desktop/mobile layout.');
} finally {
  if (browser) await browser.close();
  const stopped = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null) { child.kill(); await stopped; }
  await rm(temporary, { recursive: true, force: true });
}
async function assertEventually(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Play click did not reach the persistent store');
}
