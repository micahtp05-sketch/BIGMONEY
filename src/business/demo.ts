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

/** `YYYY-MM` for the month `count` months before `now`. */
function monthsBefore(now: Date, count: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
