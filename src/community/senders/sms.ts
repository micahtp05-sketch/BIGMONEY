import { basicAuth, post } from './http.ts';

export interface SmsSender {
  readonly name: string;
  send(to: string, text: string): Promise<void>;
}

export interface SmsConfig {
  /** Twilio: the account SID. MessageBird: unused. */
  accountId?: string;
  apiKey: string;
  /** The number or sender ID messages come from. */
  from: string;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Twilio. Form-encoded, basic auth of account SID and auth token.
 * https://www.twilio.com/docs/messaging/api/message-resource
 */
export class TwilioSms implements SmsSender {
  readonly name = 'twilio';
  private readonly config: SmsConfig;

  constructor(config: SmsConfig) {
    this.config = config;
  }

  async send(to: string, text: string): Promise<void> {
    const account = this.config.accountId;
    if (!account) throw new Error('Twilio needs an account SID.');
    const form = new URLSearchParams({ To: to, From: this.config.from, Body: text });
    await post({
      url: `${this.config.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(account)}/Messages.json`,
      headers: {
        authorization: basicAuth(account, this.config.apiKey),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeoutMs: this.config.timeoutMs,
      sleep: this.config.sleep,
    });
  }
}

/**
 * MessageBird. JSON, and an AccessKey rather than a bearer token.
 * https://developers.messagebird.com/api/sms-messaging/
 */
export class MessageBirdSms implements SmsSender {
  readonly name = 'messagebird';
  private readonly config: SmsConfig;

  constructor(config: SmsConfig) {
    this.config = config;
  }

  async send(to: string, text: string): Promise<void> {
    await post({
      url: `${this.config.baseUrl ?? 'https://rest.messagebird.com'}/messages`,
      headers: {
        authorization: `AccessKey ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ originator: this.config.from, recipients: [to], body: text }),
      timeoutMs: this.config.timeoutMs,
      sleep: this.config.sleep,
    });
  }
}

export const SMS_PROVIDERS = {
  twilio: TwilioSms,
  messagebird: MessageBirdSms,
} as const;

export type SmsProviderName = keyof typeof SMS_PROVIDERS;
