import { post } from './http.ts';

/** One provider's way of sending an email. */
export interface EmailSender {
  readonly name: string;
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface EmailConfig {
  apiKey: string;
  /** The address people see it come from. Must be one the provider allows. */
  from: string;
  /** Overridden in tests to point at a stub. */
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resend. JSON, bearer token, one endpoint.
 * https://resend.com/docs/api-reference/emails/send-email
 */
export class ResendEmail implements EmailSender {
  readonly name = 'resend';
  private readonly config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await post({
      url: `${this.config.baseUrl ?? 'https://api.resend.com'}/emails`,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: this.config.from, to: [to], subject, text }),
      timeoutMs: this.config.timeoutMs,
      sleep: this.config.sleep,
    });
  }
}

/**
 * Postmark. Its own header rather than a bearer token, and capitalised keys.
 * https://postmarkapp.com/developer/api/email-api
 */
export class PostmarkEmail implements EmailSender {
  readonly name = 'postmark';
  private readonly config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await post({
      url: `${this.config.baseUrl ?? 'https://api.postmarkapp.com'}/email`,
      headers: {
        'X-Postmark-Server-Token': this.config.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        From: this.config.from,
        To: to,
        Subject: subject,
        TextBody: text,
        // These are transactional. They must never be suppressed as marketing.
        MessageStream: 'outbound',
      }),
      timeoutMs: this.config.timeoutMs,
      sleep: this.config.sleep,
    });
  }
}

/**
 * SendGrid. Nested personalisations, and a 202 with an empty body on success.
 * https://www.twilio.com/docs/sendgrid/api-reference/mail-send
 */
export class SendGridEmail implements EmailSender {
  readonly name = 'sendgrid';
  private readonly config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await post({
      url: `${this.config.baseUrl ?? 'https://api.sendgrid.com'}/v3/mail/send`,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.config.from },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
      timeoutMs: this.config.timeoutMs,
      sleep: this.config.sleep,
    });
  }
}

export const EMAIL_PROVIDERS = {
  resend: ResendEmail,
  postmark: PostmarkEmail,
  sendgrid: SendGridEmail,
} as const;

export type EmailProviderName = keyof typeof EMAIL_PROVIDERS;
