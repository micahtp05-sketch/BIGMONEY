import type { PushSubscriptionRecord } from './types.ts';

/**
 * Push notifications, the Web Push way.
 *
 * A member turns them on from their own page; the browser hands us a
 * subscription (an endpoint at the browser vendor's push service plus two
 * keys); we keep it; and on exactly four moments the server sends a short
 * message through it. The browser shows it, and tapping it opens the page.
 *
 * What is sent is deliberately small and never private: a name, a verb, a
 * post's title, a link. A message about a get-together says that one arrived,
 * never what it says — the whole design keeps where somebody lives off every
 * screen but the two people's own, and a lock screen is not one of those.
 *
 * `web-push` does the VAPID signing and the aes128gcm encryption (RFC 8291,
 * 8292). It is the first runtime dependency this codebase has taken beyond
 * Fastify, Zod and the Anthropic SDK; the owner chose it over a week of
 * per-platform native push, because this one reaches the website and the
 * installed app alike.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping it goes, relative to the app: e.g. `/#/p/<id>`. */
  url: string;
  /** Notifications with the same tag replace each other rather than stacking. */
  tag?: string;
}

/** What sending to one subscription came to. */
export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * The seam between the routes and the wire. The real one wraps `web-push`;
 * tests inject one that records what would have been sent.
 */
export interface PushSender {
  readonly name: string;
  /** VAPID public key, base64url, for the browser to subscribe with. */
  readonly publicKey: string;
  send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<PushResult>;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or an https URL the push service can contact about abuse. */
  subject: string;
}

/** The shape of `web-push`'s sendNotification, so the module can be injected. */
export type SendNotification = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { vapidDetails: VapidKeys; TTL: number; urgency: 'normal' },
) => Promise<unknown>;

/** Push services answer 404 or 410 for a subscription that no longer exists. */
const GONE = new Set([404, 410]);

export class WebPushSender implements PushSender {
  readonly name = 'web-push';
  readonly publicKey: string;
  private readonly keys: VapidKeys;
  private readonly sendNotification: SendNotification;

  constructor(keys: VapidKeys, sendNotification: SendNotification) {
    this.keys = keys;
    this.publicKey = keys.publicKey;
    this.sendNotification = sendNotification;
  }

  async send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<PushResult> {
    try {
      await this.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload),
        // A day: an answer is still worth knowing about tomorrow; after that, no.
        { vapidDetails: this.keys, TTL: 24 * 60 * 60, urgency: 'normal' },
      );
      return 'sent';
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      return typeof status === 'number' && GONE.has(status) ? 'gone' : 'failed';
    }
  }
}

/**
 * Build the sender from the environment, or return null when push is not
 * set up — which is fine: the client asks, sees it is off, and says so.
 *
 *   VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_SUBJECT=mailto:you@example.org
 *
 * `npm run push:keys` prints a fresh pair.
 */
export async function pushFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<PushSender | null> {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey || !subject) {
    throw new Error('Push is half-configured: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are all needed (npm run push:keys).');
  }
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: address or an https URL.');
  }
  const webpush = await import('web-push');
  return new WebPushSender({ publicKey, privateKey, subject }, webpush.default.sendNotification as SendNotification);
}

/** The four messages, in one place so the words stay short and the same. */
export const PUSH_COPY = {
  answered: (who: string, title: string, threadId: string): PushPayload => ({
    title: `${who} answered your question`,
    body: title,
    url: `/#/p/${threadId}`,
    tag: `answer-${threadId}`,
  }),
  worked: (who: string, title: string, threadId: string): PushPayload => ({
    title: `${who} said your answer worked`,
    body: title,
    url: `/#/p/${threadId}`,
    tag: `worked-${threadId}`,
  }),
  hello: (who: string): PushPayload => ({
    title: `${who} said hello`,
    body: 'Open Commons to say hello back.',
    url: '/#/hellos',
    tag: 'hello',
  }),
  // Never the message itself: it is the one place an address is written down.
  message: (who: string, title: string, threadId: string): PushPayload => ({
    title: `${who} sent you a message`,
    body: `About ${title}.`,
    url: `/#/p/${threadId}`,
    tag: `message-${threadId}`,
  }),
  test: (): PushPayload => ({
    title: 'Commons can reach you here',
    body: 'This is the test you asked for.',
    url: '/#/you',
    tag: 'test',
  }),
};
