import { randomUUID } from 'node:crypto';
import type { Business, MetricsSnapshot } from './types.ts';

const MONTHS = 8;

/**
 * A worked example: a small coffee subscription business that is growing and
 * losing money at the same time.
 *
 * The figures are constructed, not random, and they are constructed to be
 * instructive — the margin is thin, acquisition costs nearly as much as a
 * customer returns, one wholesale account is a third of revenue, and the cash
 * runs out inside two quarters. Every pillar has something real in it, which
 * is what makes the dashboard judgeable before anyone types in a year of their
 * own numbers.
 */
export function demoBusiness(now = new Date()): Business {
  const snapshots: MetricsSnapshot[] = [];

  let activeCustomers = 900;
  let cashCents = 14_000_000;

  for (let i = MONTHS - 1; i >= 0; i--) {
    const period = monthsBefore(now, i + 1);
    const revenueCents = Math.round(3_800_000 * 1.08 ** (MONTHS - 1 - i));
    const cogsCents = Math.round(revenueCents * 0.62);
    const marketingSpendCents = Math.round(revenueCents * 0.28);
    const opexCents = 1_700_000 + marketingSpendCents;

    const churnedCustomers = Math.round(activeCustomers * 0.11);
    const newCustomers = Math.round(activeCustomers * 0.18);
    activeCustomers = activeCustomers - churnedCustomers + newCustomers;
    cashCents = Math.max(0, cashCents + (revenueCents - cogsCents - opexCents));

    snapshots.push({
      period,
      revenueCents,
      cogsCents,
      opexCents,
      cashCents,
      marketingSpendCents,
      newCustomers,
      churnedCustomers,
      activeCustomers,
      headcount: 4,
      // One wholesale account that arrived early and never stopped growing.
      topCustomerShare: 0.31,
      platformFeesCents: null,
      unitsSold: null,
      unitsReturned: null,
      sessions: null,
      adAttributedSalesCents: null,
      unitsOnHand: null,
      buyBoxShare: null,
      notes: null,
    });
  }

  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'Northbeam Coffee (demo)',
    industry: 'specialty coffee subscriptions, direct to consumer plus one wholesale account',
    model: 'ecommerce',
    stage: 'early',
    currency: 'USD',
    goals: [
      'Reach break-even without raising money',
      'Cut reliance on the wholesale account to under a fifth of revenue',
    ],
    createdAt,
    updatedAt: createdAt,
    snapshots,
    actions: [],
  };
}

/** Cents rounded to a whole unit of currency, so a demo ledger reads like one
 *  a person typed rather than the output of a growth formula. */
function whole(cents: number): number {
  return Math.round(cents / 100) * 100;
}

/** `YYYY-MM` for the month `count` months before `now`. */
function monthsBefore(now: Date, count: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * A second worked example: an Amazon FBA seller that is profitable on paper
 * and squeezed everywhere it matters.
 *
 * The shape is the one sellers actually hit at this size. Gross margin is fine
 * *after* fees, which is why nothing looks wrong until the fee line and the ad
 * line are read together; the bottom line is thin because the two of them plus
 * a modest overhead consume almost everything; stock cover is under a month,
 * so the profit that exists is committed to the next purchase order; and the
 * whole business runs through one channel, with a Buy Box it does not fully
 * own.
 */
export function amazonDemoBusiness(now = new Date()): Business {
  const snapshots: MetricsSnapshot[] = [];

  const UNIT_PRICE_CENTS = 3_200;
  let cashCents = 9_500_000;

  for (let i = MONTHS - 1; i >= 0; i--) {
    const period = monthsBefore(now, i + 1);
    const revenueCents = whole(12_000_000 * 1.06 ** (MONTHS - 1 - i));
    const cogsCents = whole(revenueCents * 0.38);
    // Referral (~15%) plus fulfilment and storage.
    const platformFeesCents = whole(revenueCents * 0.34);
    const marketingSpendCents = whole(revenueCents * 0.15);
    const opexCents = 1_400_000 + marketingSpendCents;

    const unitsSold = Math.round(revenueCents / UNIT_PRICE_CENTS);
    cashCents = whole(
      Math.max(0, cashCents + (revenueCents - cogsCents - platformFeesCents - opexCents)),
    );

    snapshots.push({
      period,
      revenueCents,
      cogsCents,
      platformFeesCents,
      opexCents,
      cashCents,
      marketingSpendCents,
      newCustomers: null,
      churnedCustomers: null,
      activeCustomers: null,
      headcount: 3,
      topCustomerShare: null,
      unitsSold,
      unitsReturned: Math.round(unitsSold * 0.07),
      // A 9% unit session percentage — real traffic, mediocre conversion.
      sessions: Math.round(unitsSold / 0.09),
      adAttributedSalesCents: whole(revenueCents * 0.45),
      // Under a month of cover: every reorder is a race.
      unitsOnHand: Math.round((unitsSold * 28) / 30),
      buyBoxShare: 0.74,
      notes: null,
    });
  }

  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'Harbor & Pine (Amazon demo)',
    industry: 'kitchen and home goods sold on Amazon FBA, private label, eleven ASINs',
    model: 'amazon',
    stage: 'growth',
    currency: 'USD',
    goals: [
      'Get the bottom line above 10% without cutting ad spend to zero',
      'Stop running out of stock on the two best sellers',
    ],
    createdAt,
    updatedAt: createdAt,
    snapshots,
    actions: [],
  };
}
