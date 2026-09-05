import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildServer } from '../src/server.ts';

/**
 * The production guard, exercised for real.
 *
 * An instance that boots happily and then fails on the first person to sign
 * up is worse than one that refuses to boot, so `buildServer()` throws under
 * NODE_ENV=production when nothing can send a one-time code. That rule is
 * load-bearing for anyone deploying this, so it is tested through the same
 * function `npm start` runs — with the environment set the way a host would.
 */
const KEYS = [
  'NODE_ENV', 'COMMUNITY_DATA', 'COMMUNITY_MODERATORS', 'LOG_LEVEL',
  'EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM',
  'SMS_PROVIDER', 'SMS_API_KEY', 'SMS_FROM', 'SMS_ACCOUNT_ID',
];
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  process.env.COMMUNITY_DATA = ':memory:';
  process.env.LOG_LEVEL = 'silent';
  Object.assign(process.env, values);
}

describe('buildServer() and the environment', () => {
  before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  after(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('refuses to start in production with no way to send codes', () => {
    setEnv({ NODE_ENV: 'production' });
    assert.throws(() => buildServer(), /No way to send one-time codes/);
  });

  it('starts in production once an email provider is configured, and answers health', async () => {
    setEnv({
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'postmark', EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'Commons <hello@example.test>',
      COMMUNITY_MODERATORS: 'firstmod',
    });
    const app = buildServer();
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/community/health' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { ok?: boolean; members?: number };
      assert.equal(body.ok, true);
      // A fresh instance opens with its rooms and nobody in them.
      assert.equal(body.members, 0);
      const rooms = await app.inject({ method: 'GET', url: '/api/community/channels' });
      assert.ok((rooms.json().channels as unknown[]).length >= 14, 'the seeded rooms are there');
      // The shell and the landing page are served by the same process.
      for (const path of ['/', '/welcome/', '/commons.js', '/ambient.js', '/manifest.webmanifest']) {
        const page = await app.inject({ method: 'GET', url: path });
        assert.equal(page.statusCode, 200, `${path} -> ${page.statusCode}`);
      }
    } finally {
      await app.close();
    }
  });

  it('starts in development with no provider at all, logging codes instead', async () => {
    setEnv({ NODE_ENV: 'development' });
    const app = buildServer();
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/community/health' });
      assert.equal(res.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('rejects a half-configured provider loudly rather than booting without it', () => {
    setEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend' });
    assert.throws(() => buildServer(), /EMAIL_API_KEY or EMAIL_FROM is missing/);
  });
});
