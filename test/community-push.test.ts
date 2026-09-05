import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { PUSH_COPY, WebPushSender, pushFromEnv, type PushPayload, type PushResult, type PushSender } from '../src/community/push.ts';
import { communityRoutes } from '../src/community/routes.ts';
import { CommunityStore } from '../src/community/store.ts';
import type { PushSubscriptionRecord } from '../src/community/types.ts';

/**
 * Push notifications: the four moments, and only those.
 *
 * A stub sender records what would have gone out. The hooks are
 * fire-and-forget from the request's point of view, so each test lets the
 * event loop turn once before looking.
 */
class StubPush implements PushSender {
  readonly name = 'stub';
  readonly publicKey = 'BTESTPUBLICKEY';
  sent: Array<{ userId: string; endpoint: string; payload: PushPayload }> = [];
  /** endpoint -> what to answer; default 'sent'. */
  answers = new Map<string, PushResult>();
  store: CommunityStore | null = null;

  async send(sub: PushSubscriptionRecord, payload: PushPayload): Promise<PushResult> {
    this.sent.push({ userId: sub.userId, endpoint: sub.endpoint, payload });
    return this.answers.get(sub.endpoint) ?? 'sent';
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function buildApp(push: PushSender | undefined, store?: CommunityStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    communityRoutes({ dataPath: null, store, signupsPerHourPerIp: 1000, moderators: ['tmod'], push }),
    { prefix: '/api/community' },
  );
  await app.ready();
  return app;
}

let phone = 100;
async function signUp(app: FastifyInstance, handle: string) {
  phone += 1;
  const res = await app.inject({
    method: 'POST', url: '/api/community/auth/signup',
    payload: { handle, displayName: handle, email: `${handle}@example.test`, phone: `+447700${String(phone).padStart(6, '0')}`, password: 'a-good-long-password' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = (res.headers['set-cookie'] as string).split(';')[0] as string;
  return { cookie, id: (res.json() as { user: { id: string } }).user.id, handle };
}
const as = (u: { cookie: string }) => ({ cookie: u.cookie });
const sub = (n: number) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

async function verify(app: FastifyInstance, who: { cookie: string; handle: string }) {
  await app.inject({ method: 'POST', url: '/api/community/identity/request', headers: as(who), payload: { note: 'ok' } });
  let mod: { cookie: string };
  try { mod = await signUp(app, 'tmod'); } catch {
    const login = await app.inject({ method: 'POST', url: '/api/community/auth/login', payload: { handle: 'tmod', password: 'a-good-long-password' } });
    mod = { cookie: (login.headers['set-cookie'] as string).split(';')[0] as string };
  }
  const d = await app.inject({ method: 'POST', url: `/api/community/identity/${who.handle}/decide`, headers: as(mod), payload: { outcome: 'verified', method: 'in person', reference: 'x' } });
  assert.equal(d.statusCode, 200, d.body);
}

describe('push: off until it is set up', () => {
  let app: FastifyInstance;
  before(async () => { app = await buildApp(undefined); });
  after(async () => { await app.close(); });

  it('says so, and refuses a subscription with a plain reason', async () => {
    const cfg = await app.inject({ method: 'GET', url: '/api/community/push/config' });
    assert.deepEqual(cfg.json(), { enabled: false, publicKey: null });
    const u = await signUp(app, 'pushoff');
    const res = await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(u), payload: sub(1) });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { error: string }).error, 'Notifications are not set up on this Commons yet.');
    const me = await app.inject({ method: 'GET', url: '/api/community/me', headers: as(u) });
    assert.deepEqual((me.json() as { push: unknown }).push, { enabled: false, subscriptions: 0 });
  });
});

describe('push: subscriptions', () => {
  let app: FastifyInstance;
  const push = new StubPush();
  before(async () => { app = await buildApp(push); });
  after(async () => { await app.close(); });

  it('needs somebody signed in, and an https endpoint', async () => {
    const anon = await app.inject({ method: 'POST', url: '/api/community/push/subscribe', payload: sub(1) });
    assert.equal(anon.statusCode, 401);
    const u = await signUp(app, 'subber');
    const bad = await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(u), payload: { endpoint: 'http://push.example.test/x', keys: { p256dh: 'p', auth: 'a' } } });
    assert.equal(bad.statusCode, 400);
  });

  it('keeps one per browser, moves it between accounts, and forgets it on request', async () => {
    const a = await signUp(app, 'browsera');
    const b = await signUp(app, 'browserb');
    const cfg = await app.inject({ method: 'GET', url: '/api/community/push/config' });
    assert.deepEqual(cfg.json(), { enabled: true, publicKey: 'BTESTPUBLICKEY' });

    const first = await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(a), payload: sub(10) });
    assert.equal(first.statusCode, 201);
    assert.equal((first.json() as { subscriptions: number }).subscriptions, 1);
    // The same browser subscribing again is still one browser.
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(a), payload: sub(10) });
    let me = await app.inject({ method: 'GET', url: '/api/community/me', headers: as(a) });
    assert.equal((me.json() as { push: { subscriptions: number } }).push.subscriptions, 1);

    // Somebody else signs in on that browser: it is theirs now, not a's.
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(b), payload: sub(10) });
    me = await app.inject({ method: 'GET', url: '/api/community/me', headers: as(a) });
    assert.equal((me.json() as { push: { subscriptions: number } }).push.subscriptions, 0);

    // a cannot remove b's; b can.
    await app.inject({ method: 'DELETE', url: '/api/community/push/subscribe', headers: as(a), payload: { endpoint: sub(10).endpoint } });
    me = await app.inject({ method: 'GET', url: '/api/community/me', headers: as(b) });
    assert.equal((me.json() as { push: { subscriptions: number } }).push.subscriptions, 1);
    const gone = await app.inject({ method: 'DELETE', url: '/api/community/push/subscribe', headers: as(b), payload: { endpoint: sub(10).endpoint } });
    assert.equal((gone.json() as { subscriptions: number }).subscriptions, 0);
  });

  it('a test push goes to every browser you have, and drops the ones the service says are gone', async () => {
    const u = await signUp(app, 'tester');
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(u), payload: sub(20) });
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(u), payload: sub(21) });
    push.answers.set(sub(21).endpoint, 'gone');
    push.sent = [];
    const res = await app.inject({ method: 'POST', url: '/api/community/push/test', headers: as(u) });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { sent: 1, gone: 1, subscriptions: 1 });
    assert.equal(push.sent[0]?.payload.title, 'Commons can reach you here');
  });
});

describe('push: the four moments', () => {
  let app: FastifyInstance;
  const push = new StubPush();
  before(async () => { app = await buildApp(push); });
  after(async () => { await app.close(); });

  const sentTo = (userId: string) => push.sent.filter((s) => s.userId === userId).map((s) => s.payload);

  it('somebody answered your question — the asker, not the answerer', async () => {
    const asker = await signUp(app, 'asker');
    const pro = await signUp(app, 'pro');
    await verify(app, pro);
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(asker), payload: sub(30) });
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(pro), payload: sub(31) });
    const posted = await app.inject({ method: 'POST', url: '/api/community/channels/plumbers/threads', headers: as(asker), payload: { title: 'Dripping tap', body: 'All night.' } });
    const thread = (posted.json() as { thread: { id: string } }).thread;
    push.sent = [];

    // The asker answering their own question tells nobody.
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: as(asker), payload: { body: 'Never mind, fixed it.' } });
    await settle();
    assert.equal(push.sent.length, 0);

    const answered = await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: as(pro), payload: { body: 'Replace the washer.' } });
    assert.equal(answered.statusCode, 201, answered.body);
    await settle();
    assert.deepEqual(sentTo(asker.id), [{ title: 'pro answered your question', body: 'Dripping tap', url: `/#/p/${thread.id}`, tag: `answer-${thread.id}` }]);
    assert.equal(sentTo(pro.id).length, 0, 'the answerer is not told about their own answer');

    // …and marking that answer as the one that worked tells the answerer.
    push.sent = [];
    const reply = (answered.json() as { reply: { id: string } }).reply;
    const accepted = await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/accept`, headers: as(asker), payload: { replyId: reply.id } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    await settle();
    assert.deepEqual(sentTo(pro.id), [{ title: 'asker said your answer worked', body: 'Dripping tap', url: `/#/p/${thread.id}`, tag: `worked-${thread.id}` }]);
  });

  it('somebody said hello — the recipient', async () => {
    const a = await signUp(app, 'waver');
    const b = await signUp(app, 'waved');
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(b), payload: sub(40) });
    push.sent = [];
    const res = await app.inject({ method: 'POST', url: '/api/community/waves', headers: as(a), payload: { toUserId: b.id, note: 'hi' } });
    assert.equal(res.statusCode, 201, res.body);
    await settle();
    assert.deepEqual(sentTo(b.id), [{ title: 'waver said hello', body: 'Open Commons to say hello back.', url: '/#/hellos', tag: 'hello' }]);
  });

  it('a message about a get-together — the other half, and never the text', async () => {
    const host = await signUp(app, 'host');
    await verify(app, host);
    const guest = await signUp(app, 'guest');
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(guest), payload: sub(50) });
    const made = await app.inject({ method: 'POST', url: '/api/community/channels/meetups/threads', headers: as(host), payload: { title: 'Sunday walk', body: 'Slow pace.', meetup: { startsAt: Date.now() + 86_400_000, capacity: 0 } } });
    const thread = (made.json() as { thread: { id: string } }).thread;
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/rsvp`, headers: as(guest) });
    push.sent = [];
    const msg = await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/messages`, headers: as(host), payload: { body: 'It is 14 Mill Lane, the blue door.', guest: guest.id } });
    assert.equal(msg.statusCode, 201, msg.body);
    await settle();
    const got = sentTo(guest.id);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], { title: 'host sent you a message', body: 'About Sunday walk.', url: `/#/p/${thread.id}`, tag: `message-${thread.id}` });
    assert.equal(JSON.stringify(got).includes('Mill Lane'), false, 'an address never reaches a lock screen');
  });

  it('nothing crosses a block, in either direction', async () => {
    const a = await signUp(app, 'blocka');
    const b = await signUp(app, 'blockb');
    await verify(app, b);
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(a), payload: sub(60) });
    const posted = await app.inject({ method: 'POST', url: '/api/community/channels/plumbers/threads', headers: as(a), payload: { title: 'Cold radiator', body: 'Top half.' } });
    const thread = (posted.json() as { thread: { id: string } }).thread;
    await app.inject({ method: 'POST', url: `/api/community/people/${b.handle}/block`, headers: as(a) });
    push.sent = [];
    // b can still answer in the public room (a block closes contact, not speech)…
    const answered = await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: as(b), payload: { body: 'Bleed it.' } });
    assert.equal(answered.statusCode, 201, answered.body);
    await settle();
    // …but a is not told, because a notification is contact.
    assert.equal(sentTo(a.id).length, 0);
  });

  it('a subscription the service says is gone is deleted the first time it fails', async () => {
    const asker = await signUp(app, 'goneasker');
    const pro = await signUp(app, 'gonepro');
    await verify(app, pro);
    await app.inject({ method: 'POST', url: '/api/community/push/subscribe', headers: as(asker), payload: sub(70) });
    push.answers.set(sub(70).endpoint, 'gone');
    const posted = await app.inject({ method: 'POST', url: '/api/community/channels/plumbers/threads', headers: as(asker), payload: { title: 'Q', body: 'Body.' } });
    const thread = (posted.json() as { thread: { id: string } }).thread;
    await app.inject({ method: 'POST', url: `/api/community/threads/${thread.id}/replies`, headers: as(pro), payload: { body: 'A.' } });
    await settle();
    const me = await app.inject({ method: 'GET', url: '/api/community/me', headers: as(asker) });
    assert.equal((me.json() as { push: { subscriptions: number } }).push.subscriptions, 0);
  });
});

describe('push: the store', () => {
  it('round-trips subscriptions through the JSON file and moves an endpoint between members', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'commons-push-'));
    try {
      const path = join(dir, 'community.json');
      const first = new CommunityStore(path);
      first.addPushSubscription({ id: '1', userId: 'u1', endpoint: 'https://p/1', keys: { p256dh: 'a', auth: 'b' }, createdAt: 1 });
      first.addPushSubscription({ id: '2', userId: 'u1', endpoint: 'https://p/2', keys: { p256dh: 'c', auth: 'd' }, createdAt: 2 });
      first.addPushSubscription({ id: '3', userId: 'u2', endpoint: 'https://p/2', keys: { p256dh: 'c', auth: 'd' }, createdAt: 3 });
      first.close();
      const second = new CommunityStore(path);
      assert.deepEqual(second.pushSubscriptionsFor('u1').map((s) => s.endpoint), ['https://p/1']);
      assert.deepEqual(second.pushSubscriptionsFor('u2').map((s) => s.endpoint), ['https://p/2']);
      assert.equal(second.removePushSubscription('https://p/1'), true);
      assert.equal(second.removePushSubscription('https://p/1'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('push: the sender and the environment', () => {
  it('is off with no keys, loud with half of them, and a sender with all three', async () => {
    assert.equal(await pushFromEnv({} as NodeJS.ProcessEnv), null);
    await assert.rejects(pushFromEnv({ VAPID_PUBLIC_KEY: 'pub' } as NodeJS.ProcessEnv), /half-configured/);
    await assert.rejects(pushFromEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'bob' } as NodeJS.ProcessEnv), /mailto:/);
    const sender = await pushFromEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.test' } as NodeJS.ProcessEnv);
    assert.equal(sender?.publicKey, 'pub');
    assert.equal(sender?.name, 'web-push');
  });

  it('maps the push service\'s answers: 410 and 404 are gone, anything else failed, success sent', async () => {
    const calls: unknown[] = [];
    const make = (fail?: number) => new WebPushSender(
      { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.test' },
      async (subscription, payload, options) => {
        calls.push({ subscription, payload, options });
        if (fail) { const e = new Error('nope') as Error & { statusCode: number }; e.statusCode = fail; throw e; }
        return {};
      },
    );
    const record: PushSubscriptionRecord = { id: 'x', userId: 'u', endpoint: 'https://p/x', keys: { p256dh: 'k', auth: 'a' }, createdAt: 0 };
    assert.equal(await make().send(record, PUSH_COPY.test()), 'sent');
    assert.equal(await make(410).send(record, PUSH_COPY.test()), 'gone');
    assert.equal(await make(404).send(record, PUSH_COPY.test()), 'gone');
    assert.equal(await make(500).send(record, PUSH_COPY.test()), 'failed');
    const first = calls[0] as { payload: string; options: { TTL: number; vapidDetails: { subject: string } } };
    assert.equal(JSON.parse(first.payload).title, 'Commons can reach you here');
    assert.equal(first.options.TTL, 86_400);
    assert.equal(first.options.vapidDetails.subject, 'mailto:a@b.test');
  });

  it('every message is short, has a link, and never more than a name, a verb and a title', () => {
    for (const p of [PUSH_COPY.answered('Mara', 'Cold radiator', 't1'), PUSH_COPY.worked('Dev', 'Cold radiator', 't1'), PUSH_COPY.hello('Joan'), PUSH_COPY.message('Joan', 'Sunday walk', 't2'), PUSH_COPY.test()]) {
      assert.ok(p.title.split(' ').length <= 6, p.title);
      assert.ok(p.body.length <= 140, p.body);
      assert.ok(p.url.startsWith('/#/'), p.url);
    }
  });
});
