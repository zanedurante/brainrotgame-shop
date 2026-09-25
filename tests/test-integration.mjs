import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import('../../../gameslop-games/node_modules/playwright/index.mjs'); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'gameslop-integration-'));
const python = process.env.PORTAL_PYTHON || 'python';
const child = spawn(python, ['counter/server.py', '--db', join(temporary, 'plays.sqlite3'), '--port', '0', '--site-root', '.'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.deepEqual(await page.locator('.card').evaluateAll(cards => cards.slice(0, 3).map(card => card.dataset.game)), ['deadpoint', 'bagbrawl', 'primordial']);
  assert.match(await page.locator('[data-game="deadpoint"] [data-play-count]').textContent(), /225\s*plays/);
  const screenshots = join(root, 'test-results');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true });
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url() === `${origin}/api/plays/grove`);
  await page.locator('[data-game="grove"] .play').click();
  assert.equal((await posted).headers().origin, origin);
  await page.waitForURL('https://grove.gameslop.now/');
  await assertEventually(async () => (await (await fetch(`${origin}/api/plays`)).json()).counts.grove === 1);
  const secondVisitor = await browser.newContext();
  const secondPage = await secondVisitor.newPage();
  await secondPage.goto(origin);
  await secondPage.waitForFunction(() => document.querySelector('[data-game="grove"] .count-value')?.textContent === '1');
  const ranking = await secondPage.locator('.card').evaluateAll(cards => cards.map(card => card.dataset.game));
  assert.equal(ranking[3], 'grove');
  assert.deepEqual(errors, []);
  await secondVisitor.close();
  console.log('PASS real API: seeds, shared totals, native navigation, click persistence, reranking, desktop/mobile layout.');
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
