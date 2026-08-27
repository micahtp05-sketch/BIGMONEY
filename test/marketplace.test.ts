import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARKETPLACE_BENCHMARKS, sellsOnMarketplace } from '../src/business/benchmarks.ts';
import { amazonDemoBusiness } from '../src/business/demo.ts';
import { diagnose, scoreWithinBand } from '../src/business/diagnose.ts';
import { derive } from '../src/business/metrics.ts';
import type { Business, MetricsSnapshot } from '../src/business/types.ts';

const AT = new Date('2026-08-27T00:00:00Z');

function month(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    period: '2026-01',
    revenueCents: 10_000_000,
    cogsCents: 3_800_000,
    platformFeesCents: 3_400_000,
    opexCents: 2_000_000,
    cashCents: null,
    marketingSpendCents: null,
    newCustomers: null,
    churnedCustomers: null,
    activeCustomers: null,
    headcount: null,
    topCustomerShare: null,
    unitsSold: null,
    unitsReturned: null,
    sessions: null,
    adAttributedSalesCents: null,
    unitsOnHand: null,
    buyBoxShare: null,
    notes: null,
    ...over,
  };
}

function seller(snapshots: Partial<MetricsSnapshot>[], over: Partial<Business> = {}): Business {
  return {
    id: 'b1',
    name: 'Test Seller',
    industry: 'testing',
    model: 'amazon',
    stage: 'growth',
    currency: 'USD',
    goals: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    actions: [],
    ...over,
    snapshots: snapshots.map((s, i) => month({ period: `2026-0${i + 1}`, ...s })),
  };
}

describe('marketplace fees', () => {
  it('takes platform fees out before gross profit, like the cost of sale they are', () => {
    const m = derive([month()]);
    // 10,000,000 revenue - 3,800,000 product - 3,400,000 fees.
    assert.equal(m.grossProfitCents, 2_800_000);
    assert.equal(m.grossMargin, 0.28);
    assert.equal(m.platformFeeRatio, 0.34);
  });

  it('leaves margin untouched for a business that pays no platform fees', () => {
    const m = derive([month({ platformFeesCents: null })]);
    assert.equal(m.grossProfitCents, 6_200_000);
    assert.equal(m.platformFeeRatio, null);
  });

  it('counts fees as burn, so runway does not quietly ignore them', () => {
    const m = derive([month({ opexCents: 3_000_000, cashCents: 2_000_000 })]);
    // 10.0m in, 3.8m product + 3.4m fees + 3.0m opex = 10.2m out.
    assert.equal(m.netProfitCents, -200_000);
    assert.equal(m.avgBurnCents, 200_000);
    assert.equal(m.runwayMonths, 10);
  });
});

describe('marketplace ratios', () => {
  it('separates what advertising costs the advertised half from what it costs the business', () => {
    const m = derive([
      month({ marketingSpendCents: 1_500_000, adAttributedSalesCents: 4_500_000 }),
    ]);
    assert.equal(m.tacos, 0.15); // spend over all revenue
    assert.equal(Number(m.acos?.toFixed(4)), 0.3333); // spend over advertised revenue
  });

  it('derives conversion, returns and cover from unit counts', () => {
    const m = derive([
      month({ unitsSold: 500, sessions: 5_000, unitsReturned: 35, unitsOnHand: 250 }),
    ]);
    assert.equal(m.unitSessionPercent, 0.1);
    assert.equal(m.returnRate, 0.07);
    assert.equal(m.daysOfCover, 15);
  });

  it('reports no cover rather than infinite cover in a month with no sales', () => {
    const m = derive([month({ revenueCents: 0, unitsSold: 0, unitsOnHand: 400 })]);
    assert.equal(m.daysOfCover, null);
  });

  it('reports contribution only when both fees and ad spend are known', () => {
    assert.equal(derive([month({ marketingSpendCents: null })]).contributionCents, null);
    assert.equal(derive([month({ marketingSpendCents: 1_000_000 })]).contributionCents, 1_800_000);
  });
});

describe('scoreWithinBand', () => {
  const { daysOfCoverLow: low, daysOfCoverHigh: high } = MARKETPLACE_BENCHMARKS;

  it('scores anywhere inside the band as good as it gets', () => {
    for (const v of [low, 60, high]) assert.equal(scoreWithinBand(v, low, high), 100);
  });

  it('penalises both directions, on the same scale', () => {
    // Half the floor and twice the ceiling are equally wrong.
    assert.equal(scoreWithinBand(low / 2, low, high), scoreWithinBand(high * 2, low, high));
  });

  it('gets worse the further outside the band a value sits', () => {
    assert.ok(scoreWithinBand(30, low, high) > scoreWithinBand(10, low, high));
    assert.ok(scoreWithinBand(120, low, high) > scoreWithinBand(400, low, high));
  });

  it('rejects a band that is not a band', () => {
    assert.throws(() => scoreWithinBand(50, 0, 90), /positive and ordered/);
    assert.throws(() => scoreWithinBand(50, 90, 45), /positive and ordered/);
  });
});

describe('diagnosing a marketplace seller', () => {
  it('asks marketplace questions instead of customer-lifecycle ones', () => {
    const d = diagnose(
      seller([{ marketingSpendCents: 1_500_000, unitsSold: 500, sessions: 5_000 }]),
    );
    const ids = d.pillars.flatMap((p) => p.findings).map((f) => f.id);
    assert.ok(ids.includes('tacos'), 'expected an advertising check');
    assert.ok(ids.includes('platform-fee-load'), 'expected a fee check');
    for (const absent of ['churn', 'ltv-to-cac', 'cac-payback', 'customer-concentration']) {
      assert.ok(!ids.includes(absent), `${absent} does not apply to a marketplace seller`);
    }
  });

  it('does not ask a seller for figures they have no way of knowing', () => {
    const d = diagnose(seller([{}]));
    const needs = d.pillars.flatMap((p) => p.missing);
    for (const wrongQuestion of ['churnedCustomers', 'activeCustomers', 'topCustomerShare']) {
      assert.ok(!needs.includes(wrongQuestion), `should not ask for ${wrongQuestion}`);
    }
  });

  it('names the pillar for the work it actually holds', () => {
    const d = diagnose(seller([{ marketingSpendCents: 1_500_000 }]));
    assert.equal(
      d.pillars.find((p) => p.pillar === 'retention')?.label,
      'Advertising & conversion',
    );
  });

  it('flags running the whole business through one marketplace', () => {
    const d = diagnose(seller([{}]));
    const finding = d.priorities.find((f) => f.id === 'channel-concentration');
    assert.ok(finding, 'expected a channel concentration finding');
    assert.equal(finding.severity, 'warning');
  });

  it('runs the customer-concentration check for a seller who does have wholesale', () => {
    const d = diagnose(seller([{ topCustomerShare: 0.4 }]));
    const ids = d.pillars.flatMap((p) => p.findings).map((f) => f.id);
    assert.ok(ids.includes('customer-concentration'));
    assert.ok(!ids.includes('channel-concentration'), 'the wholesale figure answers it instead');
  });

  it('reads too little stock and too much stock as different problems', () => {
    const short = diagnose(seller([{ unitsSold: 500, unitsOnHand: 150 }])); // 9 days
    const heavy = diagnose(seller([{ unitsSold: 500, unitsOnHand: 5_000 }])); // 300 days
    const of = (d: ReturnType<typeof diagnose>) =>
      d.pillars.flatMap((p) => p.findings).find((f) => f.id === 'days-of-cover');

    assert.match(of(short)!.title, /days of stock left/);
    assert.match(of(short)!.pointer, /reorder point/);
    assert.match(of(heavy)!.title, /cash sitting in the warehouse/);
    assert.match(of(heavy)!.pointer, /storage fees/);
  });

  it('judges the same gross margin against the marketplace bar, not the ecommerce one', () => {
    const snapshots = [{ revenueCents: 10_000_000, cogsCents: 3_800_000, platformFeesCents: 3_400_000 }];
    const asSeller = diagnose(seller(snapshots));
    const asShop = diagnose(seller(snapshots, { model: 'ecommerce' }));
    const margin = (d: ReturnType<typeof diagnose>) =>
      d.pillars.flatMap((p) => p.findings).find((f) => f.id === 'gross-margin')!;

    // 28% after fees: healthy for a seller, well short for a direct shop.
    assert.equal(margin(asSeller).severity, 'ok');
    assert.equal(margin(asShop).severity, 'warning');
  });

  it('knows which models sell through a marketplace', () => {
    assert.equal(sellsOnMarketplace('amazon'), true);
    assert.equal(sellsOnMarketplace('ecommerce'), false);
  });
});

describe('the Amazon worked example', () => {
  const d = diagnose(amazonDemoBusiness(AT));

  it('scores every pillar, since a seller has all the inputs', () => {
    assert.equal(d.coverage, 1);
    assert.ok(d.pillars.every((p) => p.score !== null));
  });

  it('reads as profitable but squeezed', () => {
    assert.ok(d.overallScore !== null && d.overallScore > 50 && d.overallScore < 75, `scored ${d.overallScore}`);
    const net = d.priorities.find((f) => f.id === 'net-margin');
    assert.equal(net?.severity, 'critical', 'the thin bottom line is the headline');
    assert.ok(
      d.pillars.flatMap((p) => p.findings).some((f) => f.id === 'runway' && f.severity === 'ok'),
      'it is not burning cash — the squeeze is margin, not runway',
    );
  });

  it('surfaces the fee load, the ad load, and the stock risk together', () => {
    const ids = d.priorities.map((f) => f.id);
    for (const expected of ['platform-fee-load', 'tacos', 'days-of-cover', 'buy-box-share']) {
      assert.ok(ids.includes(expected), `expected ${expected} in the working list`);
    }
  });

  it('gives every marketplace finding evidence and a move', () => {
    for (const f of d.pillars.flatMap((p) => p.findings)) {
      assert.ok(f.pointer.length > 40, `${f.id} has no usable pointer`);
      assert.ok(f.evidence.length > 0, `${f.id} has no evidence`);
    }
  });
});
