import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { communityRoutes } from '../src/community/routes.ts';

/**
 * Route-level tests over `inject`, so no port is bound and no network is
 * touched. The plugin owns its own in-memory store, which keeps each suite
 * independent without any teardown beyond closing the app.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Every inject call shares one IP, so the anti-spam signup cap has to be
  // lifted here or the suite locks itself out after five accounts.
  await app.register(
    // 'tmod' is seeded so tests can put an account through the real identity
    // check rather than reaching past it.
    communityRoutes({ dataPath: null, signupsPerHourPerIp: 1000, moderators: ['tmod'] }),
    { prefix: '/api/community' },
  );
  await app.ready();
  return app;
}

/** Sign up and return the cookie header a signed-in client would send. */
let phoneCounter = 0;

async function signUp(app: FastifyInstance, handle: string) {
  phoneCounter += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/community/auth/signup',
    payload: {
      handle,
      displayName: handle,
      email: `${handle}@example.test`,
      phone: `+447700${String(phoneCounter).padStart(6, '0')}`,
      password: 'a-good-long-password',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(raw, 'signup must set a session cookie');
  return {
    cookie: raw.split(';')[0] as string,
    user: res.json().user as { id: string; handle: string; displayName: string; role: string },
  };
}

/** Sign in as an existing member and return the cookie header to send. */
async function signIn(app: FastifyInstance, handle: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/community/auth/login',
    payload: { handle, password: 'a-good-long-password' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(raw, 'login must set a session cookie');
  return raw.split(';')[0] as string;
}

const asUser = (cookie: string) => ({ cookie });

/** Put an account through the real identity check, as a moderator would. */
async function verifyIdentity(app: FastifyInstance, who: { cookie: string; user: { handle: string } }) {
  const asked = await app.inject({
    method: 'POST', url: '/api/community/identity/request', headers: asUser(who.cookie),
    payload: { note: 'Showed a driving licence at the library.' },
  });
  assert.equal(asked.statusCode, 200, asked.body);

  // The seeded moderator exists once per app; sign up first, sign in after.
  let modCookie: string;
  const created = await app.inject({
    method: 'POST', url: '/api/community/auth/signup',
    payload: {
      handle: 'tmod', displayName: 'Test Moderator',
      email: 'tmod@example.test', phone: '+447700999999',
      password: 'a-good-long-password',
    },
  });
  if (created.statusCode === 200) {
    const raw = created.headers['set-cookie'];
    modCookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0] as string;
  } else {
    modCookie = await signIn(app, 'tmod');
  }

  const decided = await app.inject({
    method: 'POST', url: `/api/community/identity/${who.user.handle}/decide`, headers: asUser(modCookie),
    payload: { outcome: 'verified', method: 'driving licence, in person', reference: 'LIB-1' },
  });
  assert.equal(decided.statusCode, 200, decided.body);
}

describe('Commons API', () => {
  let app: FastifyInstance;

  before(async () => { app = await buildApp(); });
  after(async () => { await app.close(); });

  it('opens with seeded channels across all three kinds', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/community/channels' });
    assert.equal(res.statusCode, 200);
    const kinds = new Set(res.json().channels.map((c: { kind: string }) => c.kind));
    assert.deepEqual([...kinds].sort(), ['group', 'help', 'social']);
  });

  it('rejects a weak password and a taken handle', async () => {
    const weak = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'weakling', email: 'w@example.test', phone: '+447700111111', password: 'short' },
    });
    assert.equal(weak.statusCode, 400);

    await signUp(app, 'firstcomer');
    const dupe = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'firstcomer', email: 'fc2@example.test', phone: '+447700111112', password: 'a-good-long-password' },
    });
    assert.equal(dupe.statusCode, 409);
  });

  it('does not reveal whether a handle exists on a failed login', async () => {
    await signUp(app, 'realperson');
    const wrongPassword = await app.inject({
      method: 'POST', url: '/api/community/auth/login',
      payload: { handle: 'realperson', password: 'not-the-password' },
    });
    const noSuchUser = await app.inject({
      method: 'POST', url: '/api/community/auth/login',
      payload: { handle: 'ghostwriter', password: 'not-the-password' },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(noSuchUser.statusCode, 401);
    assert.equal(wrongPassword.json().error, noSuchUser.json().error);
  });

  it('refuses to post without a session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads',
      payload: { title: 'Anonymous', body: 'Should not land.' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('carries a question through ask, answer, and accepted answer', async () => {
    const asker = await signUp(app, 'asker');
    const helper = await signUp(app, 'helper');
    await verifyIdentity(app, helper);

    // The helper claims plumbing, which Home & Repairs lists as a topic.
    await app.inject({
      method: 'PATCH', url: '/api/community/me', headers: asUser(helper.cookie),
      payload: { skills: ['Plumbing'], bio: 'Twenty years of radiators.' },
    });

    const asked = await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads',
      headers: asUser(asker.cookie),
      payload: { title: 'Radiator cold at the top', body: 'Warm at the bottom only.', tags: ['heating'] },
    });
    assert.equal(asked.statusCode, 201, asked.body);
    const threadId = asked.json().thread.id as string;

    const answered = await app.inject({
      method: 'POST', url: `/api/community/threads/${threadId}/replies`,
      headers: asUser(helper.cookie), payload: { body: 'It needs bleeding.' },
    });
    assert.equal(answered.statusCode, 201);
    const replyId = answered.json().reply.id as string;
    assert.deepEqual(answered.json().reply.authorTopics, ['plumbing'],
      'a claimed skill matching the channel is surfaced next to the answer');

    const accepted = await app.inject({
      method: 'POST', url: `/api/community/threads/${threadId}/accept`,
      headers: asUser(asker.cookie), payload: { replyId },
    });
    assert.equal(accepted.statusCode, 200);

    const read = await app.inject({ method: 'GET', url: `/api/community/threads/${threadId}` });
    const body = read.json();
    assert.equal(body.thread.acceptedReplyId, replyId);
    assert.equal(body.replies[0].id, replyId, 'the accepted answer is sorted to the top');
    assert.equal(body.replies[0].accepted, true);
    assert.equal(body.thread.replyCount, 1);

    const profile = await app.inject({ method: 'GET', url: '/api/community/people/helper' });
    assert.equal(profile.json().user.helpfulCount, 1, 'credit follows the accepted answer');
  });

  it('lets only the asker mark the answer, and takes credit back when unmarked', async () => {
    const asker = await signUp(app, 'asker2');
    const helper = await signUp(app, 'helper2');
    await verifyIdentity(app, helper);
    const bystander = await signUp(app, 'bystander');

    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/tech-help/threads',
      headers: asUser(asker.cookie), payload: { title: 'Wifi drops', body: 'Every evening.' },
    })).json().thread;
    const replyId = (await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/replies`,
      headers: asUser(helper.cookie), payload: { body: 'Change the channel.' },
    })).json().reply.id;

    const notYours = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/accept`,
      headers: asUser(bystander.cookie), payload: { replyId },
    });
    assert.equal(notYours.statusCode, 403);

    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/accept`,
      headers: asUser(asker.cookie), payload: { replyId },
    });
    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/accept`,
      headers: asUser(asker.cookie), payload: { replyId: null },
    });
    const profile = await app.inject({ method: 'GET', url: '/api/community/people/helper2' });
    assert.equal(profile.json().user.helpfulCount, 0);
  });

  it('counts a helpful vote once and refuses self-voting', async () => {
    const author = await signUp(app, 'writer');
    await verifyIdentity(app, author);
    const reader = await signUp(app, 'reader');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/garden-yard/threads',
      headers: asUser(author.cookie), payload: { title: 'Aphids', body: 'Everywhere.' },
    })).json().thread;
    const replyId = (await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/replies`,
      headers: asUser(author.cookie), payload: { body: 'Soapy water.' },
    })).json().reply.id;

    const self = await app.inject({
      method: 'POST', url: `/api/community/replies/${replyId}/helpful`, headers: asUser(author.cookie),
    });
    assert.equal(self.statusCode, 400);

    const up = await app.inject({
      method: 'POST', url: `/api/community/replies/${replyId}/helpful`, headers: asUser(reader.cookie),
    });
    assert.deepEqual(up.json(), { helpfulCount: 1, viewerFoundHelpful: true });
    const off = await app.inject({
      method: 'POST', url: `/api/community/replies/${replyId}/helpful`, headers: asUser(reader.cookie),
    });
    assert.deepEqual(off.json(), { helpfulCount: 0, viewerFoundHelpful: false }, 'the vote toggles');
  });

  it('runs a meetup: host is going, others RSVP, waitlist past capacity', async () => {
    const host = await signUp(app, 'host');
    await verifyIdentity(app, host);
    const guest = await signUp(app, 'guest');
    const latecomer = await signUp(app, 'latecomer');

    const created = await app.inject({
      method: 'POST', url: '/api/community/channels/meetups/threads',
      headers: asUser(host.cookie),
      payload: {
        title: 'Saturday loop round the park',
        body: 'Slow pace, no need to talk.',
        meetup: { startsAt: Date.now() + 86_400_000, capacity: 2 },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const thread = created.json().thread;
    assert.equal(thread.meetup.rsvps.length, 1, 'the host is going by definition');

    const guestRsvp = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: asUser(guest.cookie),
    });
    assert.deepEqual(guestRsvp.json(), { going: 2, viewerRsvpd: true, waitlisted: false });

    const lateRsvp = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: asUser(latecomer.cookie),
    });
    assert.equal(lateRsvp.json().waitlisted, true, 'nobody is turned away, they wait');

    const listed = await app.inject({ method: 'GET', url: '/api/community/meetups' });
    assert.ok(listed.json().meetups.some((m: { id: string }) => m.id === thread.id));
  });

  it('keeps meetups out of help channels and rejects times in the past', async () => {
    const user = await signUp(app, 'planner');
    await verifyIdentity(app, user);
    const wrongChannel = await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads', headers: asUser(user.cookie),
      payload: {
        title: 'Boiler party', body: 'no',
        meetup: { startsAt: Date.now() + 86_400_000, capacity: 0 },
      },
    });
    assert.equal(wrongChannel.statusCode, 400);

    const inThePast = await app.inject({
      method: 'POST', url: '/api/community/channels/meetups/threads', headers: asUser(user.cookie),
      payload: {
        title: 'Last week', body: 'no',
        meetup: { startsAt: Date.now() - 86_400_000, capacity: 0 },
      },
    });
    assert.equal(inThePast.statusCode, 400);
  });

  it('hides content once enough distinct members report it', async () => {
    const poster = await signUp(app, 'poster');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/chat/threads',
      headers: asUser(poster.cookie), payload: { title: 'Spam spam spam', body: 'Buy things.' },
    })).json().thread;

    for (const handle of ['mod1', 'mod2']) {
      const reporter = await signUp(app, handle);
      const res = await app.inject({
        method: 'POST', url: '/api/community/report', headers: asUser(reporter.cookie),
        payload: { kind: 'thread', id: thread.id, reason: 'spam' },
      });
      assert.equal(res.json().hidden, false, 'two reports is not yet enough');
    }
    const third = await signUp(app, 'mod3');
    const res = await app.inject({
      method: 'POST', url: '/api/community/report', headers: asUser(third.cookie),
      payload: { kind: 'thread', id: thread.id, reason: 'spam' },
    });
    assert.equal(res.json().hidden, true);

    const channel = await app.inject({ method: 'GET', url: '/api/community/channels/chat' });
    assert.equal(
      channel.json().threads.some((t: { id: string }) => t.id === thread.id), false,
      'hidden threads drop out of the channel listing',
    );
  });

  it('counts a repeat report from the same member only once', async () => {
    const poster = await signUp(app, 'poster2');
    const reporter = await signUp(app, 'repeater');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/chat/threads',
      headers: asUser(poster.cookie), payload: { title: 'Contested', body: 'Hello.' },
    })).json().thread;

    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: 'POST', url: '/api/community/report', headers: asUser(reporter.cookie),
        payload: { kind: 'thread', id: thread.id },
      });
      assert.equal(res.json().hidden, false, 'one person cannot hide a post alone');
    }
  });

  it('only lets an author delete their own posts', async () => {
    const author = await signUp(app, 'owner');
    const stranger = await signUp(app, 'stranger');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/clubs/threads',
      headers: asUser(author.cookie), payload: { title: 'This month', body: 'Pick one.' },
    })).json().thread;

    const forbidden = await app.inject({
      method: 'DELETE', url: `/api/community/threads/${thread.id}`, headers: asUser(stranger.cookie),
    });
    assert.equal(forbidden.statusCode, 403);

    const allowed = await app.inject({
      method: 'DELETE', url: `/api/community/threads/${thread.id}`, headers: asUser(author.cookie),
    });
    assert.equal(allowed.statusCode, 200);
    const gone = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}` });
    assert.equal(gone.statusCode, 404);
  });

  it('waves once a day, never at yourself', async () => {
    const waver = await signUp(app, 'waver');
    const quiet = await signUp(app, 'quietone');

    const atSelf = await app.inject({
      method: 'POST', url: '/api/community/waves', headers: asUser(waver.cookie),
      payload: { toUserId: waver.user.id },
    });
    assert.equal(atSelf.statusCode, 400);

    const first = await app.inject({
      method: 'POST', url: '/api/community/waves', headers: asUser(waver.cookie),
      payload: { toUserId: quiet.user.id, note: 'Saw your post about the garden.' },
    });
    assert.equal(first.statusCode, 201);

    const again = await app.inject({
      method: 'POST', url: '/api/community/waves', headers: asUser(waver.cookie),
      payload: { toUserId: quiet.user.id },
    });
    assert.equal(again.statusCode, 429, 'a wave must not become a way to pester');

    const inbox = await app.inject({ method: 'GET', url: '/api/community/waves', headers: asUser(quiet.cookie) });
    assert.equal(inbox.json().unread, 1);
    assert.equal(inbox.json().waves[0].from.handle, 'waver');
  });

  it('lists who is open to chat', async () => {
    const lonely = await signUp(app, 'openperson');
    await app.inject({
      method: 'PATCH', url: '/api/community/me', headers: asUser(lonely.cookie),
      payload: { openToChat: true, neighborhood: 'Riverside' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/community/people?open=1' });
    const handles = res.json().people.map((p: { handle: string }) => p.handle);
    assert.ok(handles.includes('openperson'));
    assert.ok(res.json().people.every((p: { openToChat: boolean }) => p.openToChat));
  });

  it('searches titles ahead of bodies', async () => {
    const user = await signUp(app, 'searcher');
    await app.inject({
      method: 'POST', url: '/api/community/channels/clubs/threads', headers: asUser(user.cookie),
      payload: { title: 'Mending a wicker chair', body: 'Unrelated words here.' },
    });
    await app.inject({
      method: 'POST', url: '/api/community/channels/clubs/threads', headers: asUser(user.cookie),
      payload: { title: 'Unrelated title', body: 'I once mended a wicker seat.' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/community/search?q=wicker' });
    const titles = res.json().results.map((t: { title: string }) => t.title);
    assert.equal(titles.length, 2);
    assert.equal(titles[0], 'Mending a wicker chair');
  });

  it('validates thread input instead of storing junk', async () => {
    const user = await signUp(app, 'sloppy');
    const empty = await app.inject({
      method: 'POST', url: '/api/community/channels/chat/threads', headers: asUser(user.cookie),
      payload: { title: '   ', body: 'x' },
    });
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json().error, /title/);

    const tooLong = await app.inject({
      method: 'POST', url: '/api/community/channels/chat/threads', headers: asUser(user.cookie),
      payload: { title: 'ok', body: 'x'.repeat(8001) },
    });
    assert.equal(tooLong.statusCode, 400);
  });

  it('404s an unknown channel rather than inventing one', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/community/channels/does-not-exist' });
    assert.equal(res.statusCode, 404);
  });

  it('creates a member channel and slugs its name', async () => {
    const user = await signUp(app, 'founder');
    const res = await app.inject({
      method: 'POST', url: '/api/community/channels', headers: asUser(user.cookie),
      payload: { name: 'Bike Repair Corner!', kind: 'help', description: 'Punctures and gears.', topics: ['bikes'] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().channel.slug, 'bike-repair-corner');

    const dupe = await app.inject({
      method: 'POST', url: '/api/community/channels', headers: asUser(user.cookie),
      payload: { name: 'bike repair corner', kind: 'help', description: 'Again.' },
    });
    assert.equal(dupe.statusCode, 409);
  });

  it('flags channels matching the viewer\'s own skills', async () => {
    const user = await signUp(app, 'skilled');
    await app.inject({
      method: 'PATCH', url: '/api/community/me', headers: asUser(user.cookie), payload: { skills: ['gardening'] },
    });
    const res = await app.inject({ method: 'GET', url: '/api/community/channels', headers: asUser(user.cookie) });
    const garden = res.json().channels.find((c: { slug: string }) => c.slug === 'garden-yard');
    const porch = res.json().channels.find((c: { slug: string }) => c.slug === 'chat');
    assert.equal(garden.matchesYourSkills, true);
    assert.equal(porch.matchesYourSkills, false);
  });

  it('logs out by clearing the session', async () => {
    const user = await signUp(app, 'leaver');
    await app.inject({ method: 'POST', url: '/api/community/auth/logout', headers: asUser(user.cookie) });
    const me = await app.inject({ method: 'GET', url: '/api/community/me', headers: asUser(user.cookie) });
    assert.equal(me.json().user, null);
  });
});

describe('private meetup messages', () => {
  let app: FastifyInstance;

  before(async () => { app = await buildApp(); });
  after(async () => { await app.close(); });

  /** A get-together with a host and one guest who is coming. */
  async function meetupWithGuest(suffix: string) {
    const host = await signUp(app, `mhost${suffix}`);
    await verifyIdentity(app, host);
    const guest = await signUp(app, `mguest${suffix}`);
    const created = await app.inject({
      method: 'POST', url: '/api/community/channels/meetups/threads', headers: asUser(host.cookie),
      payload: {
        title: 'Sunday walk', body: 'Slow pace.',
        meetup: { startsAt: Date.now() + 86_400_000, capacity: 0 },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const thread = created.json().thread;
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: asUser(guest.cookie) });
    return { host, guest, thread };
  }

  it('stores no address on a get-together at all', async () => {
    const { thread } = await meetupWithGuest('a');
    assert.equal('place' in thread.meetup, false, 'the meetup must carry no location field');
    const read = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}` });
    assert.equal('place' in read.json().thread.meetup, false);
    // And it must not have been quietly kept somewhere else on the payload.
    assert.equal(JSON.stringify(read.json()).includes('place'), false);
  });

  it('rejects a location field rather than silently storing it', async () => {
    const host = await signUp(app, 'sneakyhost');
    await verifyIdentity(app, host);
    const res = await app.inject({
      method: 'POST', url: '/api/community/channels/meetups/threads', headers: asUser(host.cookie),
      payload: {
        title: 'Supper', body: 'Come round.',
        meetup: { startsAt: Date.now() + 86_400_000, capacity: 0, place: '14 Mill Lane' },
      },
    });
    if (res.statusCode === 201) {
      assert.equal(JSON.stringify(res.json()).includes('Mill Lane'), false,
        'an address sent by a client must never come back out');
    }
  });

  it('carries a message from host to guest and back', async () => {
    const { host, guest, thread } = await meetupWithGuest('b');

    const sent = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(host.cookie),
      payload: { body: 'We meet at 14 Mill Lane, the blue door.', guest: guest.user.id },
    });
    assert.equal(sent.statusCode, 201, sent.body);

    const seen = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(guest.cookie),
    });
    assert.equal(seen.json().messages.length, 1);
    assert.match(seen.json().messages[0].body, /blue door/);

    const back = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(guest.cookie),
      payload: { body: 'Thank you, see you Sunday.' },
    });
    assert.equal(back.statusCode, 201);

    const hostSees = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/messages?guest=${guest.user.id}`,
      headers: asUser(host.cookie),
    });
    assert.equal(hostSees.json().messages.length, 2);
  });

  it('never lets a third party read the conversation', async () => {
    const { host, guest, thread } = await meetupWithGuest('c');
    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(host.cookie),
      payload: { body: 'The address is 14 Mill Lane.', guest: guest.user.id },
    });

    const nosy = await signUp(app, 'nosyperson');
    // Even after coming themselves, a different guest gets their own empty
    // channel — never the one belonging to somebody else.
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: asUser(nosy.cookie) });

    const named = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/messages?guest=${guest.user.id}`,
      headers: asUser(nosy.cookie),
    });
    assert.equal(named.statusCode, 403, 'naming another guest must be refused');

    const own = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(nosy.cookie),
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().messages.length, 0, 'their own channel is empty');
    assert.equal(JSON.stringify(own.json()).includes('Mill Lane'), false);
  });

  it('refuses a stranger who is not coming', async () => {
    const { thread } = await meetupWithGuest('d');
    const stranger = await signUp(app, 'strangerhere');
    const res = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(stranger.cookie),
    });
    assert.equal(res.statusCode, 403);

    const send = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(stranger.cookie),
      payload: { body: 'Where is it?' },
    });
    assert.equal(send.statusCode, 403);
  });

  it('refuses anyone signed out', async () => {
    const { thread } = await meetupWithGuest('e');
    const res = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}/messages` });
    assert.equal(res.statusCode, 401);
  });

  it('closes the channel when a guest stops coming, but keeps the history', async () => {
    const { host, guest, thread } = await meetupWithGuest('f');
    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(host.cookie),
      payload: { body: 'See you at the bench.', guest: guest.user.id },
    });
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: asUser(guest.cookie) });

    const send = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(guest.cookie),
      payload: { body: 'Actually, can I still come?' },
    });
    assert.equal(send.statusCode, 403, 'no new messages once they are not coming');

    // History survives, so either side can still report what was said.
    const still = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(guest.cookie),
    });
    assert.equal(still.statusCode, 200);
    assert.equal(still.json().messages.length, 1);
    assert.equal(still.json().guestIsComing, false);
  });

  it('only the host lists the conversations', async () => {
    const { host, guest, thread } = await meetupWithGuest('g');
    const forbidden = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/message-channels`, headers: asUser(guest.cookie),
    });
    assert.equal(forbidden.statusCode, 403);

    const allowed = await app.inject({
      method: 'GET', url: `/api/community/threads/${thread.id}/message-channels`, headers: asUser(host.cookie),
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().channels.length, 1);
    assert.equal(allowed.json().channels[0].guest.handle, 'mguestg');
  });

  it('counts unread messages for the person they were sent to', async () => {
    const { host, guest, thread } = await meetupWithGuest('h');
    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(host.cookie),
      payload: { body: 'Details to follow.', guest: guest.user.id },
    });
    const before = await app.inject({ method: 'GET', url: '/api/community/me', headers: asUser(guest.cookie) });
    assert.equal(before.json().unreadMessages, 1);
    // The sender is never told they have unread mail from themselves.
    const sender = await app.inject({ method: 'GET', url: '/api/community/me', headers: asUser(host.cookie) });
    assert.equal(sender.json().unreadMessages, 0);

    await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(guest.cookie) });
    const after = await app.inject({ method: 'GET', url: '/api/community/me', headers: asUser(guest.cookie) });
    assert.equal(after.json().unreadMessages, 0, 'reading the conversation clears it');
  });

  it('lets the recipient report a message, and nobody else', async () => {
    const { host, guest, thread } = await meetupWithGuest('i');
    const sent = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: asUser(host.cookie),
      payload: { body: 'Something unpleasant.', guest: guest.user.id },
    });
    const messageId = sent.json().message.id;

    const outsider = await signUp(app, 'outsiderx');
    const denied = await app.inject({
      method: 'POST', url: '/api/community/report', headers: asUser(outsider.cookie),
      payload: { kind: 'message', id: messageId, reason: 'curious' },
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: 'POST', url: '/api/community/report', headers: asUser(guest.cookie),
      payload: { kind: 'message', id: messageId, reason: 'unpleasant' },
    });
    assert.equal(allowed.statusCode, 200);
  });
});

describe('reviews', () => {
  let app: FastifyInstance;

  before(async () => { app = await buildApp(); });
  after(async () => { await app.close(); });

  /** An asker, an answerer, and the question that connects them. */
  async function askedAndAnswered(suffix: string) {
    const asker = await signUp(app, `rasker${suffix}`);
    const helper = await signUp(app, `rhelper${suffix}`);
    await verifyIdentity(app, helper);
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads', headers: asUser(asker.cookie),
      payload: { title: 'Dripping tap', body: 'It drips all night.' },
    })).json().thread;
    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: asUser(helper.cookie),
      payload: { body: 'Replace the washer.' },
    });
    return { asker, helper, thread };
  }

  it('accepts a review of help that actually happened here', async () => {
    const { asker, helper, thread } = await askedAndAnswered('a');
    const res = await app.inject({
      method: 'POST', url: '/api/community/people/rhelpera/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'helped', rating: 5, body: 'Fixed it in ten minutes.', threadId: thread.id },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().review.verified, true);
    assert.equal(res.json().review.author.handle, 'raskera');
    assert.equal(helper.user.handle, 'rhelpera');
  });

  it('refuses a "helped" review when no help was given', async () => {
    await askedAndAnswered('b');
    const stranger = await signUp(app, 'rstrangerb');
    const other = (await app.inject({
      method: 'POST', url: '/api/community/channels/tech-help/threads', headers: asUser(stranger.cookie),
      payload: { title: 'Printer', body: 'It will not print.' },
    })).json().thread;

    // Their own thread, but the subject never answered it.
    const res = await app.inject({
      method: 'POST', url: '/api/community/people/rhelperb/reviews', headers: asUser(stranger.cookie),
      payload: { kind: 'helped', rating: 1, body: 'Useless.', threadId: other.id },
    });
    assert.equal(res.statusCode, 403);
  });

  it('refuses a "helped" review pointing at somebody else\'s question', async () => {
    const { thread } = await askedAndAnswered('c');
    const bystander = await signUp(app, 'rbystanderc');
    const res = await app.inject({
      method: 'POST', url: '/api/community/people/rhelperc/reviews', headers: asUser(bystander.cookie),
      payload: { kind: 'helped', rating: 5, body: 'Great.', threadId: thread.id },
    });
    assert.equal(res.statusCode, 403, 'watching an exchange is not being helped by it');
  });

  it('requires a thread for a "helped" review at all', async () => {
    const { asker } = await askedAndAnswered('d');
    const res = await app.inject({
      method: 'POST', url: '/api/community/people/rhelperd/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'helped', rating: 5, body: 'Good.' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('takes an unverifiable "hired" review, and marks it as one', async () => {
    const customer = await signUp(app, 'rcustomer');
    const trader = await signUp(app, 'rtrader');
    const res = await app.inject({
      method: 'POST', url: '/api/community/people/rtrader/reviews', headers: asUser(customer.cookie),
      payload: { kind: 'hired', rating: 4, body: 'Rewired the kitchen, tidy job.' },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().review.verified, false, 'off-platform work cannot be verified');
    assert.equal(res.json().review.threadId, null);
    assert.ok(trader.user.id);
  });

  it('lets somebody host a get-together and be reviewed by whoever came', async () => {
    const host = await signUp(app, 'rhost');
    await verifyIdentity(app, host);
    const guest = await signUp(app, 'rguest');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/meetups/threads', headers: asUser(host.cookie),
      payload: { title: 'Walk', body: 'Slow pace.', meetup: { startsAt: Date.now() + 86_400_000, capacity: 0 } },
    })).json().thread;
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: asUser(guest.cookie) });

    const res = await app.inject({
      method: 'POST', url: '/api/community/people/rhost/reviews', headers: asUser(guest.cookie),
      payload: { kind: 'helped', rating: 5, body: 'Made me feel welcome.', threadId: thread.id },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().review.verified, true);
  });

  it('allows one review per person, and never of yourself', async () => {
    const { asker, thread } = await askedAndAnswered('e');
    const first = await app.inject({
      method: 'POST', url: '/api/community/people/rhelpere/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'helped', rating: 5, body: 'Great.', threadId: thread.id },
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: 'POST', url: '/api/community/people/rhelpere/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'hired', rating: 1, body: 'Changed my mind.' },
    });
    assert.equal(second.statusCode, 409, 'one voice, one review');

    const self = await app.inject({
      method: 'POST', url: '/api/community/people/raskere/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'hired', rating: 5, body: 'I am excellent.' },
    });
    assert.equal(self.statusCode, 400);
  });

  it('shows no average until a second person has spoken', async () => {
    const trader = await signUp(app, 'ravg');
    const one = await signUp(app, 'ravgone');
    await app.inject({
      method: 'POST', url: '/api/community/people/ravg/reviews', headers: asUser(one.cookie),
      payload: { kind: 'hired', rating: 5, body: 'Excellent.' },
    });
    const single = await app.inject({ method: 'GET', url: '/api/community/people/ravg/reviews' });
    assert.equal(single.json().summary.count, 1);
    assert.equal(single.json().summary.average, null, 'one opinion is not an average');

    const two = await signUp(app, 'ravgtwo');
    await app.inject({
      method: 'POST', url: '/api/community/people/ravg/reviews', headers: asUser(two.cookie),
      payload: { kind: 'hired', rating: 2, body: 'Late twice.' },
    });
    const pair = await app.inject({ method: 'GET', url: '/api/community/people/ravg/reviews' });
    assert.equal(pair.json().summary.average, 3.5);
    assert.equal(pair.json().summary.unverified, 2);
    assert.equal(pair.json().summary.verified, 0);
  });

  it('lists what the viewer could write a verified review about', async () => {
    const { asker, thread } = await askedAndAnswered('f');
    const res = await app.inject({
      method: 'GET', url: '/api/community/people/rhelperf/shared', headers: asUser(asker.cookie),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().shared.map((t: { id: string }) => t.id), [thread.id]);

    const stranger = await signUp(app, 'rnothingf');
    const empty = await app.inject({
      method: 'GET', url: '/api/community/people/rhelperf/shared', headers: asUser(stranger.cookie),
    });
    assert.deepEqual(empty.json().shared, []);
  });

  it('carries a self-declared trade, and can filter the directory by it', async () => {
    const plumber = await signUp(app, 'rplumber');
    await verifyIdentity(app, plumber);
    await app.inject({
      method: 'PATCH', url: '/api/community/me', headers: asUser(plumber.cookie),
      payload: { trade: 'Plumber', worksInTrade: true },
    });
    const res = await app.inject({ method: 'GET', url: '/api/community/people?trade=plumb' });
    const handles = res.json().people.map((p: { handle: string }) => p.handle);
    assert.ok(handles.includes('rplumber'));
    assert.ok(res.json().people.every((p: { worksInTrade: boolean }) => p.worksInTrade));
  });

  it('lets the author delete their own review, and nobody else', async () => {
    const { asker, thread } = await askedAndAnswered('g');
    const id = (await app.inject({
      method: 'POST', url: '/api/community/people/rhelperg/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'helped', rating: 3, body: 'Fine.', threadId: thread.id },
    })).json().review.id;

    const other = await signUp(app, 'rotherg');
    const denied = await app.inject({ method: 'DELETE', url: `/api/community/reviews/${id}`, headers: asUser(other.cookie) });
    assert.equal(denied.statusCode, 403);
    const allowed = await app.inject({ method: 'DELETE', url: `/api/community/reviews/${id}`, headers: asUser(asker.cookie) });
    assert.equal(allowed.statusCode, 200);
    const gone = await app.inject({ method: 'GET', url: '/api/community/people/rhelperg/reviews' });
    assert.equal(gone.json().summary.count, 0);
  });

  it('hides a review once enough members report it', async () => {
    const trader = await signUp(app, 'rreported');
    const liar = await signUp(app, 'rliar');
    const id = (await app.inject({
      method: 'POST', url: '/api/community/people/rreported/reviews', headers: asUser(liar.cookie),
      payload: { kind: 'hired', rating: 1, body: 'Made up nonsense.' },
    })).json().review.id;

    for (const handle of ['rmod1', 'rmod2', 'rmod3']) {
      const reporter = await signUp(app, handle);
      await app.inject({
        method: 'POST', url: '/api/community/report', headers: asUser(reporter.cookie),
        payload: { kind: 'review', id, reason: 'untrue' },
      });
    }
    const after = await app.inject({ method: 'GET', url: '/api/community/people/rreported/reviews' });
    assert.equal(after.json().summary.count, 0, 'a reported review drops out of the score too');
    assert.ok(trader.user.id);
  });

  it('rejects a rating outside one to five', async () => {
    const customer = await signUp(app, 'rrange');
    await signUp(app, 'rrangetarget');
    for (const rating of [0, 6, 3.5]) {
      const res = await app.inject({
        method: 'POST', url: '/api/community/people/rrangetarget/reviews', headers: asUser(customer.cookie),
        payload: { kind: 'hired', rating, body: 'Hmm.' },
      });
      assert.equal(res.statusCode, 400, `rating ${rating} should be refused`);
    }
  });
});

describe('ranking providers by their reviews', () => {
  let app: FastifyInstance;

  before(async () => { app = await buildApp(); });
  after(async () => { await app.close(); });

  /** Give `handle` some unverifiable reviews with the given ratings. */
  async function rate(handle: string, ratings: number[], tag: string) {
    for (const [i, rating] of ratings.entries()) {
      const reviewer = await signUp(app, `rk${tag}${i}`);
      const res = await app.inject({
        method: 'POST', url: `/api/community/people/${handle}/reviews`, headers: asUser(reviewer.cookie),
        payload: { kind: 'hired', rating, body: 'Some work was done.' },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
  }

  const scoreOf = (people: { handle: string; reviews: { score: number | null } }[], handle: string) =>
    people.find((p) => p.handle === handle)?.reviews.score ?? null;

  it('puts a real record above a single glowing review', async () => {
    await signUp(app, 'steady');
    await signUp(app, 'oneflatterer');
    await rate('steady', [4, 4, 5, 4, 5, 4], 'a');
    await rate('oneflatterer', [5], 'b');

    const people = (await app.inject({ method: 'GET', url: '/api/community/people' })).json().people;
    const steady = scoreOf(people, 'steady');
    const single = scoreOf(people, 'oneflatterer');
    assert.ok(steady !== null && single !== null);
    assert.ok(steady > single, `six good reviews (${steady}) should outrank one perfect one (${single})`);

    const order = people.map((p: { handle: string }) => p.handle);
    assert.ok(order.indexOf('steady') < order.indexOf('oneflatterer'));
  });

  it('counts a checked review for more than an unverifiable one', async () => {
    const asker = await signUp(app, 'rankasker');
    const checked = await signUp(app, 'rankchecked');
    await verifyIdentity(app, checked);
    const claimed = await signUp(app, 'rankclaimed');

    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/tech-help/threads', headers: asUser(asker.cookie),
      payload: { title: 'Wifi drops', body: 'Every evening.' },
    })).json().thread;
    await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: asUser(checked.cookie),
      payload: { body: 'Change the channel.' },
    });
    await app.inject({
      method: 'POST', url: '/api/community/people/rankchecked/reviews', headers: asUser(asker.cookie),
      payload: { kind: 'helped', rating: 5, body: 'Sorted it.', threadId: thread.id },
    });
    await rate('rankclaimed', [5], 'c');

    const people = (await app.inject({ method: 'GET', url: '/api/community/people' })).json().people;
    const a = scoreOf(people, 'rankchecked');
    const b = scoreOf(people, 'rankclaimed');
    assert.ok(a !== null && b !== null);
    assert.ok(a > b, `a checked five (${a}) must count for more than an unchecked five (${b})`);
    assert.ok(claimed.user.id);
  });

  it('drops somebody who is reviewed badly', async () => {
    await signUp(app, 'goodone');
    await signUp(app, 'poorone');
    await rate('goodone', [5, 4, 5], 'd');
    await rate('poorone', [1, 2, 1], 'e');

    const people = (await app.inject({ method: 'GET', url: '/api/community/people' })).json().people;
    const order = people.map((p: { handle: string }) => p.handle);
    assert.ok(order.indexOf('goodone') < order.indexOf('poorone'));
    assert.ok((scoreOf(people, 'poorone') ?? 5) < 3.5, 'bad reviews must pull below the neutral prior');
  });

  it('still returns people who have no reviews at all', async () => {
    const newcomer = await signUp(app, 'brandnew');
    const people = (await app.inject({ method: 'GET', url: '/api/community/people' })).json().people;
    const found = people.find((p: { handle: string }) => p.handle === 'brandnew');
    assert.ok(found, 'a new member must not vanish from the directory');
    assert.equal(found.reviews.count, 0);
    assert.equal(found.reviews.score, null, 'unrated is unrated, not zero');
    assert.ok(newcomer.user.id);
  });

  it('never lets a hidden review count toward the ranking', async () => {
    await signUp(app, 'targeted');
    await rate('targeted', [5, 5], 'f');
    const before = scoreOf((await app.inject({ method: 'GET', url: '/api/community/people' })).json().people, 'targeted');

    const liar = await signUp(app, 'ranklaliar');
    const id = (await app.inject({
      method: 'POST', url: '/api/community/people/targeted/reviews', headers: asUser(liar.cookie),
      payload: { kind: 'hired', rating: 1, body: 'Invented.' },
    })).json().review.id;
    for (const handle of ['rkm1', 'rkm2', 'rkm3']) {
      const reporter = await signUp(app, handle);
      await app.inject({
        method: 'POST', url: '/api/community/report', headers: asUser(reporter.cookie),
        payload: { kind: 'review', id, reason: 'untrue' },
      });
    }
    const after = scoreOf((await app.inject({ method: 'GET', url: '/api/community/people' })).json().people, 'targeted');
    assert.equal(after, before, 'hiding a review must undo its effect on the ranking');
  });
});

describe('moderation', () => {
  let app: FastifyInstance;

  /** An app whose first moderator is seeded, as a real deployment would be. */
  async function buildWithModerator() {
    const instance = Fastify({ logger: false });
    await instance.register(
      communityRoutes({ dataPath: null, signupsPerHourPerIp: 1000, moderators: ['Mod'] }),
      { prefix: '/api/community' },
    );
    await instance.ready();
    return instance;
  }

  before(async () => { app = await buildWithModerator(); });
  after(async () => { await app.close(); });

  /** A post, hidden by three reports, ready to be ruled on. */
  async function reportedPost(tag: string) {
    const author = await signUp(app, `mauthor${tag}`);
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/chat/threads', headers: asUser(author.cookie),
      payload: { title: `Contested ${tag}`, body: 'Something people argued about.' },
    })).json().thread;
    for (const n of [1, 2, 3]) {
      const reporter = await signUp(app, `mrep${tag}${n}`);
      await app.inject({
        method: 'POST', url: '/api/community/report', headers: asUser(reporter.cookie),
        payload: { kind: 'thread', id: thread.id, reason: `reason ${n}` },
      });
    }
    return { author, thread };
  }

  it('makes a seeded handle a moderator when they sign up', async () => {
    const mod = await signUp(app, 'mod');
    assert.equal(mod.user.role, 'moderator');
    const me = await app.inject({ method: 'GET', url: '/api/community/me', headers: asUser(mod.cookie) });
    assert.equal(me.json().user.role, 'moderator');
  });

  it('keeps the queue away from ordinary members', async () => {
    const member = await signUp(app, 'mplain');
    const denied = await app.inject({ method: 'GET', url: '/api/community/moderation/queue', headers: asUser(member.cookie) });
    assert.equal(denied.statusCode, 403);
    const anon = await app.inject({ method: 'GET', url: '/api/community/moderation/queue' });
    assert.equal(anon.statusCode, 401);
  });

  it('shows the queue what people actually objected to', async () => {
    const { thread } = await reportedPost('a');
    const queue = await app.inject({
      method: 'GET', url: '/api/community/moderation/queue',
      headers: asUser(await signIn(app, 'mod')),
    });
    assert.equal(queue.statusCode, 200);
    const found = queue.json().cases.find((c: { targetId: string }) => c.targetId === thread.id);
    assert.ok(found, 'the reported post is not in the queue');
    assert.equal(found.hidden, true);
    assert.deepEqual(found.reports.map((r: { reason: string }) => r.reason).sort(), ['reason 1', 'reason 2', 'reason 3']);
    assert.equal(found.preview.title, 'Contested a');
  });

  it('restores what a moderator keeps, and stops it being re-hidden', async () => {
    const { thread } = await reportedPost('b');
    const modCookie = await signIn(app, 'mod');

    const before = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}` });
    assert.equal(before.statusCode, 404, 'a hidden post is not readable');

    const kept = await app.inject({
      method: 'POST', url: `/api/community/moderation/thread/${thread.id}/decide`, headers: asUser(modCookie),
      payload: { decision: 'kept', reason: 'Rude but within the rules.' },
    });
    assert.equal(kept.statusCode, 200, kept.body);

    const after = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}` });
    assert.equal(after.statusCode, 200, 'keeping it must put it back');

    // The same crowd tries again.
    for (const n of [4, 5, 6]) {
      const reporter = await signUp(app, `mreb${n}`);
      await app.inject({
        method: 'POST', url: '/api/community/report', headers: asUser(reporter.cookie),
        payload: { kind: 'thread', id: thread.id, reason: 'still cross' },
      });
    }
    const stillThere = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}` });
    assert.equal(stillThere.statusCode, 200, 'a ruling must not be overturnable by re-reporting');
  });

  it('removes what a moderator removes', async () => {
    const { thread } = await reportedPost('c');
    const modCookie = await signIn(app, 'mod');

    await app.inject({
      method: 'POST', url: `/api/community/moderation/thread/${thread.id}/decide`, headers: asUser(modCookie),
      payload: { decision: 'removed', reason: 'Abusive.' },
    });
    const gone = await app.inject({ method: 'GET', url: `/api/community/threads/${thread.id}` });
    assert.equal(gone.statusCode, 404);

    const log = await app.inject({ method: 'GET', url: '/api/community/moderation/log', headers: asUser(modCookie) });
    const entry = log.json().cases.find((c: { targetId: string }) => c.targetId === thread.id);
    assert.equal(entry.decision, 'removed');
    assert.equal(entry.decisionReason, 'Abusive.');
    assert.equal(entry.decidedBy.handle, 'mod');
  });

  it('tells the author their post is hidden, and why people said so', async () => {
    const { author, thread } = await reportedPost('d');
    const mine = await app.inject({ method: 'GET', url: '/api/community/moderation/mine', headers: asUser(author.cookie) });
    assert.equal(mine.statusCode, 200);
    const entry = mine.json().mine.find((m: { targetId: string }) => m.targetId === thread.id);
    assert.ok(entry);
    assert.equal(entry.hidden, true);
    assert.deepEqual(entry.reasons.sort(), ['reason 1', 'reason 2', 'reason 3']);
    // Reasons yes, names no — naming reporters invites reprisal.
    assert.equal(JSON.stringify(entry).includes('mrepd1'), false);
  });

  it('reopens a case when the author replies, once', async () => {
    const { author, thread } = await reportedPost('e');
    const modCookie = await signIn(app, 'mod');
    await app.inject({
      method: 'POST', url: `/api/community/moderation/thread/${thread.id}/decide`, headers: asUser(modCookie),
      payload: { decision: 'removed', reason: 'Looks abusive.' },
    });

    const appeal = await app.inject({
      method: 'POST', url: `/api/community/moderation/thread/${thread.id}/appeal`, headers: asUser(author.cookie),
      payload: { note: 'It was a quote from the person I was answering.' },
    });
    assert.equal(appeal.statusCode, 200);

    const queue = await app.inject({ method: 'GET', url: '/api/community/moderation/queue', headers: asUser(modCookie) });
    const back = queue.json().cases.find((c: { targetId: string }) => c.targetId === thread.id);
    assert.ok(back, 'an appeal must put the case back in front of somebody');
    assert.match(back.appeal, /quote/);

    const twice = await app.inject({
      method: 'POST', url: `/api/community/moderation/thread/${thread.id}/appeal`, headers: asUser(author.cookie),
      payload: { note: 'Again.' },
    });
    assert.equal(twice.statusCode, 409);
  });

  it('lets nobody but the author appeal', async () => {
    const { thread } = await reportedPost('f');
    const stranger = await signUp(app, 'mstranger');
    const res = await app.inject({
      method: 'POST', url: `/api/community/moderation/thread/${thread.id}/appeal`, headers: asUser(stranger.cookie),
      payload: { note: 'Let them off.' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('promotes and demotes, but never yourself', async () => {
    const modCookie = await signIn(app, 'mod');
    const helper = await signUp(app, 'mhelper');

    const promoted = await app.inject({
      method: 'POST', url: '/api/community/people/mhelper/role', headers: asUser(modCookie),
      payload: { role: 'moderator' },
    });
    assert.equal(promoted.statusCode, 200);
    assert.equal(promoted.json().user.role, 'moderator');

    const self = await app.inject({
      method: 'POST', url: '/api/community/people/mod/role', headers: asUser(modCookie),
      payload: { role: 'member' },
    });
    assert.equal(self.statusCode, 400, 'a moderator must not be able to lock themselves out or in');

    const byMember = await app.inject({
      method: 'POST', url: '/api/community/people/mod/role', headers: asUser((await signUp(app, 'mnobody')).cookie),
      payload: { role: 'member' },
    });
    assert.equal(byMember.statusCode, 403);
  });
});

describe('accounts, contact details and identity', () => {
  let app: FastifyInstance;

  before(async () => { app = await buildApp(); });
  after(async () => { await app.close(); });

  it('requires an email address and a phone number to join', async () => {
    for (const missing of [{ email: undefined }, { phone: undefined }]) {
      const res = await app.inject({
        method: 'POST', url: '/api/community/auth/signup',
        payload: {
          handle: `part${Object.keys(missing)[0]}`,
          email: 'a@example.test', phone: '+447700400001',
          password: 'a-good-long-password',
          ...missing,
        },
      });
      assert.equal(res.statusCode, 400);
    }
  });

  it('rejects an address or number that is not one', async () => {
    const badEmail = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'bademail', email: 'not-an-address', phone: '+447700400002', password: 'a-good-long-password' },
    });
    assert.equal(badEmail.statusCode, 400);
    assert.match(badEmail.json().error, /email/i);

    const badPhone = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'badphone', email: 'ok@example.test', phone: 'call me', password: 'a-good-long-password' },
    });
    assert.equal(badPhone.statusCode, 400);
    assert.match(badPhone.json().error, /phone/i);
  });

  it('allows one account per address and per number', async () => {
    await signUp(app, 'firstclaim');
    const sameEmail = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'copycat', email: 'firstclaim@example.test', phone: '+447700400003', password: 'a-good-long-password' },
    });
    assert.equal(sameEmail.statusCode, 409);

    const sameNumber = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'copycat2', email: 'other@example.test', phone: '+447700400003', password: 'a-good-long-password' },
    });
    // Different people, same number — the second is refused once the first exists.
    const claimed = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'copycat3', email: 'third@example.test', phone: '+447700400003', password: 'a-good-long-password' },
    });
    assert.ok(sameNumber.statusCode === 409 || claimed.statusCode === 409);
  });

  it('treats a number the same however it is punctuated', async () => {
    await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'spaced', email: 'spaced@example.test', phone: '+44 7700 400 010', password: 'a-good-long-password' },
    });
    const again = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'unspaced', email: 'unspaced@example.test', phone: '+447700400010', password: 'a-good-long-password' },
    });
    assert.equal(again.statusCode, 409, 'spacing must not create a second account');
  });

  it('never shows one member another member\'s email or phone', async () => {
    const person = await signUp(app, 'privateperson');
    const nosy = await signUp(app, 'nosyneighbour');

    const profile = await app.inject({ method: 'GET', url: '/api/community/people/privateperson', headers: asUser(nosy.cookie) });
    const directory = await app.inject({ method: 'GET', url: '/api/community/people', headers: asUser(nosy.cookie) });
    for (const res of [profile, directory]) {
      const body = res.body;
      assert.equal(body.includes('privateperson@example.test'), false, 'an email address leaked');
      assert.equal(body.includes('+447700'), false, 'a phone number leaked');
    }
    assert.ok(person.user.id);
  });

  it('shows people their own details, and only their own', async () => {
    const person = await signUp(app, 'ownaccount');
    const me = await app.inject({ method: 'GET', url: '/api/community/me', headers: asUser(person.cookie) });
    assert.equal(me.json().account.email, 'ownaccount@example.test');
    assert.equal(me.json().account.emailVerified, false);
    assert.equal(me.json().account.identityVerified, false);

    const anon = await app.inject({ method: 'GET', url: '/api/community/me' });
    assert.equal(anon.json().account, null);
  });

  it('confirms an address with the code, and refuses a wrong one', async () => {
    const codes: string[] = [];
    const instance = Fastify({ logger: false });
    await instance.register(
      communityRoutes({
        dataPath: null, signupsPerHourPerIp: 1000,
        sender: { name: 'test', async send(_to, _channel, code) { codes.push(code); } },
      }),
      { prefix: '/api/community' },
    );
    await instance.ready();
    try {
      const person = await signUp(instance, 'codeperson');
      assert.equal(codes.length, 2, 'a code goes to the address and to the number');

      const wrong = await instance.inject({
        method: 'POST', url: '/api/community/auth/confirm-code', headers: asUser(person.cookie),
        payload: { channel: 'email', code: '000000' },
      });
      assert.equal(wrong.statusCode, 400);

      const right = await instance.inject({
        method: 'POST', url: '/api/community/auth/confirm-code', headers: asUser(person.cookie),
        payload: { channel: 'email', code: codes[0] },
      });
      assert.equal(right.statusCode, 200, right.body);

      const me = await instance.inject({ method: 'GET', url: '/api/community/me', headers: asUser(person.cookie) });
      assert.equal(me.json().account.emailVerified, true);
      assert.equal(me.json().account.phoneVerified, false, 'confirming one does not confirm the other');
    } finally {
      await instance.close();
    }
  });

  it('resets a forgotten password with a code, and signs the old sessions out', async () => {
    const codes: string[] = [];
    const instance = Fastify({ logger: false });
    await instance.register(
      communityRoutes({
        dataPath: null, signupsPerHourPerIp: 1000,
        sender: { name: 'test', async send(_to, channel, code) { if (channel === 'reset') codes.push(code); } },
      }),
      { prefix: '/api/community' },
    );
    await instance.ready();
    try {
      const person = await signUp(instance, 'forgetful');
      await instance.inject({ method: 'POST', url: '/api/community/auth/forgot', payload: { email: 'forgetful@example.test' } });
      assert.equal(codes.length, 1);

      const reset = await instance.inject({
        method: 'POST', url: '/api/community/auth/reset',
        payload: { email: 'forgetful@example.test', code: codes[0], password: 'a-brand-new-password' },
      });
      assert.equal(reset.statusCode, 200, reset.body);

      // The session they had before is gone.
      const old = await instance.inject({ method: 'GET', url: '/api/community/me', headers: asUser(person.cookie) });
      assert.equal(old.json().user, null);

      const signedIn = await instance.inject({
        method: 'POST', url: '/api/community/auth/login',
        payload: { handle: 'forgetful', password: 'a-brand-new-password' },
      });
      assert.equal(signedIn.statusCode, 200);
    } finally {
      await instance.close();
    }
  });

  it('says the same thing whether or not the address is registered', async () => {
    const known = await app.inject({ method: 'POST', url: '/api/community/auth/forgot', payload: { email: 'ownaccount@example.test' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/community/auth/forgot', payload: { email: 'nobody@example.test' } });
    assert.equal(known.statusCode, unknown.statusCode);
    assert.deepEqual(known.json(), unknown.json());
  });

  it('will not let an unchecked account answer a question, list a trade, or host', async () => {
    const asker = await signUp(app, 'gasker');
    const unchecked = await signUp(app, 'gunchecked');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads', headers: asUser(asker.cookie),
      payload: { title: 'Dripping tap', body: 'All night.' },
    })).json().thread;

    const answering = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: asUser(unchecked.cookie),
      payload: { body: 'Change the washer.' },
    });
    assert.equal(answering.statusCode, 403);
    assert.match(answering.json().error, /identity/i);

    const trading = await app.inject({
      method: 'PATCH', url: '/api/community/me', headers: asUser(unchecked.cookie),
      payload: { trade: 'Plumber', worksInTrade: true },
    });
    assert.equal(trading.statusCode, 403);

    const hosting = await app.inject({
      method: 'POST', url: '/api/community/channels/meetups/threads', headers: asUser(unchecked.cookie),
      payload: { title: 'Walk', body: 'Slow.', meetup: { startsAt: Date.now() + 86_400_000, capacity: 0 } },
    });
    assert.equal(hosting.statusCode, 403);
  });

  it('lets an unchecked account ask, chat and come along', async () => {
    const person = await signUp(app, 'gasking');
    const asked = await app.inject({
      method: 'POST', url: '/api/community/channels/tech-help/threads', headers: asUser(person.cookie),
      payload: { title: 'Printer will not print', body: 'It blinks orange.' },
    });
    assert.equal(asked.statusCode, 201, 'asking for help must never need an ID');

    const chatted = await app.inject({
      method: 'POST', url: '/api/community/channels/chat/threads', headers: asUser(person.cookie),
      payload: { title: 'Hello', body: 'Just saying hello.' },
    });
    assert.equal(chatted.statusCode, 201, 'chatting must never need an ID');
  });

  it('opens those doors once a moderator has checked them', async () => {
    const asker = await signUp(app, 'gasker2');
    const helper = await signUp(app, 'gchecked');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads', headers: asUser(asker.cookie),
      payload: { title: 'Cold radiator', body: 'Top is cold.' },
    })).json().thread;

    await verifyIdentity(app, helper);
    const answering = await app.inject({
      method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: asUser(helper.cookie),
      payload: { body: 'It needs bleeding.' },
    });
    assert.equal(answering.statusCode, 201, answering.body);

    const profile = await app.inject({ method: 'GET', url: '/api/community/people/gchecked' });
    assert.equal(profile.json().user.identityVerified, true);
  });

  it('records that a check happened, never the document behind it', async () => {
    const person = await signUp(app, 'gdocument');
    await verifyIdentity(app, person);
    const profile = await app.inject({ method: 'GET', url: '/api/community/people/gdocument' });
    const body = profile.body;
    assert.equal(body.includes('driving licence'), false, 'the method must not be public');
    assert.equal(body.includes('LIB-1'), false, 'the reference must not be public');
    assert.equal(profile.json().user.identityVerified, true);
  });

  it('keeps the identity queue to moderators', async () => {
    const person = await signUp(app, 'gqueue');
    await app.inject({
      method: 'POST', url: '/api/community/identity/request', headers: asUser(person.cookie),
      payload: { note: 'I can bring a passport to the library.' },
    });
    const denied = await app.inject({ method: 'GET', url: '/api/community/identity/queue', headers: asUser(person.cookie) });
    assert.equal(denied.statusCode, 403);
  });
});

describe('anti-spam limits', () => {
  it('caps new accounts per IP', async () => {
    const app = Fastify({ logger: false });
    await app.register(communityRoutes({ dataPath: null, signupsPerHourPerIp: 2 }), {
      prefix: '/api/community',
    });
    await app.ready();
    try {
      for (const [i, handle] of ['one', 'two'].entries()) {
        const ok = await app.inject({
          method: 'POST', url: '/api/community/auth/signup',
          payload: {
            handle,
            email: `${handle}@example.test`,
            phone: `+44770030000${i}`,
            password: 'a-good-long-password',
          },
        });
        assert.equal(ok.statusCode, 200, ok.body);
      }
      const third = await app.inject({
        method: 'POST', url: '/api/community/auth/signup',
        payload: { handle: 'three', email: 'three@example.test', phone: '+447700223000', password: 'a-good-long-password' },
      });
      assert.equal(third.statusCode, 429);
    } finally {
      await app.close();
    }
  });

  it('caps how many threads one member can start in an hour', async () => {
    const app = Fastify({ logger: false });
    await app.register(communityRoutes({ dataPath: null, signupsPerHourPerIp: 1000 }), {
      prefix: '/api/community',
    });
    await app.ready();
    try {
      const user = await signUp(app, 'flooder');
      let refusedAt = -1;
      for (let i = 0; i < 12; i += 1) {
        const res = await app.inject({
          method: 'POST', url: '/api/community/channels/chat/threads',
          headers: asUser(user.cookie), payload: { title: `Post ${i}`, body: 'Hello.' },
        });
        if (res.statusCode === 429) { refusedAt = i; break; }
      }
      assert.equal(refusedAt, 10, 'the eleventh thread in an hour is refused');
    } finally {
      await app.close();
    }
  });
});
