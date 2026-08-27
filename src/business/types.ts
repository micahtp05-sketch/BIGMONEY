/**
 * The business-management domain. Money is carried in minor units (cents) as
 * integers everywhere, exactly as the pricing pipeline does, so nothing
 * accumulates float drift. Ratios are plain 0..1 fractions, never percentages.
 */

/** Shapes the benchmarks a business is judged against. A 35% gross margin is
 *  healthy for retail and alarming for software — one set of numbers can't
 *  serve both. */
export type BusinessModel =
  | 'saas'
  | 'ecommerce'
  | 'services'
  | 'retail'
  | 'marketplace'
  | 'amazon'
  | 'other';

/** Shapes what "good" growth means. An established business growing 2% a month
 *  is doing well; an early one at 2% is stalling. */
export type BusinessStage = 'idea' | 'pre_revenue' | 'early' | 'growth' | 'established';

export interface Business {
  id: string;
  name: string;
  /** Free text, e.g. "specialty coffee roasting". Used for advice context. */
  industry: string;
  model: BusinessModel;
  stage: BusinessStage;
  /** ISO 4217, e.g. "USD". Display only — all maths is currency-agnostic. */
  currency: string;
  /** What the owner is actually trying to achieve. Steers the briefing. */
  goals: string[];
  createdAt: string;
  updatedAt: string;
  /** One row per calendar month, ascending by period. */
  snapshots: MetricsSnapshot[];
  actions: ActionItem[];
}

/**
 * One month of reality. Every field past `period` and the three P&L lines is
 * nullable on purpose: a diagnosis built from three honest numbers beats one
 * built from twelve guessed ones, so anything missing simply removes the
 * checks that depend on it rather than being defaulted to zero.
 */
export interface MetricsSnapshot {
  /** Calendar month, `YYYY-MM`. Unique within a business. */
  period: string;
  /** Revenue recognised in the month. */
  revenueCents: number;
  /** Direct cost of delivering that revenue — goods, hosting, delivery labour.
   *  For a marketplace seller this is landed product cost only; the platform's
   *  cut goes in `platformFeesCents`. */
  cogsCents: number;
  /**
   * What the marketplace took: referral commission, fulfilment, storage.
   *
   * A separate line rather than part of COGS because it is the number sellers
   * most often leave out of their own margin maths, and separating it is what
   * lets the diagnosis say whether a thin margin is a sourcing problem or a
   * fee problem. It is a cost of sale, so it reduces gross profit either way.
   */
  platformFeesCents: number | null;
  /** Everything else: payroll, rent, marketing, tools. */
  opexCents: number;
  /** Cash on hand at month end. Drives runway. */
  cashCents: number | null;
  /** Sales + marketing spend inside opex. Drives CAC. */
  marketingSpendCents: number | null;
  newCustomers: number | null;
  churnedCustomers: number | null;
  /** Customers active at month end. */
  activeCustomers: number | null;
  /** Full-time-equivalent people, founders included. */
  headcount: number | null;
  /** Share of this month's revenue from the single largest customer, 0..1. */
  topCustomerShare: number | null;

  // ---- Marketplace selling. Null for businesses that don't sell on one. ----

  /** Units shipped in the month. */
  unitsSold: number | null;
  /** Units refunded or returned in the month. */
  unitsReturned: number | null;
  /** Product page sessions — the denominator of the conversion rate. */
  sessions: number | null;
  /**
   * Revenue the marketplace attributed to advertising.
   *
   * Paired with `marketingSpendCents` (total ad spend) this gives ACoS — how
   * the advertised half performs — while spend over total revenue gives TACoS,
   * which is the number that decides whether the business makes money.
   */
  adAttributedSalesCents: number | null;
  /** Units of stock on hand at month end. Drives days of cover. */
  unitsOnHand: number | null;
  /** Share of page views where you held the Buy Box, 0..1. */
  buyBoxShare: number | null;

  notes: string | null;
}

/** Everything computable from one snapshot plus its history. Null means the
 *  inputs weren't there — never a zero standing in for "unknown". */
export interface DerivedMetrics {
  period: string;
  revenueCents: number;
  /** Revenue less product cost **and** marketplace fees. */
  grossProfitCents: number;
  netProfitCents: number;
  grossMargin: number | null;
  netMargin: number | null;
  opexRatio: number | null;
  /** Marketplace fees over revenue. */
  platformFeeRatio: number | null;
  /** Trailing 3-month average net cash burn, 0 when profitable on average. */
  avgBurnCents: number | null;
  /** Cash divided by average burn. Null when not burning or cash unknown. */
  runwayMonths: number | null;
  /** Month-over-month revenue change against the previous period. */
  revenueGrowth: number | null;
  /** Compound monthly growth across the trailing window. */
  avgRevenueGrowth: number | null;
  /** Churned customers over customers active at the start of the month. */
  churnRate: number | null;
  arpuCents: number | null;
  cacCents: number | null;
  /** Gross-margin-weighted lifetime value, from ARPU and churn. */
  ltvCents: number | null;
  ltvToCac: number | null;
  cacPaybackMonths: number | null;
  revenuePerHeadCents: number | null;
  topCustomerShare: number | null;

  // ---- Marketplace selling ----

  /** Ad spend over ad-attributed sales: how the advertised half performs. */
  acos: number | null;
  /** Ad spend over total revenue: what advertising costs the whole business. */
  tacos: number | null;
  /** Units sold over sessions — the listing's conversion rate. */
  unitSessionPercent: number | null;
  /** Units returned over units sold. */
  returnRate: number | null;
  /** Revenue less product cost, fees, and ad spend. What a month actually adds. */
  contributionCents: number | null;
  /** Days of stock left at the current sales rate. */
  daysOfCover: number | null;
  buyBoxShare: number | null;
}

export type PillarId = 'profitability' | 'growth' | 'retention' | 'efficiency' | 'resilience';

export type Severity = 'critical' | 'warning' | 'ok';

/** One judgement about one number, with the move it implies. */
export interface Finding {
  /** Stable across runs, so an action can point back at what caused it. */
  id: string;
  pillar: PillarId;
  severity: Severity;
  /** What is true, in one line. */
  title: string;
  /** The number this rests on, formatted for a human. */
  evidence: string;
  /** What good looks like here, and why that is the bar. */
  benchmark: string | null;
  /** The next concrete move. Not "improve margins" — what to do on Monday. */
  pointer: string;
}

export interface PillarScore {
  pillar: PillarId;
  label: string;
  /** 0..100, or null when the inputs for every check were missing. */
  score: number | null;
  /** Snapshot fields that would unlock more of this pillar. */
  missing: string[];
  findings: Finding[];
}

export interface Diagnosis {
  businessId: string;
  period: string;
  /** 0..100 weighted across the pillars that could be scored. */
  overallScore: number | null;
  /** Share of total pillar weight that had data behind it, 0..1. */
  coverage: number;
  /** One-line read on the overall score. */
  summary: string;
  metrics: DerivedMetrics;
  pillars: PillarScore[];
  /** Every finding, worst first — the working list. */
  priorities: Finding[];
}

export type ActionStatus = 'open' | 'doing' | 'done';

export interface ActionItem {
  id: string;
  title: string;
  detail: string | null;
  status: ActionStatus;
  /** 1 (do it now) .. 3 (when there's room). */
  priority: 1 | 2 | 3;
  /** The finding that prompted it, when it came from a diagnosis. */
  sourceFindingId: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A raw idea plus what the refinery made of it. */
export interface Idea {
  id: string;
  businessId: string | null;
  /** What the user typed, kept verbatim. */
  raw: string;
  createdAt: string;
  review: IdeaReview | null;
}

export interface IdeaReview {
  sharpened: {
    oneLiner: string;
    customer: string;
    problem: string;
    solution: string;
    wedge: string;
  };
  scores: {
    problemClarity: number;
    demandEvidence: number;
    differentiation: number;
    feasibility: number;
    unitEconomics: number;
    timing: number;
  };
  /** Mean of the six scores, 0..10. */
  overall: number;
  verdict: 'promising' | 'needs_work' | 'weak';
  riskiestAssumption: string;
  cheapestTest: {
    test: string;
    timeboxDays: number;
    costEstimate: string;
    killCriterion: string;
  };
  whatWouldMakeThisBig: string;
  nextSteps: string[];
  reviewedAt: string;
}

/** The whole persisted document. One file, read at boot, rewritten on change. */
export interface Workspace {
  version: 1;
  businesses: Business[];
  ideas: Idea[];
}
