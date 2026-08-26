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
  other: 'a business like this',
};
