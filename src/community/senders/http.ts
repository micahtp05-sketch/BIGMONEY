/**
 * The small amount of HTTP every provider adapter needs.
 *
 * Deliberately shared, because the things that go wrong when talking to a
 * third party are the same everywhere: it hangs, it rate-limits you, it
 * returns a 500 that would have worked a second later, and its error body
 * contains your API key.
 */

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Milliseconds before giving up on one attempt. */
  timeoutMs?: number;
  /** How many times to try in total. Only 5xx and network errors are retried. */
  attempts?: number;
  /** Injected in tests so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class SendFailed extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'SendFailed';
    this.status = status;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST, with a timeout and a few retries.
 *
 * A 4xx is the caller's fault and is never retried — retrying a rejected phone
 * number just sends the same rejection three times. A 5xx or a dropped
 * connection is retried with a short backoff.
 */
export async function post(options: PostOptions): Promise<string> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? wait;
  let lastError: SendFailed | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(options.url, {
        method: 'POST',
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();

      if (res.ok) return text;
      if (res.status >= 400 && res.status < 500) {
        // Their answer may quote back what we sent, including the code.
        throw new SendFailed(`Provider refused the request (${res.status}).`, res.status);
      }
      lastError = new SendFailed(`Provider is having trouble (${res.status}).`, res.status);
    } catch (error) {
      if (error instanceof SendFailed && error.status !== null && error.status < 500) throw error;
      lastError = error instanceof SendFailed
        ? error
        : new SendFailed(`Could not reach the provider: ${describe(error)}`, null);
    }

    if (attempt < attempts) await sleep(200 * attempt);
  }
  throw lastError ?? new SendFailed('Could not reach the provider.', null);
}

/** A short reason, never the whole error — those can carry request bodies. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.name;
  }
  return 'unknown error';
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}
