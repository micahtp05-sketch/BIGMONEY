import type { DerivedMetrics, MetricsSnapshot } from './types.ts';

/** How many months of history the averaged figures look back over. */
const BURN_WINDOW = 3;
const GROWTH_WINDOW = 4;

/** Snapshots sorted oldest-first. Everything downstream assumes this order. */
export function sortSnapshots(snapshots: MetricsSnapshot[]): MetricsSnapshot[] {
  return [...snapshots].sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Turn one month plus the months before it into every ratio worth watching.
 *
 * `history` must be ascending and end with the period being derived. A field
 * comes back null whenever its inputs are missing — the scoring layer drops
 * the checks that depend on it rather than reading a null as a zero, which is
 * the difference between "we don't know your churn" and "your churn is 0%".
 */
export function derive(history: MetricsSnapshot[]): DerivedMetrics {
  const sorted = sortSnapshots(history);
  const current = sorted.at(-1);
  if (!current) throw new Error('derive() needs at least one snapshot');
  const previous = sorted.at(-2) ?? null;

  // Marketplace fees are a cost of sale, so they come out before gross profit.
  // A seller whose margin looks fine until the referral and fulfilment lines
  // land is the single most common way this dashboard earns its keep.
  const platformFeesCents = current.platformFeesCents ?? 0;
  const grossProfitCents = current.revenueCents - current.cogsCents - platformFeesCents;
  const netProfitCents = grossProfitCents - current.opexCents;
  const hasRevenue = current.revenueCents > 0;

  // Trailing burn, not this month's: a single lumpy month of equipment spend
  // would otherwise report a runway of weeks for a business that is fine.
  const marketing = current.marketingSpendCents;
  const window = sorted.slice(-BURN_WINDOW);
  const avgNet = window.reduce((sum, s) => sum + net(s), 0) / window.length;
  const avgBurnCents = Math.max(0, Math.round(-avgNet));
  const runwayMonths =
    current.cashCents !== null && avgBurnCents > 0
      ? current.cashCents / avgBurnCents
      : null;

  const revenueGrowth =
    previous && previous.revenueCents > 0
      ? (current.revenueCents - previous.revenueCents) / previous.revenueCents
      : null;

  const growthWindow = sorted.slice(-GROWTH_WINDOW);
  const first = growthWindow[0];
  const spans = growthWindow.length - 1;
  const avgRevenueGrowth =
    first && spans >= 1 && first.revenueCents > 0
      ? (current.revenueCents / first.revenueCents) ** (1 / spans) - 1
      : null;

  // Customers at the start of the month: last month's closing count when we
  // have it, otherwise reconstructed from the flows.
  const startCustomers =
    previous?.activeCustomers ??
    (current.activeCustomers !== null &&
    current.churnedCustomers !== null &&
    current.newCustomers !== null
      ? current.activeCustomers + current.churnedCustomers - current.newCustomers
      : null);

  const churnRate =
    current.churnedCustomers !== null && startCustomers !== null && startCustomers > 0
      ? current.churnedCustomers / startCustomers
      : null;

  const arpuCents =
    current.activeCustomers !== null && current.activeCustomers > 0
      ? current.revenueCents / current.activeCustomers
      : null;

  const cacCents =
    current.marketingSpendCents !== null && current.newCustomers !== null && current.newCustomers > 0
      ? current.marketingSpendCents / current.newCustomers
      : null;

  const grossMargin = hasRevenue ? grossProfitCents / current.revenueCents : null;

  // Gross-margin-weighted LTV: revenue a customer brings is not money you keep.
  // Zero observed churn would divide by zero and claim infinite value, so it
  // reports null instead — one clean month is not evidence of immortality.
  const marginPerMonth =
    arpuCents !== null && grossMargin !== null ? arpuCents * grossMargin : null;
  const ltvCents =
    marginPerMonth !== null && churnRate !== null && churnRate > 0
      ? marginPerMonth / churnRate
      : null;

  return {
    period: current.period,
    revenueCents: current.revenueCents,
    grossProfitCents,
    netProfitCents,
    grossMargin,
    netMargin: hasRevenue ? netProfitCents / current.revenueCents : null,
    opexRatio: hasRevenue ? current.opexCents / current.revenueCents : null,
    platformFeeRatio:
      hasRevenue && current.platformFeesCents !== null
        ? current.platformFeesCents / current.revenueCents
        : null,
    avgBurnCents,
    runwayMonths,
    revenueGrowth,
    avgRevenueGrowth,
    churnRate,
    arpuCents,
    cacCents,
    ltvCents,
    ltvToCac: ltvCents !== null && cacCents !== null && cacCents > 0 ? ltvCents / cacCents : null,
    cacPaybackMonths:
      cacCents !== null && marginPerMonth !== null && marginPerMonth > 0
        ? cacCents / marginPerMonth
        : null,
    revenuePerHeadCents:
      current.headcount !== null && current.headcount > 0
        ? current.revenueCents / current.headcount
        : null,
    topCustomerShare: current.topCustomerShare,

    acos:
      marketing !== null &&
      current.adAttributedSalesCents !== null &&
      current.adAttributedSalesCents > 0
        ? marketing / current.adAttributedSalesCents
        : null,
    tacos: marketing !== null && hasRevenue ? marketing / current.revenueCents : null,
    unitSessionPercent:
      current.unitsSold !== null && current.sessions !== null && current.sessions > 0
        ? current.unitsSold / current.sessions
        : null,
    returnRate:
      current.unitsReturned !== null && current.unitsSold !== null && current.unitsSold > 0
        ? current.unitsReturned / current.unitsSold
        : null,
    // What the month actually added, once the platform and the ads are paid.
    contributionCents:
      current.platformFeesCents !== null && marketing !== null
        ? grossProfitCents - marketing
        : null,
    // Stock left at the current rate of sale. Thirty days is a month of sales,
    // not a month of calendar — a seller who sells nothing has infinite cover
    // and no business, so a zero sales month reports null rather than a number.
    daysOfCover:
      current.unitsOnHand !== null && current.unitsSold !== null && current.unitsSold > 0
        ? (current.unitsOnHand / current.unitsSold) * 30
        : null,
    buyBoxShare: current.buyBoxShare,
  };
}

/** Derived metrics for every month, so trends can be charted. */
export function deriveSeries(snapshots: MetricsSnapshot[]): DerivedMetrics[] {
  const sorted = sortSnapshots(snapshots);
  return sorted.map((_, i) => derive(sorted.slice(0, i + 1)));
}

function net(s: MetricsSnapshot): number {
  return s.revenueCents - s.cogsCents - (s.platformFeesCents ?? 0) - s.opexCents;
}
