import type { Estimate, Listing } from './types.ts';

/** Linear-interpolated quantile over a sorted ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error('quantile of empty array');
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function median(sorted: number[]): number {
  return quantile(sorted, 0.5);
}

/**
 * Tukey fences. Listings outside [Q1 - k*IQR, Q3 + k*IQR] are dropped.
 *
 * Marketplace data is full of junk comparables — a phone case listed under the
 * phone's name, a lot of ten sold as one. Those land far outside the middle of
 * the distribution, and the median alone would still be dragged by enough of
 * them. Trimming first is what makes the rest of the numbers trustworthy.
 */
export function rejectOutliers(values: number[], k = 1.5): { kept: number[]; removed: number[] } {
  // Below 4 points the quartiles are too unstable to fence with.
  if (values.length < 4) return { kept: [...values], removed: [] };

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - k * iqr;
  const upper = q3 + k * iqr;

  const kept: number[] = [];
  const removed: number[] = [];
  for (const v of values) (v >= lower && v <= upper ? kept : removed).push(v);

  // An IQR of zero fences everything that isn't the exact modal price.
  // That's not an outlier signal, so keep the original sample.
  if (kept.length < 3) return { kept: [...values], removed: [] };
  return { kept, removed };
}

/** Mean after discarding `proportion` from each tail. */
export function trimmedMean(values: number[], proportion = 0.1): number {
  if (values.length === 0) throw new Error('trimmedMean of empty array');
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * proportion);
  const core = sorted.length - 2 * cut >= 1 ? sorted.slice(cut, sorted.length - cut) : sorted;
  return core.reduce((a, b) => a + b, 0) / core.length;
}

/**
 * Confidence blends three independent signals, each in 0..1:
 *   - sample:   more comparables -> more trust. Saturates around 25.
 *   - spread:   a tight price band means the market agrees on a value.
 *   - identity: no amount of good price data rescues a misidentified item.
 * Multiplied rather than averaged, so any one being terrible caps the result.
 */
function scoreConfidence(
  kept: number[],
  identificationConfidence: number,
): { score: number; reason: string } {
  const sampleScore = Math.min(1, kept.length / 25);

  const mid = median([...kept].sort((a, b) => a - b));
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  const variance = kept.reduce((acc, v) => acc + (v - mean) ** 2, 0) / kept.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  // CV of 0 -> 1.0; CV of 0.6+ -> 0. Typical resale spread lands near 0.25.
  const spreadScore = Math.max(0, 1 - cv / 0.6);

  const score = sampleScore * spreadScore * identificationConfidence;

  const weakest = Math.min(sampleScore, spreadScore, identificationConfidence);
  let reason: string;
  if (weakest === sampleScore) {
    reason = `Based on ${kept.length} comparable listing${kept.length === 1 ? '' : 's'}${
      kept.length < 10 ? ' — a larger sample would tighten this' : ''
    }.`;
  } else if (weakest === spreadScore) {
    reason = `Comparable prices vary widely (±${Math.round(cv * 100)}% around ${formatCents(mid)}), so the true value depends heavily on condition and specifics.`;
  } else {
    reason = 'The item was hard to identify confidently from the photo, so the comparables may not match.';
  }

  return { score: Number(score.toFixed(3)), reason };
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Turn raw comparables into an estimate. Returns null when there is nothing
 * defensible to report rather than inventing a number from one data point.
 */
export function aggregate(
  listings: Listing[],
  identificationConfidence: number,
): Estimate | null {
  if (listings.length === 0) return null;

  // Mixing currencies would silently average dollars with yen. Use whichever
  // currency dominates the sample and drop the rest.
  const byCurrency = new Map<string, Listing[]>();
  for (const l of listings) {
    const bucket = byCurrency.get(l.currency) ?? [];
    bucket.push(l);
    byCurrency.set(l.currency, bucket);
  }
  const [currency, group] = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;

  const prices = group.map((l) => l.priceCents).filter((p) => p > 0);
  if (prices.length === 0) return null;

  const { kept, removed } = rejectOutliers(prices);
  const sorted = [...kept].sort((a, b) => a - b);
  const { score, reason } = scoreConfidence(kept, identificationConfidence);

  return {
    estimateCents: Math.round(median(sorted)),
    lowCents: Math.round(quantile(sorted, 0.25)),
    highCents: Math.round(quantile(sorted, 0.75)),
    currency,
    trimmedMeanCents: Math.round(trimmedMean(kept)),
    sampleSize: kept.length,
    outliersRemoved: removed.length,
    confidence: score,
    confidenceReason: reason,
  };
}
