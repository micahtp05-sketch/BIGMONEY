/**
 * Checks that Commons is genuinely installable as an app, and that going
 * offline degrades the way it is meant to.
 *
 * Not part of `npm test` — it needs a running server and a real browser.
 *
 *   COMMUNITY_DATA=:memory: PORT=3210 npm start &
 *   BASE=http://127.0.0.1:3210 npm run test:pwa
 *
 * Set CHROMIUM to an existing browser binary to skip `npx playwright install`.
 */
import { chromium } from 'playwright';

const BASE = (process.env.BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const problems = [];
const step = async (label, fn) => {
  try { await fn(); console.log(`✓ ${label}`); }
  catch (e) { console.log(`✗ ${label}: ${e.message}`); problems.push(`${label}: ${e.message}`); }
};

const launch = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 412, height: 880 } });
const page = await context.newPage();

let manifest;

await step('the manifest is served and parses', async () => {
  const res = await page.request.get(`${BASE}/manifest.webmanifest`);
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  manifest = JSON.parse(await res.text());
});

await step('the manifest has everything an install needs', async () => {
  const required = ['name', 'short_name', 'start_url', 'display', 'icons'];
  const missing = required.filter((k) => !manifest[k]);
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) {
    throw new Error(`display is "${manifest.display}" — a browser will not treat that as an app`);
  }
  const sizes = manifest.icons.map((i) => i.sizes);
  for (const need of ['192x192', '512x512']) {
    if (!sizes.includes(need)) throw new Error(`no ${need} icon`);
  }
  if (!manifest.icons.some((i) => (i.purpose ?? '').includes('maskable'))) {
    throw new Error('no maskable icon — Android will letterbox the icon in a white box');
  }
});

await step('every icon actually loads at its declared size', async () => {
  for (const icon of manifest.icons) {
    const res = await page.request.get(BASE + icon.src);
    if (!res.ok()) throw new Error(`${icon.src} -> HTTP ${res.status()}`);
    const body = await res.body();
    if (body.subarray(1, 4).toString() !== 'PNG') throw new Error(`${icon.src} is not a PNG`);
    // PNG IHDR carries width and height as big-endian uint32 at bytes 16 and 20.
    const w = body.readUInt32BE(16);
    const h = body.readUInt32BE(20);
    const [dw, dh] = icon.sizes.split('x').map(Number);
    if (w !== dw || h !== dh) throw new Error(`${icon.src} is ${w}x${h}, declared ${icon.sizes}`);
  }
});

await step('the page points at the manifest and an iOS icon', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (!(await page.$('link[rel="manifest"]'))) throw new Error('no <link rel="manifest">');
  if (!(await page.$('link[rel="apple-touch-icon"]'))) {
    throw new Error('no apple-touch-icon — the iPhone home screen would show a screenshot');
  }
  if (!(await page.$('meta[name="theme-color"]'))) throw new Error('no theme-color');
});

await step('the service worker registers and takes control', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const active = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  if (!active) throw new Error('no active service worker');
});

await step('the app still opens with no connection', async () => {
  // Give the worker a moment to finish filling the shell cache.
  await page.waitForTimeout(1200);
  await context.setOffline(true);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const text = await page.evaluate(() => document.body.innerText);
    if (/ERR_INTERNET_DISCONNECTED|No internet/i.test(text)) {
      throw new Error('got the browser error page, not the app');
    }
    if (!(await page.$('header.top'))) throw new Error('the app shell did not render');
  } finally {
    await context.setOffline(false);
  }
});

await step('community data is never served stale from the cache', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await context.setOffline(true);
  try {
    const status = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/community/channels', { credentials: 'same-origin' });
        return res.status;
      } catch {
        return 'network error';
      }
    });
    if (status !== 'network error') {
      throw new Error(`offline API call returned ${status} — the worker is caching community data`);
    }
  } finally {
    await context.setOffline(false);
  }
});

await browser.close();
console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nAPP INSTALL CHECKS PASSED');
process.exit(problems.length ? 1 : 0);
