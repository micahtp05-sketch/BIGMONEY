import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PostmarkEmail, ResendEmail, SendGridEmail } from '../src/community/senders/email.ts';
import { SendFailed } from '../src/community/senders/http.ts';
import { ProviderSender, sendersFromEnv } from '../src/community/senders/index.ts';
import { MessageBirdSms, TwilioSms } from '../src/community/senders/sms.ts';

/**
 * These run against a stub HTTP server on localhost, not a real provider.
 *
 * That covers everything this code is actually responsible for — the URL, the
 * auth header, the body shape, what it does with a 4xx, a 5xx and a hang — and
 * nothing about whether the provider's own endpoint behaves as documented.
 * That last part is the first live run's job, and the README says so.
 */

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = '';
let seen: Seen[] = [];
/** Set per-test to control what the stub answers with. */
let reply: { status: number; body: string } | ((n: number) => { status: number; body: string }) = {
  status: 200,
  body: '{"id":"ok"}',
};
let delayMs = 0;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const answer = typeof reply === 'function' ? reply(seen.length) : reply;
      const send = () => {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset() {
  seen = [];
  reply = { status: 200, body: '{"id":"ok"}' };
  delayMs = 0;
}

/** Retries should not actually sleep during tests. */
const noSleep = async () => {};

describe('email providers', () => {
  it('Resend posts to /emails with a bearer token', async () => {
    reset();
    await new ResendEmail({ apiKey: 'key-123', from: 'Commons <hello@example.org>', baseUrl: base, sleep: noSleep })
      .send('someone@example.test', 'Your code', '123456 is your code.');

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, '/emails');
    assert.equal(seen[0]?.headers.authorization, 'Bearer key-123');
    const body = JSON.parse(seen[0]?.body ?? '{}');
    assert.deepEqual(body.to, ['someone@example.test']);
    assert.equal(body.from, 'Commons <hello@example.org>');
    assert.equal(body.subject, 'Your code');
    assert.match(body.text, /123456/);
  });

  it('Postmark uses its own token header and a transactional stream', async () => {
    reset();
    await new PostmarkEmail({ apiKey: 'tok-9', from: 'hello@example.org', baseUrl: base, sleep: noSleep })
      .send('someone@example.test', 'Your code', '123456');

    assert.equal(seen[0]?.url, '/email');
    assert.equal(seen[0]?.headers['x-postmark-server-token'], 'tok-9');
    const body = JSON.parse(seen[0]?.body ?? '{}');
    assert.equal(body.To, 'someone@example.test');
    assert.equal(body.MessageStream, 'outbound', 'a login code must not go out as marketing');
  });

  it('SendGrid nests the recipient the way its API wants', async () => {
    reset();
    await new SendGridEmail({ apiKey: 'sg-1', from: 'hello@example.org', baseUrl: base, sleep: noSleep })
      .send('someone@example.test', 'Your code', '123456');

    assert.equal(seen[0]?.url, '/v3/mail/send');
    const body = JSON.parse(seen[0]?.body ?? '{}');
    assert.equal(body.personalizations[0].to[0].email, 'someone@example.test');
    assert.equal(body.content[0].type, 'text/plain');
  });
});

describe('sms providers', () => {
  it('Twilio form-encodes to the account message endpoint with basic auth', async () => {
    reset();
    await new TwilioSms({ accountId: 'AC123', apiKey: 'secret', from: '+15550001111', baseUrl: base, sleep: noSleep })
      .send('+447700900123', '123456 is your code.');

    assert.equal(seen[0]?.url, '/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(seen[0]?.headers['content-type'], 'application/x-www-form-urlencoded');
    const expected = `Basic ${Buffer.from('AC123:secret').toString('base64')}`;
    assert.equal(seen[0]?.headers.authorization, expected);
    const form = new URLSearchParams(seen[0]?.body ?? '');
    assert.equal(form.get('To'), '+447700900123');
    assert.equal(form.get('From'), '+15550001111');
    assert.match(form.get('Body') ?? '', /123456/);
  });

  it('Twilio refuses to send without an account SID', async () => {
    reset();
    const sender = new TwilioSms({ apiKey: 'secret', from: '+1', baseUrl: base, sleep: noSleep });
    await assert.rejects(() => sender.send('+447700900123', 'hello'), /account SID/);
    assert.equal(seen.length, 0, 'nothing should have been sent');
  });

  it('MessageBird posts JSON with an AccessKey', async () => {
    reset();
    await new MessageBirdSms({ apiKey: 'mb-key', from: 'Commons', baseUrl: base, sleep: noSleep })
      .send('+447700900123', '123456 is your code.');

    assert.equal(seen[0]?.url, '/messages');
    assert.equal(seen[0]?.headers.authorization, 'AccessKey mb-key');
    const body = JSON.parse(seen[0]?.body ?? '{}');
    assert.deepEqual(body.recipients, ['+447700900123']);
    assert.equal(body.originator, 'Commons');
  });
});

describe('when the provider misbehaves', () => {
  it('retries a 500 and succeeds on a later attempt', async () => {
    reset();
    reply = (n) => (n < 3 ? { status: 500, body: 'boom' } : { status: 200, body: '{}' });
    await new ResendEmail({ apiKey: 'k', from: 'a@b.test', baseUrl: base, sleep: noSleep })
      .send('someone@example.test', 'Your code', '123456');
    assert.equal(seen.length, 3, 'it should have taken three goes');
  });

  it('gives up after the last attempt and says so', async () => {
    reset();
    reply = { status: 503, body: 'down' };
    const sender = new ResendEmail({ apiKey: 'k', from: 'a@b.test', baseUrl: base, sleep: noSleep });
    await assert.rejects(() => sender.send('someone@example.test', 'Your code', '123456'), SendFailed);
    assert.equal(seen.length, 3);
  });

  it('does not retry a rejection, because it would only be rejected again', async () => {
    reset();
    reply = { status: 422, body: '{"message":"bad address"}' };
    const sender = new ResendEmail({ apiKey: 'k', from: 'a@b.test', baseUrl: base, sleep: noSleep });
    await assert.rejects(() => sender.send('nope', 'Your code', '123456'), SendFailed);
    assert.equal(seen.length, 1);
  });

  it('never repeats the provider\'s answer back, in case it quotes the code', async () => {
    reset();
    reply = { status: 400, body: '{"echo":"123456 is your Commons code","key":"sg-secret"}' };
    const sender = new SendGridEmail({ apiKey: 'sg-secret', from: 'a@b.test', baseUrl: base, sleep: noSleep });
    await assert.rejects(
      () => sender.send('someone@example.test', 'Your code', '123456'),
      (error: Error) => {
        assert.equal(error.message.includes('123456'), false, 'the code leaked into an error message');
        assert.equal(error.message.includes('sg-secret'), false, 'the API key leaked into an error message');
        return true;
      },
    );
  });

  it('gives up on a provider that hangs', async () => {
    reset();
    delayMs = 300;
    const sender = new ResendEmail({
      apiKey: 'k', from: 'a@b.test', baseUrl: base, timeoutMs: 60, sleep: noSleep,
    });
    await assert.rejects(() => sender.send('someone@example.test', 'Your code', '123456'), /timed out|reach the provider/);
    delayMs = 0;
  });
});

describe('routing and configuration', () => {
  it('sends email codes by email and phone codes by SMS', async () => {
    reset();
    const sender = new ProviderSender(
      new ResendEmail({ apiKey: 'k', from: 'a@b.test', baseUrl: base, sleep: noSleep }),
      new MessageBirdSms({ apiKey: 'm', from: 'Commons', baseUrl: base, sleep: noSleep }),
    );
    await sender.send('someone@example.test', 'email', '111111');
    await sender.send('+447700900123', 'phone', '222222');
    await sender.send('someone@example.test', 'reset', '333333');

    assert.deepEqual(seen.map((s) => s.url), ['/emails', '/messages', '/emails']);
    const resetBody = JSON.parse(seen[2]?.body ?? '{}');
    assert.match(resetBody.subject, /password/i, 'a reset code should not read like a sign-up code');
  });

  it('says plainly when a half is missing rather than pretending to send', async () => {
    reset();
    const emailOnly = new ProviderSender(
      new ResendEmail({ apiKey: 'k', from: 'a@b.test', baseUrl: base, sleep: noSleep }),
      null,
    );
    await assert.rejects(() => emailOnly.send('+447700900123', 'phone', '1'), /No SMS provider/);
    assert.equal(seen.length, 0);
  });

  it('builds nothing when nothing is configured', () => {
    assert.equal(sendersFromEnv({}), null);
  });

  it('builds both halves from the environment', () => {
    const sender = sendersFromEnv({
      EMAIL_PROVIDER: 'postmark', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.test',
      SMS_PROVIDER: 'twilio', SMS_API_KEY: 'tok', SMS_FROM: '+1', SMS_ACCOUNT_ID: 'AC1',
    } as NodeJS.ProcessEnv);
    assert.equal(sender?.name, 'postmark + twilio');
  });

  it('refuses a half-configured provider instead of starting up broken', () => {
    assert.throws(
      () => sendersFromEnv({ EMAIL_PROVIDER: 'resend' } as NodeJS.ProcessEnv),
      /EMAIL_API_KEY or EMAIL_FROM/,
    );
    assert.throws(
      () => sendersFromEnv({ SMS_PROVIDER: 'twilio', SMS_API_KEY: 'k', SMS_FROM: '+1' } as NodeJS.ProcessEnv),
      /SMS_ACCOUNT_ID/,
    );
    assert.throws(
      () => sendersFromEnv({ EMAIL_PROVIDER: 'carrier-pigeon', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.test' } as NodeJS.ProcessEnv),
      /not one of/,
    );
  });

  it('writes codes people can act on', async () => {
    reset();
    const sender = new ProviderSender(
      new ResendEmail({ apiKey: 'k', from: 'a@b.test', baseUrl: base, sleep: noSleep }),
      new MessageBirdSms({ apiKey: 'm', from: 'Commons', baseUrl: base, sleep: noSleep }),
    );
    await sender.send('+447700900123', 'phone', '424242');
    const text = JSON.parse(seen[0]?.body ?? '{}').body as string;
    assert.match(text, /424242/);
    assert.match(text, /Commons/, 'a code with no sender named reads exactly like a scam');
    assert.ok(text.length <= 160, `an SMS should fit one segment, this was ${text.length}`);
  });
});
