/**
 * Fill a Commons instance with a plausible day of activity.
 *
 * Six empty channels tell you nothing about whether the thing works —
 * you cannot see an accepted answer, a waitlisted meetup, or a skill badge
 * until somebody has posted. This creates six members and a dozen threads
 * through the public API, exactly as a browser would, so what you end up
 * looking at is the real code path and not a fixture.
 *
 *   COMMUNITY_SIGNUPS_PER_HOUR=100 COMMUNITY_MODERATORS=commonsmod npm start &
 *   npm run seed:demo
 *
 * Every account it creates shares one well-known password, so it refuses to
 * run against anything but localhost, and refuses to add to an instance that
 * already has members. Both guards are overridable; read what they say before
 * you do it.
 */

const BASE = (process.env.BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const API = `${BASE}/api/community`;
const PASSWORD = process.env.DEMO_PASSWORD ?? 'a-good-long-password';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function call(path, { method = 'GET', body, cookie } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    fail(`Could not reach ${BASE} — is the server running?\n  ${error.message}`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 429 && path === '/auth/signup') {
    fail(
      'The signup rate limit refused these accounts.\n' +
      'Restart the server with the cap raised, then run this again:\n' +
      '  COMMUNITY_SIGNUPS_PER_HOUR=100 npm start',
    );
  }
  if (!res.ok) fail(`${method} ${path} -> ${res.status} ${data.error ?? ''}`);
  const setCookie = res.headers.get('set-cookie');
  return { data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

// ---------------------------------------------------------------- the guards

const host = new URL(BASE).hostname;
if (!LOCAL.has(host) && process.env.SEED_ALLOW_REMOTE !== '1') {
  fail(
    `Refusing to seed ${BASE}: every account below shares the password "${PASSWORD}".\n` +
    'If you really mean to do this to a remote instance, set SEED_ALLOW_REMOTE=1 —\n' +
    'and set DEMO_PASSWORD to something of your own first.',
  );
}

const { data: health } = await call('/health');
if (health.members > 0 && process.env.SEED_FORCE !== '1') {
  fail(
    `This instance already has ${health.members} member(s) and ${health.threads} thread(s).\n` +
    'Seeding on top would mix demo accounts into real ones. Start a fresh instance:\n' +
    '  COMMUNITY_DATA=:memory: COMMUNITY_SIGNUPS_PER_HOUR=100 npm start\n' +
    'or set SEED_FORCE=1 if you are certain.',
  );
}

// ---------------------------------------------------------------- the people

let phoneSeq = 0;

async function member(handle, displayName, profile) {
  phoneSeq += 1;
  const { data, cookie } = await call('/auth/signup', {
    method: 'POST',
    body: {
      handle,
      displayName,
      email: `${handle}@example.test`,
      phone: `+44770090${String(phoneSeq).padStart(4, '0')}`,
      password: PASSWORD,
    },
  });
  return { id: data.user.id, cookie, handle, displayName, profile };
}

/**
 * Put somebody through the identity check, the way a moderator would.
 * Needed before anyone can answer a question, list a trade or host anything.
 */
async function check(person, moderatorCookie) {
  await call('/identity/request', {
    method: 'POST', cookie: person.cookie,
    body: { note: 'Showed a driving licence at the library desk.' },
  });
  await call(`/identity/${person.handle}/decide`, {
    method: 'POST', cookie: moderatorCookie,
    body: { outcome: 'verified', method: 'driving licence, seen in person', reference: 'LIB' },
  });
}

/** Profiles are applied after any identity check they depend on. */
async function applyProfile(person) {
  await call('/me', { method: 'PATCH', cookie: person.cookie, body: person.profile });
}

const DAY = 86_400_000;

// A moderator, so the reports queue is reachable in the demo. Only becomes one
// if the server was started with COMMUNITY_MODERATORS=commonsmod.
const moderator = await member('commonsmod', 'Sam Okonkwo', {
  bio: 'Keeps an eye on reports. Ask me if something looks wrong.',
  neighborhood: 'Riverside',
  skills: [],
});

const mara = await member('mara', 'Mara Ellis', {
  bio: 'Retired heating engineer. Happy to talk anyone through a boiler.',
  neighborhood: 'Riverside',
  skills: ['plumbing', 'hvac', 'appliances'],
  openToChat: true,
  trade: 'Heating engineer',
  worksInTrade: true,
});
const dev = await member('devraj', 'Dev Raj', {
  bio: 'Bad at gardening, learning in public. Two kids, one very old cat.',
  neighborhood: 'Northgate',
  skills: ['computers', 'wifi'],
});
const joan = await member('joanb', 'Joan Baptiste', {
  bio: 'Eighty-one and still baking. Come and eat something.',
  neighborhood: 'Riverside',
  skills: ['cooking', 'baking', 'sewing'],
  openToChat: true,
});
const tom = await member('tomh', 'Tom Halloran', {
  bio: 'Carpenter. Will lend almost any tool if you bring it back sharp.',
  neighborhood: 'The Mills',
  skills: ['carpentry', 'tools', 'woodworking'],
  trade: 'Carpenter',
  worksInTrade: true,
});
const priya = await member('priyas', 'Priya Shah', {
  bio: 'New here. Walking most mornings if anyone wants company.',
  neighborhood: 'Northgate',
  skills: ['gardening'],
  openToChat: true,
});
const eli = await member('elik', 'Eli Kowalski', {
  bio: 'Night shifts, so I am awake when nobody else is.',
  neighborhood: 'The Mills',
  skills: ['electrical'],
  trade: 'Electrician',
  worksInTrade: true,
});

// The moderator does the checking, so they go first — seeded by
// COMMUNITY_MODERATORS, which the run instructions set.
await applyProfile(moderator);
const modCookie = moderator.cookie;
for (const person of [mara, dev, joan, tom, priya, eli]) {
  await check(person, modCookie);
  await applyProfile(person);
}

// ------------------------------------------ a question that gets answered well

const radiator = (await call('/channels/heating/threads', {
  method: 'POST',
  cookie: dev.cookie,
  body: {
    title: 'Upstairs radiator is cold at the top, hot at the bottom',
    body:
      'It has been like this since the weather turned. The rest of the house is fine — this is the only one. I turned the thermostat right up and gave it an hour, no change.\n\n' +
      'Is this something I can do myself or am I calling somebody?',
    tags: ['heating', 'radiators'],
  },
})).data.thread;

const bleed = (await call(`/threads/${radiator.id}/replies`, {
  method: 'POST',
  cookie: mara.cookie,
  body: {
    body:
      'Cold at the top and hot at the bottom is air trapped in it — that is the classic pattern, and it is a ten minute job.\n\n' +
      'Turn the heating off and let it cool. You want a radiator key, about a pound from any hardware shop. Put a bowl and an old towel underneath, open the valve at the top corner a quarter turn, and you will hear the air hiss out. The second water comes instead of air, close it.\n\n' +
      'Check the boiler pressure afterwards — bleeding drops it. If it is below one bar, top it up with the filling loop. Nobody needs to be called for this one.',
  },
})).data.reply;

await call(`/threads/${radiator.id}/replies`, {
  method: 'POST',
  cookie: eli.cookie,
  body: { body: 'Agreed. One thing to add: if it goes cold again in a fortnight, air is getting back in from somewhere and that part is worth a professional.' },
});
await call(`/replies/${bleed.id}/helpful`, { method: 'POST', cookie: priya.cookie });
await call(`/replies/${bleed.id}/helpful`, { method: 'POST', cookie: tom.cookie });
await call(`/threads/${radiator.id}/accept`, {
  method: 'POST',
  cookie: dev.cookie,
  body: { replyId: bleed.id },
});

// ------------------------------------------------------- the rest of the help

await call('/channels/plumbers/threads', {
  method: 'POST',
  cookie: joan.cookie,
  body: {
    title: 'Washing machine, twelve years old, drum bearing gone. Repair or replace?',
    body: 'The repair man quoted £180 and said it would likely give me another three or four years. A new one of the same make is £430. I do not know how to think about this.',
    tags: ['appliances'],
    // What the estimator hands back when you photograph the machine.
    estimate: {
      title: 'Bosch Serie 6 washing machine, used',
      estimateCents: 21500, lowCents: 17000, highCents: 26000,
      currency: 'USD', confidence: 0.64, sampleSize: 11,
    },
  },
});
await call('/channels/plumbers/threads', {
  method: 'POST', cookie: tom.cookie,
  body: {
    title: 'Tile saw, SDS drill and a decent extension ladder, all free to borrow',
    body: 'They sit in my garage doing nothing eleven months of the year. Message here and pick them up whenever. Only rule is you bring it back in the state it left in.',
    tags: ['lending'],
  },
});
await call('/channels/landscapers/threads', {
  method: 'POST', cookie: priya.cookie,
  body: {
    title: 'Something is stripping my tomato plants overnight',
    body: 'Leaves gone, stems left standing. No slug trails that I can see. Happening on three plants out of eight.',
    tags: ['pests', 'tomatoes'],
  },
});
await call('/channels/tech/threads', {
  method: 'POST', cookie: joan.cookie,
  body: {
    title: 'The wifi drops every evening around seven and comes back by ten',
    body: 'My grandson says it is "congestion" but he is fourteen and I do not think he knows either.',
    tags: ['wifi'],
  },
});

// ------------------------------------------------------------- the social side

const walk = (await call('/channels/meetups/threads', {
  method: 'POST', cookie: priya.cookie,
  body: {
    title: 'Saturday morning loop round the park, slow pace',
    body: 'About an hour, flat the whole way, and there is a café at the end for anyone who wants one. No need to talk if you would rather not — turning up is the whole thing. I will message you the meeting spot.',
    meetup: { startsAt: Date.now() + 3 * DAY, capacity: 8 },
  },
})).data.thread;
for (const who of [joan, dev, mara]) {
  await call(`/threads/${walk.id}/rsvp`, { method: 'POST', cookie: who.cookie });
}

const supper = (await call('/channels/meetups/threads', {
  method: 'POST', cookie: joan.cookie,
  body: {
    title: 'Sunday table at mine — six seats, bring nothing',
    body: 'I cook far too much for one person and always have. Six chairs, one o\'clock, and I mean it about bringing nothing. Riverside — I will send you the address once you say you are coming.',
    meetup: { startsAt: Date.now() + 5 * DAY, capacity: 6 },
  },
})).data.thread;
for (const who of [eli, priya]) {
  await call(`/threads/${supper.id}/rsvp`, { method: 'POST', cookie: who.cookie });
}

const porch = (await call('/channels/chat/threads', {
  method: 'POST', cookie: eli.cookie,
  body: {
    title: 'Anyone else awake?',
    body: 'Finished a night shift and the house is very quiet. No particular reason for posting, just saying it out loud somewhere.',
  },
})).data.thread;
await call(`/threads/${porch.id}/replies`, {
  method: 'POST', cookie: joan.cookie,
  body: { body: 'I am up. I am always up at this hour. The kettle is on if that helps any.' },
});
await call(`/threads/${porch.id}/replies`, {
  method: 'POST', cookie: mara.cookie,
  body: { body: 'Awake too. Post again tomorrow and somebody will answer then as well.' },
});

await call('/channels/chat/threads', {
  method: 'POST', cookie: mara.cookie,
  body: {
    title: 'Thursday check-in',
    body: 'Say one thing about your day, however small. I will start: the good chair got moved into the sun and I have not moved since.',
  },
});
await call('/channels/book-club/threads', {
  method: 'POST', cookie: joan.cookie,
  body: {
    title: 'Cooking lot: made too much soup again',
    body: 'Leek and potato, four portions spare, Riverside. First to say so can have them. We swap what we have cooked most weeks, so say hello if you want in.',
  },
});
await call('/channels/book-club/threads', {
  method: 'POST', cookie: dev.cookie,
  body: {
    title: 'Book club this month: anything you did not finish',
    body: 'Reverse book club. Bring the book you gave up on and tell us where you stopped. No shame in it, that is rather the point.',
  },
});

// ---------------------------------------------------------------- reviews

// One anchored to the radiator question the server can actually check, and two
// about paid work that it cannot — which is the distinction on display.
await call('/people/mara/reviews', {
  method: 'POST', cookie: dev.cookie,
  body: {
    kind: 'helped', rating: 5, threadId: radiator.id,
    body: 'Talked me through bleeding it step by step and would not let me call anyone. Took ten minutes.',
  },
});
await call('/people/tomh/reviews', {
  method: 'POST', cookie: joan.cookie,
  body: { kind: 'hired', rating: 5, body: 'Put up shelves in the back room. Tidy, on time, cleared up after himself.' },
});
await call('/people/tomh/reviews', {
  method: 'POST', cookie: priya.cookie,
  body: { kind: 'hired', rating: 4, body: 'Good work on a door frame. Took a while to get a date out of him.' },
});

await call('/waves', {
  method: 'POST', cookie: joan.cookie,
  body: { toUserId: dev.id, note: 'Saw you got the radiator sorted. Well done.' },
});

// ------------------------------------------------------------------- the recap

if (moderator) { /* referenced so the account is obviously deliberate */ }

const { data: after } = await call('/health');
console.log(`
Seeded ${BASE}
  ${after.members} members, ${after.threads} threads across ${after.channels} channels

Sign in as any of these — the password for all of them is "${PASSWORD}":
  devraj   asked the radiator question, and has an unread wave
  mara     answered it, and is credited with the accepted answer
  joanb    hosts the Sunday table, open to chat
  priyas   hosts the Saturday walk, open to chat
  tomh     lends out tools
  elik     posts at odd hours
  commonsmod  a moderator, if COMMUNITY_MODERATORS=commonsmod was set

Worth a look:
  /#/c/home-repair    an accepted answer, and a repair-or-replace question with a price estimate
  /#/meetups          two meetups with RSVPs
  /#/people           who is open to chat right now
  /#/c/chat           somebody posting at 3am, answered inside the hour
`);
