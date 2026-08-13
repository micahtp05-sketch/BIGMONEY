import type { Listing, PriceSource } from '../types.ts';

const HOSTS = {
  PRODUCTION: { api: 'https://api.ebay.com', auth: 'https://api.ebay.com/identity/v1/oauth2/token' },
  SANDBOX: {
    api: 'https://api.sandbox.ebay.com',
    auth: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
  },
} as const;

const SCOPE = 'https://api.ebay.com/oauth/api_scope';

export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  env?: 'PRODUCTION' | 'SANDBOX';
  /** e.g. EBAY_US, EBAY_GB, EBAY_DE */
  marketplace?: string;
}

/**
 * eBay Browse API adapter.
 *
 * Written against eBay's documented Browse API (`/buy/browse/v1/item_summary/search`)
 * with client-credentials OAuth. It has NOT been exercised against the live API
 * from this repo — the development container has no outbound network access —
 * so treat the first live run as the real test. The request/response shapes and
 * auth flow follow eBay's published contract.
 *
 * Note on what this returns: the Browse API surfaces ACTIVE listings, i.e. asking
 * prices, not completed sales. Asking prices skew high relative to realized value.
 * Sold-price data requires eBay's Marketplace Insights API, which is access-gated.
 * `sold: false` on every listing here is the honest signal for that.
 */
export class EbaySource implements PriceSource {
  readonly name = 'ebay';
  #token: { value: string; expiresAt: number } | null = null;

  readonly #config: EbayConfig;

  constructor(config: EbayConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('EbaySource requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.');
    }
    this.#config = config;
  }

  get #hosts() {
    return HOSTS[this.#config.env ?? 'PRODUCTION'];
  }

  /** Client-credentials token, cached until 60s before expiry. */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt) return this.#token.value;

    const basic = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString(
      'base64',
    );
    const res = await fetch(this.#hosts.auth, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }),
    });
    if (!res.ok) {
      throw new Error(`eBay OAuth failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    return this.#token.value;
  }

  async search(query: string, opts: { limit: number }): Promise<Listing[]> {
    const token = await this.#accessToken();
    const url = new URL('/buy/browse/v1/item_summary/search', this.#hosts.api);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(opts.limit, 200)));
    // Used items are the right comparable for a resale estimate.
    url.searchParams.set('filter', 'conditionIds:{3000|4000|5000|6000}');

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': this.#config.marketplace ?? 'EBAY_US',
      },
    });
    if (!res.ok) {
      throw new Error(`eBay search failed (${res.status}): ${await res.text()}`);
    }

    const body = (await res.json()) as {
      itemSummaries?: Array<{
        title?: string;
        price?: { value?: string; currency?: string };
        condition?: string;
        itemWebUrl?: string;
      }>;
    };

    return (body.itemSummaries ?? [])
      .map((item): Listing | null => {
        const value = Number.parseFloat(item.price?.value ?? '');
        if (!Number.isFinite(value) || value <= 0) return null;
        return {
          title: item.title ?? 'Untitled listing',
          priceCents: Math.round(value * 100),
          currency: item.price?.currency ?? 'USD',
          condition: item.condition ?? null,
          url: item.itemWebUrl ?? null,
          source: this.name,
          // Browse API returns active listings — asking prices, not sales.
          sold: false,
        };
      })
      .filter((l): l is Listing => l !== null);
  }
}
