import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, quantile, rejectOutliers, trimmedMean } from '../src/aggregate.ts';
import type { Listing } from '../src/types.ts';

const listing = (priceCents: number, currency = 'USD'): Listing => ({
  title: `Item @ ${priceCents}`,
  priceCents,
  currency,
  condition: 'Used',
  url: null,
  source: 'test',
  sold: true,
});

describe('quantile', () => {
  it('interpolates between neighbours', () => {
    assert.equal(quantile([10, 20, 30, 40], 0.5), 25);
    assert.equal(quantile([10, 20, 30, 40], 0.25), 17.5);
  });

  it('handles a single value', () => {
    assert.equal(quantile([42], 0.9), 42);
  });

  it('throws on an empty sample rather than returning NaN', () => {
    assert.throws(() => quantile([], 0.5));
  });
});

describe('rejectOutliers', () => {
  it('drops values outside the Tukey fences', () => {
    const { kept, removed } = rejectOutliers([100, 105, 110, 115, 120, 5000]);
    assert.ok(!kept.includes(5000));
    assert.deepEqual(removed, [5000]);
  });

  it('leaves small samples alone — quartiles are meaningless below 4 points', () => {
    const { kept, removed } = rejectOutliers([10, 20, 9000]);
    assert.equal(kept.length, 3);
    assert.equal(removed.length, 0);
  });

  it('does not gut a sample where every price is identical', () => {
    const { kept, removed } = rejectOutliers([50, 50, 50, 50, 50]);
    assert.equal(kept.length, 5);
    assert.equal(removed.length, 0);
  });
});

describe('trimmedMean', () => {
  it('discards the tails', () => {
    // Plain mean is 1090.9; trimming removes the 10000.
    const values = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 10000];
    assert.ok(trimmedMean(values, 0.1) < 200);
  });
});

describe('aggregate', () => {
  it('reports the median of the surviving sample', () => {
    const listings = [90, 95, 100, 105, 110].map((d) => listing(d * 100));
    const est = aggregate(listings, 0.9);
    assert.ok(est);
    assert.equal(est.estimateCents, 10000);
    assert.equal(est.sampleSize, 5);
  });

  it('is not dragged by an accessory listed under the item name', () => {
    const real = [16000, 16500, 17000, 17500, 18000, 15500, 17200].map((p) => listing(p));
    const junk = [listing(1299), listing(3400)];
    const est = aggregate([...real, ...junk], 0.9);
    assert.ok(est);
    assert.ok(est.outliersRemoved > 0, 'expected the cheap junk to be fenced out');
    assert.ok(est.estimateCents > 15000, `estimate ${est.estimateCents} was dragged down`);
  });

  it('returns null rather than inventing a number with no data', () => {
    assert.equal(aggregate([], 0.9), null);
  });

  it('picks the dominant currency instead of mixing units', () => {
    const listings = [
      ...[100, 110, 120].map((d) => listing(d * 100, 'USD')),
      listing(9_000_000, 'JPY'),
    ];
    const est = aggregate(listings, 0.9);
    assert.ok(est);
    assert.equal(est.currency, 'USD');
    assert.equal(est.sampleSize, 3);
  });

  it('caps confidence when identification was weak', () => {
    const listings = Array.from({ length: 30 }, (_, i) => listing(10000 + i * 10));
    const sure = aggregate(listings, 1.0);
    const unsure = aggregate(listings, 0.2);
    assert.ok(sure && unsure);
    assert.ok(unsure.confidence < sure.confidence / 2);
  });

  it('reports low confidence on a thin sample', () => {
    const est = aggregate([listing(10000), listing(10500)], 1.0);
    assert.ok(est);
    assert.ok(est.confidence < 0.2, `expected low confidence, got ${est.confidence}`);
  });
});
