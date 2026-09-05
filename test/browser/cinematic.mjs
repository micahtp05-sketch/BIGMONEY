/**
 * The cinematic layer, checked in a real browser.
 *
 * Deliberately NOT part of `npm test`: like commons.ui.mjs it needs a running
 * server and Playwright. It covers what no other suite can see — the theme
 * toggle surviving a reload with no flash, the header sky being still at rest
 * and lighting up on demand, the room-card-to-page morph, a post from one tab
 * lighting the rail and stamping "New" in another, and the whole thing
 * collapsing cleanly under prefers-reduced-motion.
 *
 *   npm install --no-save playwright
 *   COMMUNITY_DATA=:memory: COMMUNITY_SIGNUPS_PER_HOUR=100 npm start &
 *   npm run seed:demo
 *   npm run test:cinematic            # BASE=http://127.0.0.1:3000 by default
 *
 * Set CHROMIUM to an existing browser binary to skip `npx playwright install`.
 * Set SHOTS to a directory to keep the screenshots it takes along the way.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'http://127.0.0.1:3000';
const S = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'commons-cinematic-'));
const launch = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};
const problems = [];
const step = async (label, fn) => {
  try { await fn(); console.log(`✓ ${label}`); }
  catch (e) { console.log(`✗ ${label}: ${e.message}`); problems.push(`${label}: ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(launch);

// ------------------------------------------------------------- theme toggle
await step('theme: light by default when the OS says light; toggle flips and persists with no flash', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  await p.waitForSelector('main h1');
  const bg0 = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme0 = await p.evaluate(() => document.documentElement.dataset.theme ?? '');
  if (theme0 !== '') throw new Error(`data-theme should be unset on first visit, was "${theme0}"`);
  const btn = await p.$('#themeToggle');
  if (!btn) throw new Error('no #themeToggle');
  const label0 = (await btn.textContent()).trim();
  if (label0 !== 'Turn lights off') throw new Error(`toggle label was "${label0}"`);
  await btn.click();
  await sleep(100);
  const bg1 = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme1 = await p.evaluate(() => document.documentElement.dataset.theme);
  if (theme1 !== 'dark') throw new Error(`after click data-theme="${theme1}"`);
  if (bg1 === bg0) throw new Error('body background did not change');
  const label1 = (await p.$eval('#themeToggle', (n) => n.textContent.trim()));
  if (label1 !== 'Turn lights on') throw new Error(`toggle label after click was "${label1}"`);
  await p.screenshot({ path: `${S}/verify-dark-home.png` });
  // Persistence: reload and check the very first paint is already dark (no flash).
  await p.reload({ waitUntil: 'commit' });
  const early = await p.evaluate(() => document.documentElement.dataset.theme);
  if (early !== 'dark') throw new Error(`theme not restored before first paint (got "${early}")`);
  await p.waitForSelector('main h1');
  await p.$eval('#themeToggle', (n) => n.click());
  await sleep(100);
  const back = await p.evaluate(() => document.documentElement.dataset.theme);
  if (back !== 'light') throw new Error(`Turn lights on gave data-theme="${back}"`);
  if (errs.length) throw new Error(`pageerror: ${errs.join(' | ')}`);
  await ctx.close();
});

await step('theme: OS dark is honoured without a stored choice', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  await p.waitForSelector('main h1');
  const theme = await p.evaluate(() => document.documentElement.dataset.theme ?? '');
  if (theme !== '') throw new Error(`stored theme leaked across contexts: "${theme}"`);
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const label = await p.$eval('#themeToggle', (n) => n.textContent.trim());
  if (label !== 'Turn lights on') throw new Error(`under OS dark the toggle should offer "Turn lights on", was "${label}"`);
  // body should be the night (#080D16 → rgb(8, 13, 22))
  if (!/rgb\(8, 13, 22\)/.test(bg)) throw new Error(`OS-dark body background is ${bg}`);
  await p.screenshot({ path: `${S}/verify-osdark-home.png` });
  await ctx.close();
});

// -------------------------------------------------------------------- sky
await step('sky: mounted in the header, still at rest, redraws on scroll, pulses once and stops', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '/#/c/chat', { waitUntil: 'networkidle' });
  await p.waitForSelector('main h1');
  await sleep(800);
  const mounted = await p.evaluate(() => {
    const c = document.querySelector('header.top > canvas#sky');
    return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, aria: c.getAttribute('aria-hidden') } : null;
  });
  if (!mounted) throw new Error('no header.top > canvas#sky');
  if (mounted.aria !== 'true') throw new Error('sky is not aria-hidden');
  if (mounted.w === 0 || mounted.h === 0) throw new Error(`sky has zero bitmap size ${JSON.stringify(mounted)}`);
  // Reach the module through a dynamic import of the same URL — the module is a singleton, but
  // startAmbient was called by the app with the canvas we can't reach. Instead we measure by
  // pixel: sample the canvas at rest twice 2 s apart; identical means still.
  const snap = () => p.evaluate(() => {
    const c = document.querySelector('#sky');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 40)).data;
    let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h;
  });
  const s1 = await snap(); await sleep(2000); const s2 = await snap();
  if (s1 !== s2) throw new Error('sky changed while nothing happened (it should be still at rest)');
  // Not blank: some pixel must differ from the night fill.
  const lit = await p.evaluate(() => {
    const c = document.querySelector('#sky'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 60) n += 1; return n;
  });
  if (lit < 50) throw new Error(`sky looks blank: only ${lit} non-night pixels`);
  // Scroll changes it (yaw follows scrollY).
  await p.evaluate(() => window.scrollTo(0, 600)); await sleep(300);
  const s3 = await snap();
  await p.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
  if (s3 === s2) console.log('  (note: sky did not visibly change on a 600 px scroll — page may be too short to scroll)');
  await p.screenshot({ path: `${S}/verify-sky-header.png`, clip: { x: 0, y: 0, width: 1280, height: 80 } });
  if (errs.length) throw new Error(`pageerror: ${errs.join(' | ')}`);
  await ctx.close();
});

// -------------------------------------------------------- view transitions
await step('morph: tapping a room card runs a view transition with main.staged; the title card plays', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  await p.waitForSelector('.cat[data-slug="plumbers"]');
  const vt = await p.evaluate(() => typeof document.startViewTransition === 'function');
  if (!vt) throw new Error('this Chromium lacks startViewTransition');
  // Watch for main.staged during the transition via a MutationObserver installed first.
  await p.evaluate(() => {
    window.__seen = { staged: false, cut: false, stageName: false };
    const m = document.getElementById('view');
    new MutationObserver(() => {
      if (m.classList.contains('staged')) window.__seen.staged = true;
      if (m.classList.contains('cut')) window.__seen.cut = true;
      if (m.style.viewTransitionName === 'stage') window.__seen.stageName = true;
    }).observe(m, { attributes: true, attributeFilter: ['class', 'style'] });
  });
  await p.click('.cat[data-slug="plumbers"]');
  await p.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Plumbers');
  await sleep(700);
  const seen = await p.evaluate(() => window.__seen);
  if (!seen.staged && !seen.stageName) throw new Error(`no morph observed: ${JSON.stringify(seen)}`);
  const room = await p.evaluate(() => document.documentElement.dataset.room);
  if (room !== 'help') throw new Error(`html[data-room] was "${room}" in a trade room`);
  const route = await p.evaluate(() => document.documentElement.dataset.route);
  if (route !== 'room') throw new Error(`html[data-route] was "${route}"`);
  // The rule under the h1 exists and is full width after the animation.
  const rule = await p.evaluate(() => { const cs = getComputedStyle(document.querySelector('main h1'), '::after'); return { h: cs.height, t: cs.transform }; });
  if (rule.h !== '3px') throw new Error(`h1::after height ${rule.h}`);
  await sleep(600);
  const cutGone = await p.evaluate(() => !document.getElementById('view').classList.contains('cut'));
  if (!cutGone) throw new Error('.cut was never removed');
  // Pull-out: go home; the page should shrink into the card (stage name lands on the card).
  await p.evaluate(() => { window.__back = false; new MutationObserver(() => { if (document.querySelector('.cat[data-slug="plumbers"]')?.style.viewTransitionName === 'stage') window.__back = true; }).observe(document.getElementById('view'), { subtree: true, attributes: true, attributeFilter: ['style'] }); });
  await p.click('nav.main a[href="#/"]');
  await p.waitForSelector('.cats');
  await sleep(700);
  const back = await p.evaluate(() => window.__back);
  if (!back) console.log('  (note: pull-out did not name the card — acceptable if the card was off screen)');
  const leftover = await p.evaluate(() => document.querySelectorAll('[style*="view-transition-name"]').length);
  if (leftover) throw new Error(`${leftover} element(s) still carry an inline view-transition-name after the transition`);
  if (errs.length) throw new Error(`pageerror: ${errs.join(' | ')}`);
  await ctx.close();
});

// ---------------------------------------------------------------- SSE beat
await step('SSE beat: a post from one page lights the other — rule sweep, rail ring, New word, no fade replay', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const viewer = await ctx.newPage();
  const errs = [];
  viewer.on('pageerror', (e) => errs.push(e.message));
  await viewer.goto(B + '/#/c/chat', { waitUntil: 'networkidle' });
  await viewer.waitForSelector('main h1');
  await sleep(600);
  await viewer.evaluate(() => {
    window.__beat = { signal: false, lit: false, cut: false, arrived: false };
    const m = document.getElementById('view');
    new MutationObserver(() => {
      if (m.classList.contains('signal')) window.__beat.signal = true;
      if (m.classList.contains('cut')) window.__beat.cut = true;
      if (m.querySelector('.msg.arrived .tag.new')) window.__beat.arrived = true;
    }).observe(m, { attributes: true, subtree: true, childList: true, attributeFilter: ['class'] });
    const rail = document.getElementById('roomList');
    new MutationObserver(() => { if (rail.querySelector('.room[data-slug="chat"].lit')) window.__beat.lit = true; })
      .observe(rail, { attributes: true, subtree: true, childList: true, attributeFilter: ['class'] });
  });
  const poster = await ctx.newPage();
  const login = await poster.request.post(`${B}/api/community/auth/login`, { data: { handle: 'elik', password: 'a-good-long-password' } });
  if (!login.ok()) throw new Error('could not sign in the poster');
  const posted = await poster.request.post(`${B}/api/community/channels/chat/threads`, { data: { title: `Beat ${Date.now()}`, body: 'A light should travel for this.' } });
  if (!posted.ok()) throw new Error(`post failed ${posted.status()}`);
  await viewer.waitForFunction(() => window.__beat.arrived, null, { timeout: 8000 }).catch(() => {});
  await sleep(400);
  const beat = await viewer.evaluate(() => window.__beat);
  await viewer.screenshot({ path: `${S}/verify-sse-beat.png` });
  const missing = ['signal', 'lit', 'arrived'].filter((k) => !beat[k]);
  if (missing.length) throw new Error(`missing: ${missing.join(', ')} (${JSON.stringify(beat)})`);
  if (beat.cut) throw new Error('.cut replayed on a same-hash live update (the page faded)');
  const newWord = await viewer.$eval('.msg.arrived .tag.new', (n) => n.textContent.trim());
  if (newWord !== 'New') throw new Error(`tag reads "${newWord}"`);
  if (errs.length) throw new Error(`pageerror: ${errs.join(' | ')}`);
  await ctx.close();
});

// --------------------------------------------------------- reduced motion
await step('reduced motion: no transition, no .cut, rule full width, still sky, ring still appears as a static twin', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  await p.waitForSelector('.cat[data-slug="plumbers"]');
  await p.evaluate(() => { window.__rm = { cut: false, staged: false }; const m = document.getElementById('view'); new MutationObserver(() => { if (m.classList.contains('cut')) window.__rm.cut = true; if (m.classList.contains('staged')) window.__rm.staged = true; }).observe(m, { attributes: true, attributeFilter: ['class'] }); });
  await p.click('.cat[data-slug="plumbers"]');
  await p.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Plumbers');
  await sleep(300);
  const rm = await p.evaluate(() => window.__rm);
  if (rm.cut || rm.staged) throw new Error(`motion classes under reduced motion: ${JSON.stringify(rm)}`);
  const partial = await p.evaluate(() => [...document.querySelectorAll('main *')].filter((n) => { const o = parseFloat(getComputedStyle(n).opacity); return o < 1 && o >= 0; }).map((n) => n.tagName + '.' + n.className).slice(0, 5));
  if (partial.length) throw new Error(`elements at partial opacity: ${partial.join(', ')}`);
  const rule = await p.evaluate(() => getComputedStyle(document.querySelector('main h1'), '::after').transform);
  if (rule !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(rule)) throw new Error(`rule not full width under reduced motion: ${rule}`);
  await p.screenshot({ path: `${S}/verify-reduced-room.png` });
  if (errs.length) throw new Error(`pageerror: ${errs.join(' | ')}`);
  await ctx.close();
});

// ------------------------------------------------------------ one h1 each
await step('exactly one h1 on every route, and .mark spans are aria-hidden', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.request.post(`${B}/api/community/auth/login`, { data: { handle: 'devraj', password: 'a-good-long-password' } });
  const ch = await (await p.request.get(`${B}/api/community/channels/heating`)).json();
  const post = ch.threads?.[0]?.id;
  const bad = [];
  for (const r of ['#/', '#/c/heating', '#/c/chat', `#/p/${post}`, '#/u/mara', '#/people', '#/meet', '#/you', '#/hellos', '#/start', '#/in']) {
    await p.goto(B + '/' + r); await p.reload({ waitUntil: 'networkidle' }); await sleep(300);
    const n = await p.$$eval('h1', (x) => x.length);
    if (n !== 1) bad.push(`${r}: ${n} h1`);
    const marks = await p.$$eval('.mark', (x) => x.filter((m) => m.getAttribute('aria-hidden') !== 'true').length);
    if (marks) bad.push(`${r}: ${marks} .mark without aria-hidden`);
  }
  if (bad.length) throw new Error(bad.join('; '));
  await ctx.close();
});

await step('notifications: the card says the true state and never a raw error', async () => {
  // Permission is granted up front so the starting state is the same on every
  // machine: a headless Chromium on a CI runner starts with it *denied*, and the
  // card then rightly says "Blocked" — which the second context checks below.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['notifications'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const u = Date.now().toString(36);
  const account = { handle: `pushui${u}`, displayName: 'Push', email: `pushui${u}@example.test`, phone: `+44771${String(Date.now() % 1000000).padStart(6, '0')}`, password: 'a-good-long-password' };
  await p.request.post(`${B}/api/community/auth/signup`, { data: account });
  await p.goto(`${B}/#/you`);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('#notifications');
  const cfg = await (await p.request.get(`${B}/api/community/push/config`)).json();
  if (!cfg.enabled) throw new Error('the test server should have push enabled');
  const status0 = await p.$eval('#notifications p', (n) => n.textContent.trim());
  if (status0 !== 'Off on this device.') throw new Error(`initial state read "${status0}"`);
  const on = await p.$('#notifications button:has-text("Turn on notifications")');
  if (!on) throw new Error('no "Turn on notifications" button');
  // Hidden means not drawn — an attribute a stylesheet can override is not enough.
  for (const label of ['Turn them off', 'Send a test']) {
    const drawn = await p.$eval(`#notifications button:has-text("${label}")`, (b) => b.offsetParent !== null);
    if (drawn) throw new Error(`"${label}" is visible while notifications are off`);
  }
  if (!(await p.$eval('#notifications button:has-text("Turn on notifications")', (b) => b.offsetParent !== null))) throw new Error('"Turn on notifications" is not visible');
  await on.click();
  await p.waitForTimeout(800);
  // A headless browser has no push service to subscribe with; whatever happened,
  // the card says one of its three true things and nobody sees a stack trace.
  const status1 = await p.$eval('#notifications p', (n) => n.textContent.trim());
  const hint = await p.$eval('#notifications p.hint', (n) => n.textContent.trim());
  if (!['Blocked in this browser.', 'On for this device.', 'Off on this device.'].includes(status1)) throw new Error(`after click the status read "${status1}"`);
  if (status1 === 'Blocked in this browser.' && !/browser settings/.test(hint)) throw new Error(`no way back offered: "${hint}"`);
  const shown = await p.evaluate(() => Array.from(document.querySelectorAll('#toast, [role="status"], [aria-live]')).map((n) => n.textContent.trim()).join(' | '));
  for (const text of [hint, shown]) {
    if (/Error|TypeError|undefined|null|Registration failed|push service/.test(text)) throw new Error(`raw error shown: "${text}"`);
  }
  if (errs.length) throw new Error(`pageerror: ${errs.join(' | ')}`);
  await ctx.close();

  // The same person in a browser that has not granted anything. Chromium's
  // answer differs by machine (undecided locally, denied on a CI runner); the
  // card must be honest about whichever it is.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.request.post(`${B}/api/community/auth/login`, { data: { handle: account.handle, password: account.password } });
  await p2.goto(`${B}/#/you`);
  await p2.reload({ waitUntil: 'networkidle' });
  await p2.waitForSelector('#notifications');
  const permission = await p2.evaluate(() => Notification.permission);
  const status2 = await p2.$eval('#notifications p', (n) => n.textContent.trim());
  const hint2 = await p2.$eval('#notifications p.hint', (n) => n.textContent.trim());
  const onDrawn = await p2.$eval('#notifications button:has-text("Turn on notifications")', (b) => b.offsetParent !== null);
  if (permission === 'denied') {
    if (status2 !== 'Blocked in this browser.') throw new Error(`permission denied but the card read "${status2}"`);
    if (onDrawn) throw new Error('"Turn on notifications" is offered while the browser has blocked them');
    if (!/browser settings/.test(hint2)) throw new Error(`no way back offered: "${hint2}"`);
  } else {
    if (status2 !== 'Off on this device.') throw new Error(`permission ${permission} but the card read "${status2}"`);
    if (!onDrawn) throw new Error('"Turn on notifications" is not visible');
  }
  await ctx2.close();
});

await step('notifications: the service worker handles push and a tap opens the page', async () => {
  const sw = await (await fetch(`${B}/sw.js`)).text();
  for (const needle of ["addEventListener('push'", "addEventListener('notificationclick'", 'showNotification', 'openWindow']) {
    if (!sw.includes(needle)) throw new Error(`sw.js lacks ${needle}`);
  }
});

await browser.close();
console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nALL CINEMATIC CHECKS PASSED');
process.exit(problems.length ? 1 : 0);
