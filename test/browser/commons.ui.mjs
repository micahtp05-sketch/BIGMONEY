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

await step('home is a directory: trade rooms, groups, and somewhere to talk', async () => {
  await page.waitForSelector('.cat');
  const headings = await page.$$eval('main h2', (n) => n.map((x) => x.textContent.trim()));
  for (const h of ['Professionals', 'Groups', 'Just talk']) {
    if (!headings.includes(h)) throw new Error(`no "${h}" section: ${JSON.stringify(headings)}`);
  }
  const names = await page.$$eval('.cat .nm', (n) => n.map((x) => x.textContent.trim()));
  for (const trade of ['Electricians', 'Plumbers', 'Roofers']) {
    if (!names.includes(trade)) throw new Error(`no ${trade} room on the home page`);
  }
  if (!names.includes('Start a group')) throw new Error('no way to start a group from the home page');
  // Every hint still inside the eight-word budget, however many rooms there are.
  const hints = await page.$$eval('.cat .hn', (n) => n.map((x) => x.textContent.trim()));
  const wordy = hints.filter((h) => h.split(/\s+/).filter(Boolean).length > 8);
  if (wordy.length) throw new Error(`room hints over 8 words: ${wordy.join(' | ')}`);
  // Trade rooms say how many checked professionals they have.
  const counts = await page.$$eval('.cat.help .ct', (n) => n.map((x) => x.textContent));
  if (!counts.length || !counts.every((c) => /checked professional/.test(c))) {
    throw new Error(`trade rooms do not show a professional count: ${JSON.stringify(counts.slice(0, 3))}`);
  }
});

await step('home page renders and asks the visitor a question', async () => {
  await page.waitForSelector('main h1');
  const h1 = await page.textContent('main h1');
  if (!h1.includes('Who do you want to talk to')) throw new Error(`h1 is "${h1}"`);
  await assertNoPlaceholders('the home page');
  // "No pages of writing": at most one short orientation line under each
  // section heading, never a paragraph, and every room hint inside its budget.
  const prose = await page.$$eval('main > p, main > div:not(.cats) > p', (n) => n.map((x) => x.textContent.trim()).filter(Boolean));
  const long = prose.filter((line) => line.split(/\s+/).filter(Boolean).length > 12);
  if (long.length) throw new Error(`home page has a paragraph where a line was allowed: ${JSON.stringify(long)}`);
  if (prose.length > 3) throw new Error(`home page has ${prose.length} lines of prose; three sections means at most three`);
  const hints = await page.$$eval('.cat .hn', (n) => n.map((x) => x.textContent.trim()));
  const wordy = hints.filter((h) => h.split(/\s+/).filter(Boolean).length > 8);
  if (wordy.length) throw new Error(`category hints over 8 words: ${wordy.join(' | ')}`);
});

await step('sign up through the UI', async () => {
  await page.click('#account button:text("Sign in")');
  await page.waitForSelector('main h1:text("Join Commons")');
  await page.fill('#j-user', `browser${unique}`);
  await page.fill('#j-name', 'Browser Tester');
  await page.fill('#j-email', `browser${unique}@example.test`);
  await page.fill('#j-phone', `+4477001${unique.slice(-5).replace(/\D/g, '9').padStart(5, '9')}`);
  await page.fill('#j-pass', 'a-good-long-password');
  await page.click('button:text("Create my account")');
  await page.waitForSelector('#account button:text("Sign out")');
});

await step('an unchecked account cannot answer, list a trade, or host', async () => {
  // Asking is never gated; giving help is. Prove the second half here.
  await page.goto(`${BASE}/#/you`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('main h1:has-text("Your page")');
  if (!(await page.isVisible('.tag.warnish:has-text("Not checked")'))) {
    throw new Error('a new account is not shown as unchecked');
  }
  const tried = await page.request.patch(`${BASE}/api/community/me`, {
    data: { trade: 'Plumber', worksInTrade: true },
  });
  if (tried.ok()) throw new Error('an unchecked account was allowed to list a trade');
});

await step('a moderator checks them, and the doors open', async () => {
  await page.click('button:has-text("Ask to be checked")');
  await page.waitForSelector('dialog[open]');
  await page.fill('#dialogInput', 'I can bring a driving licence to the library.');
  await page.click('dialog button:has-text("Send")');
  await page.waitForSelector('.tag:has-text("Waiting to be checked")');

  const mod = await browser.newPage();
  const signedIn = await mod.request.post(`${BASE}/api/community/auth/login`, {
    data: { handle: 'commonsmod', password: 'a-good-long-password' },
  });
  if (!signedIn.ok()) throw new Error('the seeded moderator could not sign in');
  const decided = await mod.request.post(`${BASE}/api/community/identity/browser${unique}/decide`, {
    data: { outcome: 'verified', method: 'driving licence, seen in person', reference: 'LIB' },
  });
  if (!decided.ok()) throw new Error(`the check was refused: ${decided.status()}`);
  await mod.close();

  await page.goto(`${BASE}/#/you`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.tag.worked:has-text("Checked")');
  await assertNoPlaceholders('your own account page');
});

await step('post a question in a help channel', async () => {
  await page.goto(`${BASE}/#/c/plumbers`);
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
  await page.fill('#p-help', 'plumbing, draughts');
  await page.fill('#p-area', 'Riverside');
  await page.click('button:text("Save")');
  await page.waitForSelector('.ok');
  await page.goto(`${BASE}/#/c/plumbers`);
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
    data: {
      handle: `guest${unique}`, displayName: 'Guest Person',
      email: `guest${unique}@example.test`, phone: `+4477002${unique.slice(-5).replace(/\D/g, '8').padStart(5, '8')}`,
      password: 'a-good-long-password',
    },
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
    data: {
      handle: `nosy${unique}`,
      email: `nosy${unique}@example.test`, phone: `+4477003${unique.slice(-5).replace(/\D/g, '7').padStart(5, '7')}`,
      password: 'a-good-long-password',
    },
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

await step('a review of help given here is accepted and marked verified', async () => {
  // Set up a real interaction first: a seeded member answers the question this
  // browser user asked. Without that there is nothing verifiable to review,
  // and the server is right to refuse one.
  const channel = await (await page.request.get(`${BASE}/api/community/channels/plumbers`)).json();
  const draught = channel.threads.find((t) => t.title === 'Draught under the back door');
  if (!draught) throw new Error('the question posted earlier is missing');

  const helper = await browser.newPage();
  const signedIn = await helper.request.post(`${BASE}/api/community/auth/login`, {
    data: { handle: 'tomh', password: 'a-good-long-password' },
  });
  if (!signedIn.ok()) throw new Error('could not sign in as a seeded member');
  const answered = await helper.request.post(`${BASE}/api/community/threads/${draught.id}/replies`, {
    data: { body: 'A brush strip along the bottom sorts that.' },
  });
  if (!answered.ok()) throw new Error(`the helper could not answer: ${answered.status()}`);
  await helper.close();

  await page.goto(`${BASE}/#/u/tomh`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('main h1');
  await page.click('summary:has-text("Write a review")');
  await page.waitForSelector('#r-kind');
  await page.selectOption('#r-kind', 'helped');
  await page.selectOption('#r-rating', '5');
  await page.fill('#r-body', 'Told me to fit a brush strip. It worked.');
  await page.click('button:has-text("Post review")');
  await page.waitForSelector('.review.verified');
  if (!(await page.isVisible('.tag.worked:has-text("Helped them on Commons")'))) {
    throw new Error('a verified review is not labelled as one');
  }
  await assertNoPlaceholders('a profile with reviews');
});

await step('an unverifiable review is accepted but labelled', async () => {
  await page.goto(`${BASE}/#/u/joanb`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('summary:has-text("Write a review")');
  await page.waitForSelector('#r-kind');
  await page.selectOption('#r-kind', 'hired');
  await page.fill('#r-body', 'Built us a set of shelves.');
  await page.click('button:has-text("Post review")');
  await page.waitForSelector('.review');
  if (!(await page.isVisible('.tag.warnish'))) throw new Error('an unchecked review is not labelled');
  if (await page.$('.review.verified')) throw new Error('a hired review must not read as verified');
});

await step('the server refuses a verified review that never happened', async () => {
  // Straight at the API, because the form will not offer the option.
  const res = await page.request.post(`${BASE}/api/community/people/priyas/reviews`, {
    data: { kind: 'helped', rating: 5, body: 'Never met them.', threadId: 'not-a-real-thread' },
  });
  if (res.ok()) throw new Error('a fabricated verified review was accepted');
});

await step('the directory ranks by reviews but still shows newcomers', async () => {
  await page.goto(`${BASE}/#/people`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.person');
  const headings = await page.$$eval('main h2', (n) => n.map((x) => x.textContent.trim()));
  if (!headings.includes('Best reviewed')) throw new Error(`no ranked section: ${JSON.stringify(headings)}`);
  if (!headings.includes('No reviews yet')) {
    throw new Error(`newcomers have no section of their own: ${JSON.stringify(headings)}`);
  }
  // The order the server sent must survive into the page.
  const sent = await (await page.request.get(`${BASE}/api/community/people`)).json();
  // The page lists "Free to talk now" first and keeps those people out of the
  // ranked section, so the expected order skips them too.
  const ranked = sent.people.filter((p) => !p.openToChat && p.reviews && p.reviews.count > 0).map((p) => p.displayName);
  const shown = await page.$$eval('main h2:text("Best reviewed") + p + .people .person h3', (n) => n.map((x) => x.textContent.trim()));
  if (shown.length && ranked.length && shown[0] !== ranked[0]) {
    throw new Error(`top of the ranked list is ${shown[0]}, server said ${ranked[0]}`);
  }
  await assertNoPlaceholders('the people directory');
});

await step('finds people by the trade they claim', async () => {
  await page.goto(`${BASE}/#/you`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#p-trade', 'Roofer');
  await page.check('label.toggle:has-text("for a living") input');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('.ok');

  await page.goto(`${BASE}/#/people`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#tradeq', 'roof');
  await page.click('button:has-text("Find")');
  await page.waitForSelector('.person');
  if (!(await page.isVisible('.tag.trade:has-text("Roofer")'))) throw new Error('trade not shown on the card');
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
    data: {
      handle: `sse${unique}`,
      email: `sse${unique}@example.test`, phone: `+4477004${unique.slice(-5).replace(/\D/g, '6').padStart(5, '6')}`,
      password: 'a-good-long-password',
    },
  });
  await other.request.post(`${BASE}/api/community/channels/chat/threads`, {
    data: { title: `Live from another window ${unique}`, body: `Did this appear ${unique}?` },
  });
  await page.waitForSelector(`.msg .body:text("Did this appear ${unique}")`, { timeout: 5000 });
  const after = (await page.$$('.msg')).length;
  if (after !== before + 1) throw new Error(`before=${before} after=${after}`);
  await other.close();
});

await step('a moderator can put back something three people hid', async () => {
  // Post something, then have three members report it into hiding.
  await page.goto(`${BASE}/#/c/chat`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#msg', `Contested message ${unique}`);
  await page.click('button:has-text("Send")');
  await page.waitForSelector(`.msg .body:has-text("Contested message ${unique}")`);

  const channel = await (await page.request.get(`${BASE}/api/community/channels/chat`)).json();
  const target = channel.threads.find((t) => t.body.includes(`Contested message ${unique}`));
  if (!target) throw new Error('the message just posted is missing');

  for (const n of [1, 2, 3]) {
    const reporter = await browser.newPage();
    await reporter.request.post(`${BASE}/api/community/auth/signup`, {
      data: {
        handle: `rep${n}${unique}`,
        email: `rep${n}${unique}@example.test`, phone: `+447700${n}${unique.slice(-5).replace(/\D/g, '5').padStart(5, '5')}`,
        password: 'a-good-long-password',
      },
    });
    const res = await reporter.request.post(`${BASE}/api/community/report`, {
      data: { kind: 'thread', id: target.id, reason: `objection ${n}` },
    });
    if (!res.ok()) throw new Error(`report ${n} failed: ${res.status()}`);
    await reporter.close();
  }

  // A moderator signs in and finds it, with the reasons attached.
  const mod = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await mod.goto(BASE, { waitUntil: 'networkidle' });
  const signedIn = await mod.request.post(`${BASE}/api/community/auth/login`, {
    data: { handle: 'commonsmod', password: 'a-good-long-password' },
  });
  if (!signedIn.ok()) throw new Error('the seeded moderator could not sign in');
  await mod.goto(`${BASE}/#/mod`);
  await mod.reload({ waitUntil: 'networkidle' });
  await mod.waitForSelector('main h1:has-text("Reports")');
  await mod.waitForSelector('.card:has-text("objection 1")');
  if (!(await mod.isVisible('.tag.warnish:has-text("Hidden right now")'))) {
    throw new Error('the queue does not show that the post is hidden');
  }

  // Put it back, with a reason.
  mod.once('dialog', () => {});
  await mod.click('.card:has-text("objection 1") button:has-text("Put it back")');
  await mod.waitForSelector('dialog[open]');
  await mod.fill('#dialogInput', 'Blunt, but nothing against the rules.');
  await mod.click('dialog button:has-text("Put it back")');
  await mod.waitForSelector('.card:has-text("Put back")');
  await assertNoPlaceholders('the moderation queue');

  // It is readable again by an ordinary member.
  const back = await page.request.get(`${BASE}/api/community/threads/${target.id}`);
  if (!back.ok()) throw new Error('keeping it did not put it back');
  await mod.close();
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
