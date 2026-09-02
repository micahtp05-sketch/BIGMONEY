import type { CodeSender } from '../verify.ts';
import { EMAIL_PROVIDERS, type EmailProviderName, type EmailSender } from './email.ts';
import { SMS_PROVIDERS, type SmsProviderName, type SmsSender } from './sms.ts';

export { SendFailed } from './http.ts';
export type { EmailSender } from './email.ts';
export type { SmsSender } from './sms.ts';

/**
 * What a code looks like when it arrives.
 *
 * Short, plain, and it says what it is for — a code that turns up with no
 * context is exactly the shape a scam text takes, and this site's members are
 * the people scam texts are aimed at.
 */
export const COPY = {
  email: (code: string) => ({
    subject: `${code} is your Commons code`,
    text:
      `Your Commons code is ${code}.\n\n` +
      'Type it into the Commons page you have open to confirm this email address. ' +
      'It works for 15 minutes.\n\n' +
      'If you did not ask for this, you can ignore it. Nobody can use it without your password.',
  }),
  reset: (code: string) => ({
    subject: `${code} is your Commons password code`,
    text:
      `Your Commons code is ${code}.\n\n` +
      'Type it into the Commons page to choose a new password. It works for 15 minutes.\n\n' +
      'If you did not ask to change your password, ignore this and your password stays as it is.',
  }),
  phone: (code: string) =>
    `${code} is your Commons code. It works for 15 minutes. If you did not ask for it, ignore this.`,
};

/**
 * Routes each code to the right provider.
 *
 * Email and password-reset codes go by email; phone codes go by SMS. Either
 * half may be missing, in which case sending through it fails clearly rather
 * than silently — a code that never arrives looks, to the person waiting,
 * exactly like a broken site.
 */
export class ProviderSender implements CodeSender {
  readonly name: string;

  private readonly email: EmailSender | null;
  private readonly sms: SmsSender | null;

  constructor(email: EmailSender | null, sms: SmsSender | null) {
    this.email = email;
    this.sms = sms;
    this.name = `${email?.name ?? 'no email'} + ${sms?.name ?? 'no sms'}`;
  }

  async send(to: string, channel: 'email' | 'phone' | 'reset', code: string): Promise<void> {
    if (channel === 'phone') {
      if (!this.sms) throw new Error('No SMS provider is configured, so phone numbers cannot be confirmed.');
      await this.sms.send(to, COPY.phone(code));
      return;
    }
    if (!this.email) throw new Error('No email provider is configured, so email addresses cannot be confirmed.');
    const message = channel === 'reset' ? COPY.reset(code) : COPY.email(code);
    await this.email.send(to, message.subject, message.text);
  }
}

/**
 * Build senders from the environment.
 *
 *   EMAIL_PROVIDER=resend|postmark|sendgrid   EMAIL_API_KEY=...   EMAIL_FROM=...
 *   SMS_PROVIDER=twilio|messagebird            SMS_API_KEY=...     SMS_FROM=...
 *   SMS_ACCOUNT_ID=...   (Twilio only: the account SID)
 *
 * Returns null when nothing is configured, so the caller can fall back to the
 * console sender in development and refuse to start in production.
 */
export function sendersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderSender | null {
  const email = emailFromEnv(env);
  const sms = smsFromEnv(env);
  if (!email && !sms) return null;
  return new ProviderSender(email, sms);
}

function emailFromEnv(env: NodeJS.ProcessEnv): EmailSender | null {
  const name = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!name) return null;
  if (!(name in EMAIL_PROVIDERS)) {
    throw new Error(`EMAIL_PROVIDER "${name}" is not one of: ${Object.keys(EMAIL_PROVIDERS).join(', ')}`);
  }
  const apiKey = env.EMAIL_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new Error('EMAIL_PROVIDER is set but EMAIL_API_KEY or EMAIL_FROM is missing.');
  const Provider = EMAIL_PROVIDERS[name as EmailProviderName];
  return new Provider({ apiKey, from, baseUrl: env.EMAIL_BASE_URL?.trim() || undefined });
}

function smsFromEnv(env: NodeJS.ProcessEnv): SmsSender | null {
  const name = env.SMS_PROVIDER?.trim().toLowerCase();
  if (!name) return null;
  if (!(name in SMS_PROVIDERS)) {
    throw new Error(`SMS_PROVIDER "${name}" is not one of: ${Object.keys(SMS_PROVIDERS).join(', ')}`);
  }
  const apiKey = env.SMS_API_KEY?.trim();
  const from = env.SMS_FROM?.trim();
  if (!apiKey || !from) throw new Error('SMS_PROVIDER is set but SMS_API_KEY or SMS_FROM is missing.');
  if (name === 'twilio' && !env.SMS_ACCOUNT_ID?.trim()) {
    throw new Error('Twilio needs SMS_ACCOUNT_ID (the account SID) as well as SMS_API_KEY (the auth token).');
  }
  const Provider = SMS_PROVIDERS[name as SmsProviderName];
  return new Provider({
    apiKey,
    from,
    accountId: env.SMS_ACCOUNT_ID?.trim(),
    baseUrl: env.SMS_BASE_URL?.trim() || undefined,
  });
}
