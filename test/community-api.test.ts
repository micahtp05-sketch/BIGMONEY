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
  await app.register(communityRoutes({ dataPath: null, signupsPerHourPerIp: 1000 }), {
    prefix: '/api/community',
  });
  await app.ready();
  return app;
}

/** Sign up and return the cookie header a signed-in client would send. */
async function signUp(app: FastifyInstance, handle: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/community/auth/signup',
    payload: { handle, displayName: handle, password: 'a-good-long-password' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(raw, 'signup must set a session cookie');
  return {
    cookie: raw.split(';')[0] as string,
    user: res.json().user as { id: string; handle: string; displayName: string },
  };
}

const asUser = (cookie: string) => ({ cookie });

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
      payload: { handle: 'weakling', password: 'short' },
    });
    assert.equal(weak.statusCode, 400);

    await signUp(app, 'firstcomer');
    const dupe = await app.inject({
      method: 'POST', url: '/api/community/auth/signup',
      payload: { handle: 'firstcomer', password: 'a-good-long-password' },
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

    // The helper claims plumbing, which Home & Repair lists as a topic.
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
    const guest = await signUp(app, 'guest');
    const latecomer = await signUp(app, 'latecomer');

    const created = await app.inject({
      method: 'POST', url: '/api/community/channels/walks-and-coffee/threads',
      headers: asUser(host.cookie),
      payload: {
        title: 'Saturday loop round the park',
        body: 'Slow pace, no need to talk.',
        meetup: { startsAt: Date.now() + 86_400_000, place: 'Bench by the pond', capacity: 2 },
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
    const wrongChannel = await app.inject({
      method: 'POST', url: '/api/community/channels/home-repair/threads', headers: asUser(user.cookie),
      payload: {
        title: 'Boiler party', body: 'no',
        meetup: { startsAt: Date.now() + 86_400_000, place: 'Here', capacity: 0 },
      },
    });
    assert.equal(wrongChannel.statusCode, 400);

    const inThePast = await app.inject({
      method: 'POST', url: '/api/community/channels/sunday-supper/threads', headers: asUser(user.cookie),
      payload: {
        title: 'Last week', body: 'no',
        meetup: { startsAt: Date.now() - 86_400_000, place: 'Here', capacity: 0 },
      },
    });
    assert.equal(inThePast.statusCode, 400);
  });

  it('hides content once enough distinct members report it', async () => {
    const poster = await signUp(app, 'poster');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/front-porch/threads',
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

    const channel = await app.inject({ method: 'GET', url: '/api/community/channels/front-porch' });
    assert.equal(
      channel.json().threads.some((t: { id: string }) => t.id === thread.id), false,
      'hidden threads drop out of the channel listing',
    );
  });

  it('counts a repeat report from the same member only once', async () => {
    const poster = await signUp(app, 'poster2');
    const reporter = await signUp(app, 'repeater');
    const thread = (await app.inject({
      method: 'POST', url: '/api/community/channels/front-porch/threads',
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
      method: 'POST', url: '/api/community/channels/book-club/threads',
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
      method: 'POST', url: '/api/community/channels/makers/threads', headers: asUser(user.cookie),
      payload: { title: 'Mending a wicker chair', body: 'Unrelated words here.' },
    });
    await app.inject({
      method: 'POST', url: '/api/community/channels/makers/threads', headers: asUser(user.cookie),
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
      method: 'POST', url: '/api/community/channels/front-porch/threads', headers: asUser(user.cookie),
      payload: { title: '   ', body: 'x' },
    });
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json().error, /title/);

    const tooLong = await app.inject({
      method: 'POST', url: '/api/community/channels/front-porch/threads', headers: asUser(user.cookie),
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
    const porch = res.json().channels.find((c: { slug: string }) => c.slug === 'front-porch');
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

describe('anti-spam limits', () => {
  it('caps new accounts per IP', async () => {
    const app = Fastify({ logger: false });
    await app.register(communityRoutes({ dataPath: null, signupsPerHourPerIp: 2 }), {
      prefix: '/api/community',
    });
    await app.ready();
    try {
      for (const handle of ['one', 'two']) {
        const ok = await app.inject({
          method: 'POST', url: '/api/community/auth/signup',
          payload: { handle, password: 'a-good-long-password' },
        });
        assert.equal(ok.statusCode, 200);
      }
      const third = await app.inject({
        method: 'POST', url: '/api/community/auth/signup',
        payload: { handle: 'three', password: 'a-good-long-password' },
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
          method: 'POST', url: '/api/community/channels/front-porch/threads',
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
