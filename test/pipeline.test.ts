import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate } from '../src/aggregate.ts';
import { FixtureSource, gatherListings } from '../src/sources/index.ts';
import type { ItemIdentification } from '../src/types.ts';

/**
 * End-to-end over everything downstream of the vision call, which is stubbed
 * here — it needs the Claude API. This is the seam where a source change or a
 * stats change would break the product, so it is worth covering directly.
 */
describe('estimate pipeline (vision stubbed)', () => {
  const identified: ItemIdentification = {
    title: 'Sony WH-1000XM4 Wireless Headphones',
    category: 'electronics',
    brand: 'Sony',
    model: 'WH-1000XM4',
    condition: 'good',
    searchQueries: ['Sony WH-1000XM4 wireless headphones', 'wireless noise cancelling headphones'],
    confidence: 0.92,
    notes: null,
  };

  it('produces a sane estimate from identification through to aggregation', async () => {
    const { listings, warnings } = await gatherListings([new FixtureSource()], identified.searchQueries);
    assert.equal(warnings.length, 0);
    assert.ok(listings.length >= 10, `only got ${listings.length} listings`);

    const estimate = aggregate(listings, identified.confidence);
    assert.ok(estimate, 'expected an estimate');

    // The fixture contains a for-parts unit at $34 and ear pads at $12.99.
    // A working estimate must not be dragged toward those.
    assert.ok(estimate.outliersRemoved >= 1, 'expected junk comparables to be fenced out');
    assert.ok(
      estimate.estimateCents > 14000 && estimate.estimateCents < 21000,
      `estimate ${estimate.estimateCents} is outside the plausible band`,
    );
    assert.ok(estimate.lowCents <= estimate.estimateCents);
    assert.ok(estimate.highCents >= estimate.estimateCents);
    assert.equal(estimate.currency, 'USD');
    assert.ok(estimate.confidence > 0 && estimate.confidence <= 1);
  });

  it('returns no estimate, not a fabricated one, when the item is unknown', async () => {
    const unknown = { ...identified, searchQueries: ['antique brass orrery 1890'] };
    const { listings, warnings } = await gatherListings([new FixtureSource()], unknown.searchQueries);
    assert.equal(listings.length, 0);
    assert.ok(warnings.length > 0);
    assert.equal(aggregate(listings, unknown.confidence), null);
  });
});
