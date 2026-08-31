import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  hashPassword,
  parseCookies,
  serializeSessionCookie,
  validateHandle,
  validatePassword,
  verifyPassword,
} from '../src/community/auth.ts';
import { RateLimiter } from '../src/community/ratelimit.ts';
import { CommunityStore, publicUser } from '../src/community/store.ts';
import { matchedTopics } from '../src/community/views.ts';
import type { Channel, User } from '../src/community/types.ts';

async function seedUser(store: CommunityStore, handle: string) {
  return store.createUser({
    handle,
    displayName: handle,
    credential: await hashPassword('correct horse battery'),
  });
}

describe('auth primitives', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const credential = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', credential), true);
    assert.equal(await verifyPassword('correct horse batterz', credential), false);
  });

  it('salts, so two users with the same password do not share a hash', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.salt, b.salt);
  });

  it('returns false rather than throwing on a corrupt credential', async () => {
    assert.equal(await verifyPassword('anything', { salt: '!!', hash: 'not-base64-64' }), false);
  });

  it('enforces handle and password shape', () => {
    assert.equal(validateHandle('mara_k'), null);
    assert.ok(validateHandle('a'));
    assert.ok(validateHandle('has spaces'));
    assert.ok(validateHandle('-leading'));
    assert.equal(validatePassword('ten-chars!'), null);
    assert.ok(validatePassword('short'));
  });

  it('parses cookie headers without a plugin', () => {
    const jar = parseCookies('a=1; commons_session=abc%3Ddef; b=2');
    assert.equal(jar.commons_session, 'abc=def');
    assert.equal(jar.a, '1');
    assert.deepEqual(parseCookies(undefined), {});
  });

  it('marks the session cookie HttpOnly and SameSite', () => {
    const cookie = serializeSessionCookie('tok', 60);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=60/);
  });
});

describe('CommunityStore', () => {
  it('indexes users by handle case-insensitively', async () => {
    const store = new CommunityStore(null);
    const user = await seedUser(store, 'Mara');
    assert.equal(store.userByHandle('MARA')?.id, user.id);
    assert.equal(user.handle, 'mara', 'handles are normalised on write');
  });

  it('expires sessions rather than trusting the token forever', async () => {
    const store = new CommunityStore(null);
    const user = await seedUser(store, 'ida');
    store.createSession(user.id, 'live', 60_000);
    store.createSession(user.id, 'stale', -1);
    assert.equal(store.userForSession('live')?.id, user.id);
    assert.equal(store.userForSession('stale'), undefined);
    assert.equal(store.sessions.has('stale'), false, 'expired sessions are swept');
  });

  it('hides deleted and reported content from listings', async () => {
    const store = new CommunityStore(null);
    const user = await seedUser(store, 'ida');
    const channel = store.addChannel({
      slug: 'x', name: 'X', kind: 'help', description: 'd', topics: [], createdBy: null,
    });
    const base = {
      channelId: channel.id, authorId: user.id, title: 't', body: 'b', tags: [],
      createdAt: 1, updatedAt: 1, replyCount: 0, acceptedReplyId: null,
      meetup: null, estimate: null, reportedBy: [], hidden: false, deletedAt: null,
    };
    store.addThread({ ...base, id: 'a' });
    store.addThread({ ...base, id: 'b', hidden: true });
    store.addThread({ ...base, id: 'c', deletedAt: 2 });
    assert.deepEqual(store.threadsIn(channel.id).map((t) => t.id), ['a']);
  });

  it('sorts threads by most recent activity, not creation', async () => {
    const store = new CommunityStore(null);
    const user = await seedUser(store, 'ida');
    const channel = store.addChannel({
      slug: 'x', name: 'X', kind: 'help', description: 'd', topics: [], createdBy: null,
    });
    const base = {
      channelId: channel.id, authorId: user.id, title: 't', body: 'b', tags: [],
      replyCount: 0, acceptedReplyId: null, meetup: null, estimate: null,
      reportedBy: [], hidden: false, deletedAt: null,
    };
    store.addThread({ ...base, id: 'old-but-active', createdAt: 1, updatedAt: 900 });
    store.addThread({ ...base, id: 'new-and-quiet', createdAt: 500, updatedAt: 500 });
    assert.deepEqual(store.threadsIn(channel.id).map((t) => t.id), ['old-but-active', 'new-and-quiet']);
  });

  it('survives a restart through the JSON file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commons-'));
    const path = join(dir, 'community.json');
    try {
      const first = new CommunityStore(path);
      const user = await seedUser(first, 'ida');
      first.addChannel({ slug: 'x', name: 'X', kind: 'social', description: 'd', topics: ['a'], createdBy: user.id });
      first.createSession(user.id, 'tok', 60_000);
      first.close();

      const second = new CommunityStore(path);
      assert.equal(second.userByHandle('ida')?.id, user.id);
      assert.equal(second.channelBySlug('x')?.name, 'X');
      assert.equal(second.userForSession('tok')?.id, user.id, 'sessions outlive a restart');
      assert.ok(second.credentialFor(user.id), 'credentials are persisted too');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never leaks a credential through publicUser', async () => {
    const store = new CommunityStore(null);
    const user = await seedUser(store, 'ida');
    const shown = publicUser(user) as unknown as Record<string, unknown>;
    assert.equal('password' in shown, false);
    assert.equal('hash' in shown, false);
    assert.equal(shown.handle, 'ida');
  });

  it('reports the last wave between two people, for the cooldown', async () => {
    const store = new CommunityStore(null);
    const a = await seedUser(store, 'a');
    const b = await seedUser(store, 'b');
    assert.equal(store.lastWaveAt(a.id, b.id), null);
    store.addWave({ id: '1', fromUserId: a.id, toUserId: b.id, note: '', createdAt: 100, readAt: null });
    store.addWave({ id: '2', fromUserId: a.id, toUserId: b.id, note: '', createdAt: 300, readAt: null });
    store.addWave({ id: '3', fromUserId: b.id, toUserId: a.id, note: '', createdAt: 900, readAt: null });
    assert.equal(store.lastWaveAt(a.id, b.id), 300);
  });
});

describe('topic matching', () => {
  const channel = { topics: ['Plumbing', 'electrical'] } as Channel;

  it('matches a claimed skill regardless of case', () => {
    const user = { skills: ['PLUMBING', 'baking'] } as User;
    assert.deepEqual(matchedTopics(channel, user), ['Plumbing']);
  });

  it('claims nothing when the user claims nothing', () => {
    assert.deepEqual(matchedTopics(channel, { skills: [] } as unknown as User), []);
    assert.deepEqual(matchedTopics(undefined, { skills: ['plumbing'] } as User), []);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit, then refuses until the window rolls', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    assert.equal(limiter.allow('k', 2, 1000), true);
    assert.equal(limiter.allow('k', 2, 1000), true);
    assert.equal(limiter.allow('k', 2, 1000), false);
    now = 1001;
    assert.equal(limiter.allow('k', 2, 1000), true);
  });

  it('keys are independent', () => {
    const limiter = new RateLimiter(() => 0);
    assert.equal(limiter.allow('a', 1, 1000), true);
    assert.equal(limiter.allow('b', 1, 1000), true);
    assert.equal(limiter.allow('a', 1, 1000), false);
  });
});

describe('EventBus', () => {
  it('delivers to every subscriber and stops after unsubscribe', async () => {
    const { EventBus } = await import('../src/community/events.ts');
    const bus = new EventBus();
    const seen: string[] = [];
    const offA = bus.subscribe((e) => seen.push(`a:${e.type}`));
    bus.subscribe((e) => seen.push(`b:${e.type}`));
    bus.publish({ type: 'presence.changed', userId: 'u', openToChat: true });
    offA();
    bus.publish({ type: 'presence.changed', userId: 'u', openToChat: false });
    assert.deepEqual(seen, ['a:presence.changed', 'b:presence.changed', 'b:presence.changed']);
    assert.equal(bus.size, 1);
  });

  it('drops a subscriber that throws instead of losing the rest', async () => {
    const { EventBus } = await import('../src/community/events.ts');
    const bus = new EventBus();
    let delivered = 0;
    bus.subscribe(() => { throw new Error('a dead SSE connection'); });
    bus.subscribe(() => { delivered += 1; });
    bus.publish({ type: 'wave.sent', toUserId: 'u' });
    bus.publish({ type: 'wave.sent', toUserId: 'u' });
    assert.equal(delivered, 2);
    assert.equal(bus.size, 1, 'the throwing subscriber is evicted');
  });
});
