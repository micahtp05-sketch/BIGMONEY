import type { Listing, PriceSource } from '../types.ts';
import { EbaySource } from './ebay.ts';
import { FixtureSource } from './fixture.ts';

export { EbaySource, FixtureSource };

/** Build the active source set from the environment. */
export function sourcesFromEnv(env: NodeJS.ProcessEnv = process.env): PriceSource[] {
  const selected = (env.PRICE_SOURCE ?? 'fixture').toLowerCase();
  switch (selected) {
    case 'ebay':
      return [
        new EbaySource({
          clientId: env.EBAY_CLIENT_ID ?? '',
          clientSecret: env.EBAY_CLIENT_SECRET ?? '',
          env: env.EBAY_ENV === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
          marketplace: env.EBAY_MARKETPLACE,
        }),
      ];
    case 'fixture':
      return [new FixtureSource()];
    default:
      throw new Error(`Unknown PRICE_SOURCE "${selected}". Use "fixture" or "ebay".`);
  }
}

/**
 * Run each query against each source until enough comparables accumulate.
 *
 * Queries arrive most-specific-first. Stopping as soon as the target is met
 * keeps a precise match from being diluted by the broad fallback query, which
 * would drag the estimate toward the category average.
 */
export async function gatherListings(
  sources: PriceSource[],
  queries: string[],
  opts: { target?: number; perQuery?: number } = {},
): Promise<{ listings: Listing[]; warnings: string[] }> {
  const target = opts.target ?? 25;
  const perQuery = opts.perQuery ?? 50;
  const listings: Listing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    const results = await Promise.allSettled(
      sources.map((s) => s.search(query, { limit: perQuery })),
    );

    for (const [i, result] of results.entries()) {
      const sourceName = sources[i]?.name ?? 'unknown';
      if (result.status === 'rejected') {
        warnings.push(`Source "${sourceName}" failed for "${query}": ${errText(result.reason)}`);
        continue;
      }
      for (const listing of result.value) {
        const key = `${listing.source}:${listing.title}:${listing.priceCents}`;
        if (seen.has(key)) continue;
        seen.add(key);
        listings.push(listing);
      }
    }

    if (listings.length >= target) break;
  }

  if (listings.length === 0) {
    warnings.push('No comparable listings found for any search query.');
  }
  return { listings, warnings };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
