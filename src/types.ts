/** Everything the pipeline passes around. One place to look. */

/** What the vision model extracted from the photo. */
export interface ItemIdentification {
  /** Human-readable name, e.g. "Sony WH-1000XM4 Wireless Headphones". */
  title: string;
  /** Broad category, e.g. "electronics", "furniture", "clothing". */
  category: string;
  brand: string | null;
  model: string | null;
  /** Visible condition, inferred from the photo alone. */
  condition: 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'unknown';
  /** Search strings to feed price sources, most specific first. */
  searchQueries: string[];
  /** 0..1 — how sure the model is about the identification itself. */
  confidence: number;
  /** Anything that would change the price a search can't capture. */
  notes: string | null;
}

/** A single comparable listing from some marketplace. */
export interface Listing {
  title: string;
  /** Price in minor units (cents) to avoid float drift. */
  priceCents: number;
  currency: string;
  condition: string | null;
  url: string | null;
  source: string;
  /** True when the price is a completed sale rather than an asking price. */
  sold: boolean;
}

/** The aggregated estimate handed back to the client. */
export interface Estimate {
  /** Headline number — the median of the kept sample. */
  estimateCents: number;
  /** Interquartile range: where the middle half of the market sits. */
  lowCents: number;
  highCents: number;
  currency: string;
  /** Robust mean after trimming the tails. */
  trimmedMeanCents: number;
  /** How many listings survived outlier rejection. */
  sampleSize: number;
  /** How many were discarded as outliers. */
  outliersRemoved: number;
  /** 0..1, combining sample size, price spread, and identification confidence. */
  confidence: number;
  /** Plain-language reason the confidence is what it is. */
  confidenceReason: string;
}

export interface EstimateResponse {
  item: ItemIdentification;
  estimate: Estimate | null;
  listings: Listing[];
  /** Non-fatal problems worth showing the user. */
  warnings: string[];
}

/** A marketplace the estimator can search. Implement this to add a source. */
export interface PriceSource {
  readonly name: string;
  /** Returns comparable listings, or an empty array when nothing matches. */
  search(query: string, opts: { limit: number }): Promise<Listing[]>;
}
