import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FixtureSource, gatherListings } from '../src/sources/index.ts';
import type { Listing, PriceSource } from '../src/types.ts';

describe('FixtureSource', () => {
  it('matches a query to fixture data', async () => {
    const src = new FixtureSource();
    const results = await src.search('Sony WH-1000XM4 Wireless Headphones', { limit: 50 });
    assert.ok(results.length > 5);
    assert.ok(results.every((r) => r.priceCents > 0));
    assert.ok(results.every((r) => r.currency === 'USD'));
  });

  it('returns nothing for an unrelated query', async () => {
    const src = new FixtureSource();
    assert.deepEqual(await src.search('antique brass telescope', { limit: 50 }), []);
  });
});

class StubSource implements PriceSource {
  readonly name: string;
  readonly #rows: Listing[];

  constructor(name: string, rows: Listing[]) {
    this.name = name;
    this.#rows = rows;
  }

  async search(): Promise<Listing[]> {
    return this.#rows;
  }
}

class FailingSource implements PriceSource {
  readonly name = 'failing';
  async search(): Promise<Listing[]> {
    throw new Error('upstream exploded');
  }
}

const row = (priceCents: number, title = 'x'): Listing => ({
  title,
  priceCents,
  currency: 'USD',
  condition: null,
  url: null,
  source: 'stub',
  sold: false,
});

describe('gatherListings', () => {
  it('surfaces a failing source as a warning without losing the others', async () => {
    const { listings, warnings } = await gatherListings(
      [new FailingSource(), new StubSource('ok', [row(100)])],
      ['query'],
    );
    assert.equal(listings.length, 1);
    assert.ok(warnings.some((w) => w.includes('upstream exploded')));
  });

  it('deduplicates identical listings across queries', async () => {
    const dupe = row(500, 'same item');
    const { listings } = await gatherListings([new StubSource('s', [dupe, dupe])], ['a', 'b']);
    assert.equal(listings.length, 1);
  });

  it('stops at the broad fallback query once the target is met', async () => {
    const specific = new StubSource('s', Array.from({ length: 30 }, (_, i) => row(100 + i, `i${i}`)));
    let broadCalled = false;
    const broad: PriceSource = {
      name: 'broad',
      async search() {
        broadCalled = true;
        return [];
      },
    };
    // Both sources run per query, but the second query never fires.
    await gatherListings([specific], ['specific', 'broad'], { target: 25 });
    assert.equal(broadCalled, false);
    void broad;
  });

  it('warns when nothing at all is found', async () => {
    const { listings, warnings } = await gatherListings([new StubSource('s', [])], ['q']);
    assert.equal(listings.length, 0);
    assert.ok(warnings.some((w) => w.includes('No comparable listings')));
  });
});
