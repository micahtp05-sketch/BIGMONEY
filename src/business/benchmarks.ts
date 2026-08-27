import type { BusinessModel, BusinessStage } from './types.ts';

/**
 * What "good" is, per business model. These are the bar every check is scored
 * against, and they exist as one table rather than scattered through the
 * checks so that disagreeing with a number is a one-line change.
 *
 * Sources are the usual published operating ranges for each model; they are
 * deliberately mid-range rather than best-in-class, because the job here is to
 * find what is broken, not to declare everything short of excellent a failure.
 */
export interface Benchmarks {
  /** Gross profit over revenue. */
  grossMargin: number;
  /** Net profit over revenue. */
  netMargin: number;
  /** Operating expenses over revenue. Lower is better. */
  opexRatio: number;
  /** Monthly customer churn. Lower is better. */
  monthlyChurn: number;
  /** Lifetime value over acquisition cost. */
  ltvToCac: number;
  /** Months to earn back acquisition cost. Lower is better. */
  cacPaybackMonths: number;
  /** Monthly revenue per full-time-equivalent person, in cents. */
  revenuePerHeadCents: number;
  /** Months of cash at the current burn. */
  runwayMonths: number;
  /** Share of revenue from the largest single customer. Lower is better. */
  topCustomerShare: number;
}

export const BENCHMARKS: Record<BusinessModel, Benchmarks> = {
  saas: {
    grossMargin: 0.75,
    netMargin: 0.2,
    opexRatio: 0.6,
    monthlyChurn: 0.02,
    ltvToCac: 3,
    cacPaybackMonths: 12,
    revenuePerHeadCents: 1_666_600,
    runwayMonths: 12,
    topCustomerShare: 0.2,
  },
  ecommerce: {
    grossMargin: 0.45,
    netMargin: 0.1,
    opexRatio: 0.35,
    monthlyChurn: 0.07,
    ltvToCac: 3,
    cacPaybackMonths: 6,
    revenuePerHeadCents: 2_500_000,
    runwayMonths: 12,
    topCustomerShare: 0.2,
  },
  services: {
    grossMargin: 0.5,
    netMargin: 0.15,
    opexRatio: 0.35,
    monthlyChurn: 0.03,
    ltvToCac: 3,
    cacPaybackMonths: 6,
    revenuePerHeadCents: 1_250_000,
    runwayMonths: 9,
    topCustomerShare: 0.25,
  },
  retail: {
    grossMargin: 0.35,
    netMargin: 0.05,
    opexRatio: 0.3,
    monthlyChurn: 0.08,
    ltvToCac: 3,
    cacPaybackMonths: 6,
    revenuePerHeadCents: 2_000_000,
    runwayMonths: 9,
    topCustomerShare: 0.2,
  },
  marketplace: {
    grossMargin: 0.7,
    netMargin: 0.15,
    opexRatio: 0.55,
    monthlyChurn: 0.05,
    ltvToCac: 3,
    cacPaybackMonths: 9,
    revenuePerHeadCents: 2_000_000,
    runwayMonths: 12,
    topCustomerShare: 0.2,
  },
  /**
   * A marketplace seller — Amazon FBA or Seller Central, and close enough for
   * eBay or Walmart. Gross margin here is *after* the platform's cut as well
   * as product cost, which is why the bar looks low against ecommerce: a
   * seller clearing 30% on that basis is doing well, and one who measures
   * margin before fees is usually about 30 points more optimistic than the
   * bank account.
   */
  amazon: {
    grossMargin: 0.3,
    netMargin: 0.1,
    opexRatio: 0.2,
    monthlyChurn: 0.07,
    ltvToCac: 3,
    cacPaybackMonths: 6,
    revenuePerHeadCents: 4_000_000,
    // Lower than retail on purpose: the other half of a seller's cash is tied
    // up in stock, and days of cover is what watches that half.
    runwayMonths: 9,
    topCustomerShare: 0.2,
  },
  other: {
    grossMargin: 0.5,
    netMargin: 0.1,
    opexRatio: 0.4,
    monthlyChurn: 0.05,
    ltvToCac: 3,
    cacPaybackMonths: 8,
    revenuePerHeadCents: 1_500_000,
    runwayMonths: 12,
    topCustomerShare: 0.2,
  },
};

/**
 * Expected monthly revenue growth, by stage. Null where the question doesn't
 * apply yet — an idea with no revenue cannot have a growth rate, and scoring
 * one as zero would bury the checks that actually matter at that stage.
 */
export const GROWTH_TARGET: Record<BusinessStage, number | null> = {
  idea: null,
  pre_revenue: null,
  early: 0.1,
  growth: 0.07,
  established: 0.02,
};

/** Human labels for the model, used in advice text. */
export const MODEL_LABEL: Record<BusinessModel, string> = {
  saas: 'a software business',
  ecommerce: 'an ecommerce business',
  services: 'a services business',
  retail: 'a retail business',
  marketplace: 'a marketplace',
  amazon: 'a marketplace seller',
  other: 'a business like this',
};

/**
 * The bars that only exist for a business selling on someone else's
 * marketplace. Kept apart from `BENCHMARKS` because these checks simply do not
 * run for a business without a marketplace, and folding empty columns into the
 * main table would imply they did.
 */
export interface MarketplaceBenchmarks {
  /** Referral + fulfilment + storage over revenue. Lower is better. */
  platformFeeRatio: number;
  /** Total ad spend over total revenue. Lower is better. */
  tacos: number;
  /** Ad spend over ad-attributed sales. Lower is better. */
  acos: number;
  /** Units sold over sessions. Higher is better. */
  unitSessionPercent: number;
  /** Units returned over units sold. Lower is better. */
  returnRate: number;
  /** Share of page views holding the Buy Box. Higher is better. */
  buyBoxShare: number;
  /** Days of stock on hand. Two-sided: too few stocks out, too many ties up
   *  cash and accrues storage fees. */
  daysOfCoverLow: number;
  daysOfCoverHigh: number;
}

export const MARKETPLACE_BENCHMARKS: MarketplaceBenchmarks = {
  // 15% referral on most categories, plus fulfilment and storage.
  platformFeeRatio: 0.3,
  tacos: 0.1,
  acos: 0.25,
  unitSessionPercent: 0.12,
  returnRate: 0.05,
  buyBoxShare: 0.9,
  daysOfCoverLow: 45,
  daysOfCoverHigh: 90,
};

/** Business models that sell through a marketplace and get those checks. */
export function sellsOnMarketplace(model: BusinessModel): boolean {
  return model === 'amazon';
}
