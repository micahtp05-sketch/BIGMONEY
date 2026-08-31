/**
 * Browser pass over Commons.
 *
 * Deliberately NOT part of `npm test`: it needs a running server and a real
 * browser, and the unit suite's promise is that it runs offline with no
 * dependencies beyond the ones in package.json. Run it by hand when the client
 * changes — most of what it catches (a null rendered into the page, an event
 * that never arrives, markup escaping into the DOM) is invisible to the API
 * tests.
 *
 *   npm install --no-save playwright
 *   COMMUNITY_DATA=:memory: PORT=3210 npm start &
 *   BASE=http://127.0.0.1:3210 node test/browser/commons.ui.mjs
 *
 * Set CHROMIUM to an existing browser binary to skip `npx playwright install`.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const errors = [];

const launch = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const step = async (label, fn) => {
  try { await fn(); console.log(`✓ ${label}`); }
  catch (e) { console.log(`✗ ${label}: ${e.message}`); errors.push(`${label}: ${e.message}`); }
};

/** A stray "null"/"undefined" in the page means a falsy child reached append(). */
const assertNoPlaceholders = async (where) => {
  const stray = await page.$$eval('main *', (nodes) =>
    nodes.flatMap((n) => [...n.childNodes]
      .filter((c) => c.nodeType === 3 && /^\s*(null|undefined)\s*$/.test(c.textContent))
      .map(() => n.className || n.tagName)));
  if (stray.length) throw new Error(`placeholder text rendered in ${where}: ${stray.join(', ')}`);
};

const unique = Date.now().toString(36);
await page.goto(BASE, { waitUntil: 'networkidle' });
// The app registers a service worker. Let it finish installing before any
// step reloads, or a reload can race a half-populated shell cache.
await page.evaluate(() => navigator.serviceWorker?.ready).catch(() => {});
await page.waitForTimeout(600);

await step('home shows six categories under two headings', async () => {
  await page.waitForSelector('.cat');
  const cards = await page.$$('.cat');
  if (cards.length !== 6) throw new Error(`expected 6 category cards, found ${cards.length}`);
  const headings = await page.$$eval('main h2', (n) => n.map((x) => x.textContent));
  if (!headings.includes('Ask for help') || !headings.includes('Meet people')) {
    throw new Error(`headings=${JSON.stringify(headings)}`);
  }
  // The standard caps a category name at 3 words; check the rendered names.
  const names = await page.$$eval('.cat .nm', (n) => n.map((x) => x.textContent));
  const tooLong = names.filter((n) => n.replace(/&/g, '').split(/\s+/).filter(Boolean).length > 3);
  if (tooLong.length) throw new Error(`category names over 3 words: ${tooLong.join(', ')}`);
});

await step('home page renders and asks the visitor a question', async () => {
  await page.waitForSelector('main h1');
  const h1 = await page.textContent('main h1');
  if (!h1.includes('What do you need')) throw new Error(`h1 is "${h1}"`);
  await assertNoPlaceholders('the home page');
  // "No pages of writing" means two things, both checkable: no explanatory
  // prose outside the cards, and every category hint inside its word budget.
  const prose = await page.$$eval('main > p, main > div:not(.cats) > p', (n) => n.map((x) => x.textContent.trim()).filter(Boolean));
  if (prose.length) throw new Error(`home page has prose outside the cards: ${JSON.stringify(prose)}`);
  const hints = await page.$$eval('.cat .hn', (n) => n.map((x) => x.textContent.trim()));
  const wordy = hints.filter((h) => h.split(/\s+/).filter(Boolean).length > 8);
  if (wordy.length) throw new Error(`category hints over 8 words: ${wordy.join(' | ')}`);
});

await step('sign up through the UI', async () => {
  await page.click('#account button:text("Sign in")');
  await page.waitForSelector('main h1:text("Join Commons")');
  await page.fill('#j-user', `browser${unique}`);
  await page.fill('#j-name', 'Browser Tester');
  await page.fill('#j-pass', 'a-good-long-password');
  await page.click('button:text("Create my account")');
  await page.waitForSelector('#account button:text("Sign out")');
});

await step('post a question in a help channel', async () => {
  await page.goto(`${BASE}/#/c/home-repair`);
  await page.reload({ waitUntil: 'networkidle' });
  // The ask box is visible on load now — no disclosure to open first.
  await page.fill('#q-title', 'Draught under the back door');
  await page.fill('#q-body', 'Cold air comes in even with the door shut. Tried a rolled towel.');
  await page.click('button:text("Add a photo or subjects")');
  await page.fill('#q-subjects', 'draughts, doors');
  await page.click('button:text("Ask")');
  await page.waitForSelector('main h1:text("Draught under the back door")');
  if (!(await page.isVisible('.tag:text("draughts")'))) throw new Error('subjects not shown');
});

await step('reply, and an unaccepted reply renders nothing extra', async () => {
  await page.fill('#answer', 'Fit a brush strip to the bottom of the door.');
  await page.click('button:text("Send")');
  await page.waitForSelector('.answer');
  await assertNoPlaceholders('an answer');
});

await step('mark the reply as the answer', async () => {
  await page.click('button:text("This one worked")');
  await page.waitForSelector('.answer.worked');
  if (!(await page.isVisible('.tag.worked'))) throw new Error('no "answer that worked" mark');
  await assertNoPlaceholders('the answer that worked');
});

await step('profile skills produce a topic badge', async () => {
  await page.click('nav.main a:text("You")');
  await page.waitForSelector('main h1:text("Your page")');
  await page.fill('#p-help', 'carpentry, draughts');
  await page.fill('#p-area', 'Riverside');
  await page.click('button:text("Save")');
  await page.waitForSelector('.ok');
  await page.goto(`${BASE}/#/c/home-repair`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.post');
  await page.click('.post .t:text("Draught under the back door")');
  await page.waitForSelector('.answer');
  if (!(await page.isVisible('.tag.knows'))) throw new Error('expected a "says they know" mark');
});

await step('create a meetup and RSVP state renders', async () => {
  await page.goto(`${BASE}/#/c/meetups`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('button:text("Plan a get-together")');
  await page.waitForSelector('main h1:text("Plan a get-together")');
  await page.fill('#g-title', 'Sunday morning loop');
  await page.fill('#g-body', 'Slow pace, about an hour.');
  await page.fill('#g-when', new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16));
  await page.click('button:text("Post it")');
  await page.waitForSelector('button:text("I cannot come")');
  await assertNoPlaceholders('a get-together');
});

await step('the host sends the address privately and only the guest sees it', async () => {
  // The host is the signed-in browser user who just created the get-together.
  const meetupUrl = await page.evaluate(() => location.hash);
  if (!meetupUrl.startsWith('#/p/')) throw new Error(`expected to be on the get-together, got ${meetupUrl}`);
  const threadId = meetupUrl.slice(4);

  // A second person says they are coming, which opens their channel.
  const guest = await browser.newPage();
  await guest.request.post(`${BASE}/api/community/auth/signup`, {
    data: { handle: `guest${unique}`, displayName: 'Guest Person', password: 'a-good-long-password' },
  });
  await guest.request.post(`${BASE}/api/community/threads/${threadId}/rsvp`);

  // The host opens that conversation and sends the address.
  await page.reload({ waitUntil: 'networkidle' });
  // :has-text matches an ancestor by its whole text; :text would resolve to the
  // inner span rather than the button.
  await page.waitForSelector('button.post:has-text("Guest Person")');
  await page.click('button.post:has-text("Guest Person")');
  await page.waitForSelector('#pm');
  await page.fill('#pm', 'We are at 14 Mill Lane, the blue door.');
  // The answer form also has a Send button; target this one exactly.
  await page.click('#pm-send');
  await page.waitForSelector('.msg .body:has-text("blue door")');
  await assertNoPlaceholders("the host's private conversation");

  // The guest sees it on their own page.
  await guest.goto(`${BASE}/#/p/${threadId}`, { waitUntil: 'networkidle' });
  await guest.waitForSelector('.msg .body:has-text("blue door")', { timeout: 8000 });
  // Same check, on the guest's page — this is where the last null slipped through.
  const strayForGuest = await guest.$$eval('main *', (nodes) =>
    nodes.flatMap((n) => [...n.childNodes]
      .filter((c) => c.nodeType === 3 && /^\s*(null|undefined)\s*$/.test(c.textContent))
      .map(() => n.className || n.tagName)));
  if (strayForGuest.length) throw new Error(`placeholder text on the guest's page: ${strayForGuest.join(', ')}`);

  // Nobody else does — not even on the page, and not from the API.
  const outsider = await browser.newPage();
  await outsider.request.post(`${BASE}/api/community/auth/signup`, {
    data: { handle: `nosy${unique}`, password: 'a-good-long-password' },
  });
  await outsider.goto(`${BASE}/#/p/${threadId}`, { waitUntil: 'networkidle' });
  await outsider.waitForSelector('main h1');
  await outsider.waitForTimeout(600);
  const visible = await outsider.evaluate(() => document.body.innerText);
  if (visible.includes('Mill Lane')) throw new Error('an outsider can read the address on the page');
  const probe = await outsider.request.get(`${BASE}/api/community/threads/${threadId}/messages`);
  if (probe.ok()) {
    const body = await probe.text();
    if (body.includes('Mill Lane')) throw new Error('the API handed the address to an outsider');
  }
  await guest.close();
  await outsider.close();
});

await step("what's on lists the meetup", async () => {
  await page.click('nav.main a:text("Together")');
  await page.waitForSelector('main h1:text("Get-togethers")');
  if (!(await page.isVisible('.post .t:text("Sunday morning loop")'))) throw new Error('get-together missing');
});

await step('members page shows open-to-chat presence', async () => {
  await page.click('nav.main a:text("You")');
  await page.waitForSelector('main h1:text("Your page")');
  await page.check('label.toggle input');
  await page.click('nav.main a:text("People")');
  await page.waitForSelector('main h1:text("People")');
  await page.waitForSelector('.free');
  await assertNoPlaceholders('the people page');
});

await step('search finds the thread by title', async () => {
  await page.fill('#searchInput', 'draught');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('main h1:text("Search")');
  if (!(await page.$$('.post')).length) throw new Error('no search hits');
});

await step('live update arrives over SSE', async () => {
  await page.goto(`${BASE}/#/c/chat`);
  await page.reload({ waitUntil: 'networkidle' });
  // A hash change does not reload, so wait for the channel itself to render
  // before counting — otherwise the count is whatever the last view left.
  await page.waitForSelector('main h1:text("Chat & Check In")');
  // A social category renders as a chat stream, so messages are .msg not .post.
  const before = (await page.$$('.msg')).length;

  const other = await browser.newPage();
  await other.request.post(`${BASE}/api/community/auth/signup`, {
    data: { handle: `sse${unique}`, password: 'a-good-long-password' },
  });
  await other.request.post(`${BASE}/api/community/channels/chat/threads`, {
    data: { title: `Live from another window ${unique}`, body: `Did this appear ${unique}?` },
  });
  await page.waitForSelector(`.msg .body:text("Did this appear ${unique}")`, { timeout: 5000 });
  const after = (await page.$$('.msg')).length;
  if (after !== before + 1) throw new Error(`before=${before} after=${after}`);
  await other.close();
});

await step('a post renders as text, never as markup', async () => {
  await page.request.post(`${BASE}/api/community/channels/chat/threads`, {
    data: { title: `<img src=x onerror="window.__xss=1"> ${unique}`, body: '<script>window.__xss=1<\/script>' },
  });
  await page.goto(`${BASE}/#/c/chat`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.msg');
  if (await page.evaluate(() => window.__xss)) throw new Error('markup executed');
  if (await page.$('main img')) throw new Error('markup was parsed into the DOM');
  const bodies = await page.$$eval('.msg .body', (n) => n.map((x) => x.textContent));
  if (!bodies.some((t) => t.includes('<script>'))) throw new Error('message not shown verbatim');
});

await browser.close();
console.log(errors.length ? `\nPROBLEMS:\n${errors.join('\n')}` : '\nALL UI CHECKS PASSED');
process.exit(errors.length ? 1 : 0);
