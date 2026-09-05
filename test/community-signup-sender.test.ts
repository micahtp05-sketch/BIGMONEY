import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { communityRoutes } from '../src/community/routes.ts';
import { SendFailed } from '../src/community/senders/index.ts';
import type { CodeSender } from '../src/community/verify.ts';

/**
 * What happens when the code provider is down on launch day.
 *
 * Found by booting the deployable image against a network that refused the
 * provider: the account was created, the email send threw, and the person got
 * a 500 — then "that username is taken" when they tried again. A send failure
 * must never fail a sign-up, and an explicit "send me a code" must say plainly
 * that it did not go, never a raw provider error.
 */
class FlakySender implements CodeSender {
  readonly name = 'flaky';
  failing = new Set<string>();
  sent: string[] = [];

  async send(to: string, channel: 'email' | 'phone' | 'reset', _code: string): Promise<void> {
    if (this.failing.has(channel)) throw new SendFailed('Provider refused the request (403).', 403);
    this.sent.push(`${channel}:${to}`);
  }
}

async function buildApp(sender: CodeSender): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    communityRoutes({ dataPath: null, signupsPerHourPerIp: 1000, sender }),
    { prefix: '/api/community' },
  );
  await app.ready();
  return app;
}

describe('signing up while the code provider is failing', () => {
  let app: FastifyInstance;
  const sender = new FlakySender();

  before(async () => { app = await buildApp(sender); });
  after(async () => { await app.close(); });

  const signup = (handle: string, n: number) => app.inject({
    method: 'POST', url: '/api/community/auth/signup',
    payload: {
      handle, displayName: handle, email: `${handle}@example.test`,
      phone: `+447700${String(n).padStart(6, '0')}`, password: 'a-good-long-password',
    },
  });

  it('still creates the account and signs the person in, and says which codes went', async () => {
    sender.failing = new Set(['email']);
    const res = await signup('launchday', 1);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { user: { handle: string }; codesSent: { email: boolean; phone: boolean } };
    assert.equal(body.user.handle, 'launchday');
    assert.deepEqual(body.codesSent, { email: false, phone: true });
    assert.ok(res.headers['set-cookie'], 'the session cookie is set even though a code did not go');
    // The phone code went; the email one did not; nothing leaked into the response.
    assert.ok(sender.sent.includes('phone:+447700000001'));
    assert.equal(res.body.includes('403'), false, 'no provider status in the response');
    assert.equal(res.body.includes('Provider'), false, 'no provider wording in the response');

    // Trying again is not "that username is taken": they are already in.
    const me = await app.inject({ method: 'GET', url: '/api/community/me', headers: { cookie: (res.headers['set-cookie'] as string).split(';')[0] as string } });
    assert.equal((me.json() as { user: { handle: string } }).user.handle, 'launchday');
  });

  it('reports a clean failure when they ask for the code again, in plain words', async () => {
    sender.failing = new Set(['email']);
    const made = await signup('againlater', 2);
    const cookie = (made.headers['set-cookie'] as string).split(';')[0] as string;

    const retry = await app.inject({
      method: 'POST', url: '/api/community/auth/send-code', headers: { cookie },
      payload: { channel: 'email' },
    });
    assert.equal(retry.statusCode, 502, retry.body);
    const error = (retry.json() as { error: string }).error;
    assert.equal(error, 'We could not send the code just now. Try again in a minute.');

    // And once the provider is back, the same request succeeds.
    sender.failing = new Set();
    const ok = await app.inject({
      method: 'POST', url: '/api/community/auth/send-code', headers: { cookie },
      payload: { channel: 'email' },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((ok.json() as { sentTo: string }).sentTo, 'againlater@example.test');
  });

  it('when every send fails, sign-up still succeeds and both flags are false', async () => {
    sender.failing = new Set(['email', 'phone']);
    const res = await signup('allfailed', 3);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual((res.json() as { codesSent: unknown }).codesSent, { email: false, phone: false });
  });

  it('a password reset request never reveals a send failure either', async () => {
    sender.failing = new Set(['reset']);
    await signup('forgetful', 4);
    const res = await app.inject({
      method: 'POST', url: '/api/community/auth/forgot',
      payload: { email: 'forgetful@example.test' },
    });
    // Forgot always answers the same way, so it cannot be used to find accounts;
    // a provider failure must not change that.
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body.includes('403'), false);
  });
});
