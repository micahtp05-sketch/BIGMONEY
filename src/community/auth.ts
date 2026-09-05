import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_BYTES = 64;
export const SESSION_COOKIE = 'commons_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const MIN_PASSWORD_LENGTH = 10;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$/;

/**
 * Hash a password with scrypt and a fresh 16-byte salt.
 *
 * scrypt over PBKDF2 because it is memory-hard, and it ships in node's stdlib,
 * so the community side stays dependency-free like the rest of this repo.
 */
export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_BYTES);
  return { salt: salt.toString('base64'), hash: derived.toString('base64') };
}

/** Constant-time verification. Returns false rather than throwing on junk input. */
export async function verifyPassword(
  password: string,
  credential: { salt: string; hash: string },
): Promise<boolean> {
  let expected: Buffer;
  try {
    expected = Buffer.from(credential.hash, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_BYTES) return false;
  const derived = await scrypt(password, Buffer.from(credential.salt, 'base64'), KEY_BYTES);
  return timingSafeEqual(derived, expected);
}

/** 256 bits of randomness. Session tokens are never derived from user data. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function validateHandle(handle: string): string | null {
  const trimmed = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(trimmed)) {
    return 'Handle must be 3-30 characters: letters, numbers, dashes or underscores.';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password must be at most 200 characters.';
  return null;
}

/** Minimal RFC-6265 cookie header parse — enough to avoid pulling in a plugin. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue; // first wins, per convention
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Only mark Secure in production: local development is plain http.
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie(): string {
  return serializeSessionCookie('', 0);
}
