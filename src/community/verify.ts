import { randomInt } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.ts';
import type { CommunityStore } from './store.ts';
import type { VerificationCode } from './types.ts';

/**
 * Sending a one-time code somewhere.
 *
 * The same shape as `PriceSource` on the estimator side, and for the same
 * reason: the thing that actually talks to Twilio or a mail provider is a
 * detail, and swapping it should not touch a route. Implement this and pass it
 * to `communityRoutes` to go live.
 */
export interface CodeSender {
  readonly name: string;
  send(to: string, channel: 'email' | 'phone' | 'reset', code: string): Promise<void>;
}

/**
 * The development sender: it logs the code and delivers nothing.
 *
 * It refuses to run when NODE_ENV is production, because an instance that
 * silently "sends" codes nobody receives would let anybody claim any address.
 */
export class ConsoleSender implements CodeSender {
  readonly name = 'console';

  async send(to: string, channel: 'email' | 'phone' | 'reset', code: string): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'No code sender is configured. Set one before running in production — ' +
        'without it, anybody can claim any email address or phone number.',
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[commons] ${channel} code for ${to}: ${code}`);
  }
}

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function codeId(userId: string, channel: VerificationCode['channel']): string {
  return `${userId}:${channel}`;
}

/**
 * Issue a code, store only its hash, and hand the plain code to the sender.
 *
 * Codes are hashed with the same scrypt helper as passwords, so a leaked data
 * file does not hand somebody a working code.
 */
export async function issueCode(
  store: CommunityStore,
  sender: CodeSender,
  userId: string,
  channel: VerificationCode['channel'],
  to: string,
): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const { salt, hash } = await hashPassword(code);
  store.codes.set(codeId(userId, channel), {
    id: codeId(userId, channel),
    userId,
    channel,
    hash,
    salt,
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
  });
  store.touch();
  await sender.send(to, channel, code);
}

export type CheckResult = 'ok' | 'wrong' | 'expired' | 'none' | 'too-many';

/** Check a code, and burn it whether it was right or ran out of attempts. */
export async function checkCode(
  store: CommunityStore,
  userId: string,
  channel: VerificationCode['channel'],
  submitted: string,
): Promise<CheckResult> {
  const id = codeId(userId, channel);
  const record = store.codes.get(id);
  if (!record) return 'none';
  if (record.expiresAt <= Date.now()) {
    store.codes.delete(id);
    store.touch();
    return 'expired';
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    store.codes.delete(id);
    store.touch();
    return 'too-many';
  }

  const ok = await verifyPassword(submitted.trim(), { salt: record.salt, hash: record.hash });
  if (ok) {
    store.codes.delete(id);
    store.touch();
    return 'ok';
  }
  record.attempts += 1;
  store.touch();
  return 'wrong';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
/** Digits, optionally a leading +, 7 to 15 of them. Deliberately permissive. */
const PHONE_RE = /^\+?\d{7,15}$/;

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!EMAIL_RE.test(trimmed)) return 'That does not look like an email address.';
  if (trimmed.length > 254) return 'That email address is too long.';
  return null;
}

export function validatePhone(phone: string): string | null {
  const compact = phone.replace(/[\s().-]/g, '');
  if (!PHONE_RE.test(compact)) {
    return 'That does not look like a phone number. Digits only, with the country code if you have it.';
  }
  return null;
}
