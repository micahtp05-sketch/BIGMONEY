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

await step('sidebar lists seeded channels in three groups', async () => {
  await page.waitForSelector('#channelNav .navgroup');
  const groups = await page.$$eval('#channelNav .navgroup h3', (n) => n.map((x) => x.textContent));
  if (groups.length !== 3) throw new Error(`groups=${JSON.stringify(groups)}`);
});

await step('home page renders', async () => {
  await page.waitForSelector('main h1');
  const h1 = await page.textContent('main h1');
  if (!h1.includes('Commons')) throw new Error(h1);
  await assertNoPlaceholders('the home page');
});

await step('sign up through the UI', async () => {
  await page.click('#account button');
  await page.waitForSelector('main h1:text("Join Commons")');
  await page.fill('.card input >> nth=0', `browser${unique}`);
  await page.fill('.card input >> nth=1', 'Browser Tester');
  await page.fill('input[type=password]', 'a-good-long-password');
  await page.click('button:text("Create account")');
  await page.waitForSelector('#account a:text("Browser Tester")');
});

await step('post a question in a help channel', async () => {
  await page.goto(`${BASE}/#/c/home-repair`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('summary');
  await page.fill('label.field:has(span:text("Title")) input', 'Draught under the back door');
  await page.fill('textarea', 'Cold air comes in even with the door shut. Tried a rolled towel.');
  await page.fill('label.field:has(span:text("Tags")) input', 'draughts, doors');
  await page.click('button:text("Ask")');
  await page.waitForSelector('main h1:text("Draught under the back door")');
  if (!(await page.isVisible('.chip:text("#draughts")'))) throw new Error('tags not shown');
});

await step('reply, and an unaccepted reply renders nothing extra', async () => {
  await page.fill('.card textarea', 'Fit a brush strip to the bottom of the door.');
  await page.click('button:text("Reply")');
  await page.waitForSelector('.reply');
  await assertNoPlaceholders('an unaccepted reply');
});

await step('mark the reply as the answer', async () => {
  await page.click('button:text("This solved it")');
  await page.waitForSelector('.reply.accepted');
  if (!(await page.isVisible('.chip.answered'))) throw new Error('no answered chip');
  await assertNoPlaceholders('an accepted reply');
});

await step('profile skills produce a topic badge', async () => {
  await page.click('#account a >> nth=0');
  await page.waitForSelector('main h1:text("Your profile")');
  await page.fill('label.field:has(span:text("Skills, comma separated")) input', 'carpentry, draughts');
  await page.fill('label.field:has(span:text("Neighbourhood")) input', 'Riverside');
  await page.click('button:text("Save")');
  await page.waitForSelector('.ok');
  await page.goto(`${BASE}/#/c/home-repair`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.thread-item');
  if (!(await page.isVisible('.chip.topic'))) throw new Error('expected a "says they know" chip');
});

await step('create a meetup and RSVP state renders', async () => {
  await page.goto(`${BASE}/#/c/walks-and-coffee`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('summary');
  await page.fill('label.field:has(span:text("Title")) input', 'Sunday morning loop');
  await page.fill('textarea', 'Slow pace, about an hour.');
  await page.check('main label.check input');
  await page.fill('input[type=datetime-local]', new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16));
  await page.fill('label.field:has(span:text("Where")) input', 'Bench by the pond');
  await page.click('button:text("Post")');
  await page.waitForSelector('button:text("Can\'t make it")');
  await assertNoPlaceholders('a meetup thread');
});

await step("what's on lists the meetup", async () => {
  await page.click('.navlink[data-route="#/meetups"]');
  await page.waitForSelector('main h1:text("What\'s on")');
  if (!(await page.isVisible('.thread-item .t:text("Sunday morning loop")'))) throw new Error('meetup missing');
});

await step('members page shows open-to-chat presence', async () => {
  await page.check('#account label.check input');
  await page.click('.navlink[data-route="#/people"]');
  await page.waitForSelector('main h1:text("Members")');
  await page.waitForSelector('.presence');
  await assertNoPlaceholders('the members page');
});

await step('search finds the thread by title', async () => {
  await page.fill('#searchInput', 'draught');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('main h1:text("Search: draught")');
  if (!(await page.$$('.thread-item')).length) throw new Error('no search hits');
});

await step('live update arrives over SSE', async () => {
  await page.goto(`${BASE}/#/c/front-porch`);
  await page.reload({ waitUntil: 'networkidle' });
  // A hash change does not reload, so wait for the channel itself to render
  // before counting — otherwise the count is whatever the last view left.
  await page.waitForSelector('main h1:text("The Front Porch")');
  const before = (await page.$$('.thread-item')).length;

  const other = await browser.newPage();
  await other.request.post(`${BASE}/api/community/auth/signup`, {
    data: { handle: `sse${unique}`, password: 'a-good-long-password' },
  });
  await other.request.post(`${BASE}/api/community/channels/front-porch/threads`, {
    data: { title: `Live from another window ${unique}`, body: 'Did this appear?' },
  });
  await page.waitForSelector(`.thread-item .t:text("Live from another window ${unique}")`, { timeout: 5000 });
  const after = (await page.$$('.thread-item')).length;
  if (after !== before + 1) throw new Error(`before=${before} after=${after}`);
  await other.close();
});

await step('a post renders as text, never as markup', async () => {
  await page.request.post(`${BASE}/api/community/channels/front-porch/threads`, {
    data: { title: `<img src=x onerror="window.__xss=1"> ${unique}`, body: '<script>window.__xss=1<\/script>' },
  });
  await page.goto(`${BASE}/#/c/front-porch`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.thread-item');
  if (await page.evaluate(() => window.__xss)) throw new Error('markup executed');
  if (await page.$('.thread-item img')) throw new Error('markup was parsed into the DOM');
  const titles = await page.$$eval('.thread-item .t', (n) => n.map((x) => x.textContent));
  if (!titles.some((t) => t.includes('<img src=x'))) throw new Error('title not shown verbatim');
});

await browser.close();
console.log(errors.length ? `\nPROBLEMS:\n${errors.join('\n')}` : '\nALL UI CHECKS PASSED');
process.exit(errors.length ? 1 : 0);
