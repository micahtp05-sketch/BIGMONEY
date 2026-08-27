import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derive, deriveSeries } from '../src/business/metrics.ts';
import type { MetricsSnapshot } from '../src/business/types.ts';

function month(period: string, over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    period,
    revenueCents: 1_000_000,
    cogsCents: 400_000,
    opexCents: 500_000,
    cashCents: null,
    marketingSpendCents: null,
    newCustomers: null,
    churnedCustomers: null,
    activeCustomers: null,
    headcount: null,
    platformFeesCents: null,
    unitsSold: null,
    unitsReturned: null,
    sessions: null,
    adAttributedSalesCents: null,
    unitsOnHand: null,
    buyBoxShare: null,
    topCustomerShare: null,
    notes: null,
    ...over,
  };
}

describe('derive', () => {
  it('computes the P&L ratios from one month', () => {
    const m = derive([month('2026-01')]);
    assert.equal(m.grossProfitCents, 600_000);
    assert.equal(m.netProfitCents, 100_000);
    assert.equal(m.grossMargin, 0.6);
    assert.equal(m.netMargin, 0.1);
    assert.equal(m.opexRatio, 0.5);
  });

  it('reports null rather than zero when the inputs are absent', () => {
    const m = derive([month('2026-01')]);
    for (const field of ['churnRate', 'cacCents', 'ltvCents', 'ltvToCac', 'revenuePerHeadCents'] as const) {
      assert.equal(m[field], null, `${field} should be null without its inputs`);
    }
  });

  it('averages burn over three months so one lumpy month does not set runway', () => {
    // Two break-even months then one heavy month of equipment spend.
    const history = [
      month('2026-01', { opexCents: 600_000 }),
      month('2026-02', { opexCents: 600_000 }),
      month('2026-03', { opexCents: 1_200_000, cashCents: 3_000_000 }),
    ];
    const m = derive(history);
    // This month alone lost 600k; the trailing average is 200k.
    assert.equal(m.netProfitCents, -600_000);
    assert.equal(m.avgBurnCents, 200_000);
    assert.equal(m.runwayMonths, 15);
  });

  it('reports no runway clock when the trailing months are profitable', () => {
    const m = derive([month('2026-01', { cashCents: 5_000_000 })]);
    assert.equal(m.avgBurnCents, 0);
    assert.equal(m.runwayMonths, null);
  });

  it('compounds growth across the window rather than averaging the jumps', () => {
    const history = [
      month('2026-01', { revenueCents: 1_000_000 }),
      month('2026-02', { revenueCents: 1_100_000 }),
      month('2026-03', { revenueCents: 1_210_000 }),
      month('2026-04', { revenueCents: 1_331_000 }),
    ];
    const m = derive(history);
    assert.equal(m.revenueGrowth, 0.1);
    assert.ok(Math.abs(m.avgRevenueGrowth! - 0.1) < 1e-9);
  });

  it('measures churn against customers present at the start of the month', () => {
    const history = [
      month('2026-01', { activeCustomers: 200 }),
      month('2026-02', { activeCustomers: 210, churnedCustomers: 20, newCustomers: 30 }),
    ];
    const m = derive(history);
    // 20 of the 200 present on the first of the month, not 20 of the closing 210.
    assert.equal(m.churnRate, 0.1);
  });

  it('refuses to turn a clean month into infinite lifetime value', () => {
    const history = [
      month('2026-01', { activeCustomers: 100 }),
      month('2026-02', { activeCustomers: 100, churnedCustomers: 0, newCustomers: 0 }),
    ];
    const m = derive(history);
    assert.equal(m.churnRate, 0);
    assert.equal(m.ltvCents, null);
    assert.equal(m.ltvToCac, null);
  });

  it('derives LTV:CAC and payback from margin, not revenue', () => {
    const history = [
      month('2026-01', { activeCustomers: 100 }),
      month('2026-02', {
        revenueCents: 1_000_000,
        cogsCents: 400_000,
        activeCustomers: 100,
        churnedCustomers: 10,
        newCustomers: 10,
        marketingSpendCents: 120_000,
      }),
    ];
    const m = derive(history);
    // ARPU 10_000, gross margin 0.6 -> 6_000 of margin per customer per month.
    assert.equal(m.arpuCents, 10_000);
    assert.equal(m.cacCents, 12_000);
    assert.equal(m.ltvCents, 60_000); // 6_000 / 0.10 churn
    assert.equal(m.ltvToCac, 5);
    assert.equal(m.cacPaybackMonths, 2);
  });

  it('derives a series with one row per month, oldest first', () => {
    const series = deriveSeries([month('2026-03'), month('2026-01'), month('2026-02')]);
    assert.deepEqual(
      series.map((s) => s.period),
      ['2026-01', '2026-02', '2026-03'],
    );
  });

  it('throws rather than inventing a month when given nothing', () => {
    assert.throws(() => derive([]), /at least one snapshot/);
  });
});
