/**
 * Fixed-window rate limiter, keyed by whatever the caller decides identifies an
 * actor (user id, or IP for the signup route). In-memory and per-process, which
 * matches how the rest of Commons stores state — it slows down spam and
 * runaway clients, and is not a security boundary.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** True when the action is allowed; false when the window is exhausted. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + windowMs });
      this.sweep(t);
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  /** Drop expired windows so a long-running process does not leak keys. */
  private sweep(t: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= t) this.hits.delete(key);
    }
  }
}
