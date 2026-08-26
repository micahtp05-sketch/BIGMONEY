import { BENCHMARKS, GROWTH_TARGET, MODEL_LABEL } from './benchmarks.ts';
import { derive } from './metrics.ts';
import type {
  Business,
  DerivedMetrics,
  Diagnosis,
  Finding,
  PillarId,
  PillarScore,
  Severity,
} from './types.ts';

const PILLAR_WEIGHT: Record<PillarId, number> = {
  profitability: 0.25,
  growth: 0.2,
  retention: 0.2,
  efficiency: 0.15,
  resilience: 0.2,
};

const PILLAR_LABEL: Record<PillarId, string> = {
  profitability: 'Profitability',
  growth: 'Growth',
  retention: 'Retention & acquisition',
  efficiency: 'Operating efficiency',
  resilience: 'Resilience',
};

const PILLAR_ORDER: PillarId[] = [
  'profitability',
  'growth',
  'retention',
  'efficiency',
  'resilience',
];

/**
 * Score one number against its benchmark, 0..100.
 *
 * Everything is judged on the *ratio* to the bar rather than the raw value, so
 * one curve serves margins, churn, and runway alike, and changing a benchmark
 * changes every score that depends on it consistently. The curve is
 * deliberately generous below the bar and flat above it: the point is to rank
 * what needs attention, not to award medals for overshooting.
 */
export function scoreAgainst(
  value: number,
  target: number,
  direction: 'higher' | 'lower',
): number {
  if (target <= 0) throw new Error('benchmark target must be positive');
  let ratio: number;
  if (direction === 'higher') {
    ratio = value / target;
  } else {
    // Lower-is-better: at or below zero is as good as it gets (no churn, no
    // overhead), and dividing by it would blow up.
    if (value <= 0) return 100;
    ratio = target / value;
  }
  return Math.round(curve(Math.max(0, ratio)));
}

/** Piecewise-linear ratio -> score. 1.0 (exactly at benchmark) scores 80. */
function curve(ratio: number): number {
  const points: [number, number][] = [
    [0, 0],
    [0.4, 25],
    [0.7, 50],
    [0.9, 70],
    [1, 80],
    [1.3, 92],
    [2, 100],
  ];
  const last = points.at(-1)!;
  if (ratio >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (ratio <= x1) return y0 + ((ratio - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

export function severityOf(score: number): Severity {
  if (score < 40) return 'critical';
  if (score < 70) return 'warning';
  return 'ok';
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };

/**
 * The full read on a business: every ratio scored against the benchmarks for
 * its model and stage, each one carrying the move it implies.
 *
 * Checks whose inputs are missing are dropped, not defaulted — the pillar
 * reports what it would need instead of scoring a guess. That is why
 * `coverage` exists: a 90 built from two numbers is not the same claim as a 90
 * built from ten, and the caller is told which one it is looking at.
 */
export function diagnose(business: Business): Diagnosis {
  if (business.snapshots.length === 0) {
    throw new Error('Cannot diagnose a business with no monthly figures.');
  }

  const bm = BENCHMARKS[business.model];
  const m = derive(business.snapshots);
  const money = moneyFormatter(business.currency);
  const modelLabel = MODEL_LABEL[business.model];

  const findings: Finding[] = [];
  const scores = new Map<PillarId, number[]>(PILLAR_ORDER.map((p) => [p, []]));
  const missing = new Map<PillarId, Set<string>>(PILLAR_ORDER.map((p) => [p, new Set()]));

  function assess(
    spec: {
      id: string;
      pillar: PillarId;
      value: number | null;
      target: number;
      direction: 'higher' | 'lower';
      requires: string[];
    },
    describe: (
      value: number,
      severity: Severity,
    ) => { title: string; evidence: string; benchmark: string; pointer: string },
  ): void {
    if (spec.value === null || !Number.isFinite(spec.value)) {
      for (const field of spec.requires) missing.get(spec.pillar)!.add(field);
      return;
    }
    const score = scoreAgainst(spec.value, spec.target, spec.direction);
    const severity = severityOf(score);
    scores.get(spec.pillar)!.push(score);
    const d = describe(spec.value, severity);
    findings.push({ id: spec.id, pillar: spec.pillar, severity, ...d });
  }

  // ---- Profitability ------------------------------------------------------

  assess(
    {
      id: 'gross-margin',
      pillar: 'profitability',
      value: m.grossMargin,
      target: bm.grossMargin,
      direction: 'higher',
      requires: ['revenueCents', 'cogsCents'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `Gross margin of ${pct(v)} clears the bar for ${modelLabel}`
          : `Gross margin of ${pct(v)} is below the ${pct(bm.grossMargin)} ${modelLabel} needs`,
      evidence: `${money(m.grossProfitCents)} gross profit on ${money(m.revenueCents)} revenue in ${m.period}.`,
      benchmark: `${pct(bm.grossMargin)} typical for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `Every sale is barely paying for itself, so selling more makes the hole deeper. Take one typical order and write down every cost that dies with it — materials, payment fees, delivery, the hours spent fulfilling it. What's left is all you have to run the company on. Fix the largest line or raise the price on that one order type before spending anything on growth.`,
        warning: `Rank your products or customers by gross profit per unit, not by revenue. The gap almost always lives in the bottom fifth — the discounted account, the custom order, the loss-leader nobody re-priced. Re-price or retire that fifth and the margin moves without a single new customer.`,
        ok: `Margin is healthy — protect it. Re-check it any month COGS or discounts move: margin rarely collapses, it erodes one concession at a time.`,
      }),
    }),
  );

  assess(
    {
      id: 'net-margin',
      pillar: 'profitability',
      value: m.netMargin,
      target: bm.netMargin,
      direction: 'higher',
      requires: ['revenueCents', 'cogsCents', 'opexCents'],
    },
    (v, sev) => ({
      title:
        v < 0
          ? `Losing ${money(Math.abs(m.netProfitCents))} a month at the bottom line`
          : sev === 'ok'
            ? `Net margin of ${pct(v)} is where it should be`
            : `Net margin of ${pct(v)} is thin for ${modelLabel}`,
      evidence: `${money(m.netProfitCents)} net on ${money(m.revenueCents)} revenue after ${money(business.snapshots.at(-1)!.opexCents)} of operating costs.`,
      benchmark: `${pct(bm.netMargin)} typical for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `Sort last month's operating costs largest to smallest and challenge the top five against what they returned. The gap is almost never spread evenly — it sits in two or three lines. For each: what breaks if this stops for 90 days? Anything with no answer is the first cut.`,
        warning: `A thin bottom line survives good months and not bad ones. Pick one lever and move it 5%: price, COGS, or overhead. A 5% price rise carries straight to the bottom line; a 5% cost cut is worth the same and takes longer.`,
        ok: `You're keeping a real share of what you sell. Decide deliberately how much of this profit gets reinvested rather than letting costs quietly absorb it.`,
      }),
    }),
  );

  // ---- Growth -------------------------------------------------------------

  const growthTarget = GROWTH_TARGET[business.stage];
  if (growthTarget === null) {
    missing.get('growth')!.add('revenue in a later stage');
  } else {
    assess(
      {
        id: 'revenue-growth',
        pillar: 'growth',
        value: m.avgRevenueGrowth,
        target: growthTarget,
        direction: 'higher',
        requires: ['two or more months of revenueCents'],
      },
      (v, sev) => ({
        title:
          v <= 0
            ? `Revenue is ${v === 0 ? 'flat' : 'falling'} at ${pct(v)} a month`
            : sev === 'ok'
              ? `Growing ${pct(v)} a month, on pace for this stage`
              : `Growing ${pct(v)} a month, under the ${pct(growthTarget)} this stage needs`,
        evidence: `Compound monthly change across the last ${Math.min(business.snapshots.length, 4)} months, ending ${m.period}.`,
        benchmark: `~${pct(growthTarget)} a month at the ${business.stage.replace('_', '-')} stage.`,
        pointer: pick(sev, {
          critical: `Growth stalls for exactly one of three reasons: not enough people hear about you, enough hear but don't buy, or they buy once and don't come back. Measure all three this week — leads or traffic, conversion rate, repeat rate — and compare each to three months ago. One of them moved. Fix that one instead of doing a bit of everything.`,
          warning: `Find the single channel that produced the most customers last month and ask what stops you from doing twice as much of it. Usually the answer is a specific constraint — budget, time, one person's calendar — and naming it is most of the work.`,
          ok: `On pace. The risk now is concentration: if most of this came from one channel, one algorithm change takes the whole number with it. Start a second channel while you don't need it.`,
        }),
      }),
    );
  }

  // ---- Retention & acquisition -------------------------------------------

  assess(
    {
      id: 'churn',
      pillar: 'retention',
      value: m.churnRate,
      target: bm.monthlyChurn,
      direction: 'lower',
      requires: ['churnedCustomers', 'activeCustomers'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `Churn of ${pct(v)} a month is under control`
          : `Losing ${pct(v)} of customers every month`,
      evidence:
        v > 0
          ? `At that rate the average customer stays about ${(1 / v).toFixed(1)} months.`
          : `No customers lost in ${m.period}.`,
      benchmark: `${pct(bm.monthlyChurn)} a month typical for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `This is the most expensive number on the page — it silently divides everything acquisition earns you. Call ten customers who left and ask what happened in the week before they went. Churn causes cluster hard; the first few calls usually tell you the whole story, and it is rarely price.`,
        warning: `Split churn by how customers arrived and how long they stayed. Early churn is an onboarding or expectation-setting problem; late churn is a value problem. They have opposite fixes, and averaging them hides which one you have.`,
        ok: `Retention is doing its job — it is what makes acquisition spend compound. Keep watching it by cohort, since a healthy average can hide one bad intake month.`,
      }),
    }),
  );

  assess(
    {
      id: 'ltv-to-cac',
      pillar: 'retention',
      value: m.ltvToCac,
      target: bm.ltvToCac,
      direction: 'higher',
      requires: ['marketingSpendCents', 'newCustomers', 'churnedCustomers', 'activeCustomers'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `Each ${money(m.cacCents ?? 0)} of acquisition returns ${v.toFixed(1)}x`
          : `Paying ${money(m.cacCents ?? 0)} to win a customer worth ${money(m.ltvCents ?? 0)}`,
      evidence: `LTV ${money(m.ltvCents ?? 0)} against CAC ${money(m.cacCents ?? 0)} — a ratio of ${v.toFixed(1)}x.`,
      benchmark: `${bm.ltvToCac}x or better; below 1x you are buying revenue at a loss.`,
      pointer: pick(sev, {
        critical: `You are paying more for customers than they return, so more acquisition spend makes the position worse, not better. Stop the worst-performing channel this week — not reduce it, stop it — and see what actually happens to new customers. Very often most of the spend was buying people who would have found you anyway.`,
        warning: `The ratio moves from either end, and the retention end is cheaper: a small drop in churn raises LTV for every future customer at no extra spend, while cutting CAC usually costs volume.`,
        ok: `The economics work, which means spending more is a reasonable move. Scale the channel in steps and re-check this ratio each time — CAC almost always rises as volume does.`,
      }),
    }),
  );

  assess(
    {
      id: 'cac-payback',
      pillar: 'retention',
      value: m.cacPaybackMonths,
      target: bm.cacPaybackMonths,
      direction: 'lower',
      requires: ['marketingSpendCents', 'newCustomers', 'activeCustomers'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `Acquisition cost pays back in ${v.toFixed(1)} months`
          : `Takes ${v.toFixed(1)} months to earn back what a customer costs to win`,
      evidence: `${money(m.cacCents ?? 0)} CAC against ${money((m.arpuCents ?? 0) * (m.grossMargin ?? 0))} of gross profit per customer per month.`,
      benchmark: `Under ${bm.cacPaybackMonths} months for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `Long payback is a cash problem before it is a profit problem: every new customer digs the hole deeper before filling it, so growth and cash run in opposite directions. Ask for more money up front — annual terms, a deposit, a setup fee. Shortening payback beats raising the lifetime number here.`,
        warning: `Payback is the speed limit on how fast you can grow without outside money. Shorten it with up-front terms or a higher first purchase, and the same cash funds more customers per year.`,
        ok: `Fast payback means growth funds itself. That is the condition under which spending harder on acquisition is a decision rather than a gamble.`,
      }),
    }),
  );

  // ---- Operating efficiency ----------------------------------------------

  assess(
    {
      id: 'opex-ratio',
      pillar: 'efficiency',
      value: m.opexRatio,
      target: bm.opexRatio,
      direction: 'lower',
      requires: ['revenueCents', 'opexCents'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `Overheads take ${pct(v)} of revenue, in line for ${modelLabel}`
          : `Overheads take ${pct(v)} of every unit of revenue`,
      evidence: `${money(business.snapshots.at(-1)!.opexCents)} of operating cost against ${money(m.revenueCents)} of revenue.`,
      benchmark: `~${pct(bm.opexRatio)} for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `This is an overhead problem, not a pricing one — the fix lives in your cost base. List every recurring commitment with its monthly cost and the last date it earned its keep. Subscriptions, tooling, and space are where this usually hides, and none of them announce themselves.`,
        warning: `Overheads are heavy but not fatal. Set a rule before the next hire or tool: it either replaces a cost or it produces revenue you can name. Overhead creeps in through decisions that each looked small.`,
        ok: `Your cost base is proportionate to what you sell. The thing to preserve is that ratio as you grow — costs added at scale are much harder to remove later.`,
      }),
    }),
  );

  assess(
    {
      id: 'revenue-per-head',
      pillar: 'efficiency',
      value: m.revenuePerHeadCents,
      target: bm.revenuePerHeadCents,
      direction: 'higher',
      requires: ['headcount'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `${money(v)} of monthly revenue per person`
          : `${money(v)} of revenue per person per month is light for ${modelLabel}`,
      evidence: `${money(m.revenueCents)} across ${business.snapshots.at(-1)!.headcount} full-time-equivalent people.`,
      benchmark: `~${money(bm.revenuePerHeadCents)} per person per month for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `Either the team is doing work that doesn't reach a customer, or the price of what they produce is too low. Track one week of where the hours actually go, bucketed by whether a customer would pay for that hour. The answer is usually uncomfortable and immediately actionable.`,
        warning: `Before the next hire, find the largest block of repeated manual work and remove it — automate, template, or drop it. Output per person moves further on that than on headcount.`,
        ok: `Output per person is healthy, which is what makes hiring safe. Keep the measure visible as the team grows; it is the first thing to slip.`,
      }),
    }),
  );

  // ---- Resilience ---------------------------------------------------------

  const cashCents = business.snapshots.at(-1)!.cashCents;
  if (m.avgBurnCents === 0 && cashCents !== null) {
    // Not burning: runway is undefined rather than infinite, and scoring it
    // against a months-of-cash benchmark would be meaningless.
    scores.get('resilience')!.push(100);
    findings.push({
      id: 'runway',
      pillar: 'resilience',
      severity: 'ok',
      title: 'Operating cash-positive — no runway clock running',
      evidence: `${money(cashCents)} in the bank and the trailing three months average a profit.`,
      benchmark: `${bm.runwayMonths} months of cash is the bar when burning.`,
      pointer: `The scarce resource here is attention, not cash. Decide now what this profit is for — reserve, reinvestment, or owner income — because undirected profit gets absorbed by whatever asks loudest.`,
    });
  } else {
    assess(
      {
        id: 'runway',
        pillar: 'resilience',
        value: m.runwayMonths,
        target: bm.runwayMonths,
        direction: 'higher',
        requires: ['cashCents'],
      },
      (v, sev) => ({
        title:
          v < 3
            ? `${v.toFixed(1)} months of cash left — this is the constraint on everything else`
            : sev === 'ok'
              ? `${v.toFixed(1)} months of runway`
              : `${v.toFixed(1)} months of runway is short for ${modelLabel}`,
        evidence: `${money(cashCents ?? 0)} in the bank against ${money(m.avgBurnCents ?? 0)} of average monthly burn.`,
        benchmark: `${bm.runwayMonths}+ months.`,
        pointer: pick(sev, {
          critical:
            v < 3
              ? `Below three months, cash decides everything and every other item on this page waits. Do three things this week: chase every unpaid invoice personally, delay every payment that can be delayed without breaking a relationship, and write the specific list of cuts that buys three more months. Deciding the cuts now, while you can choose them, is worth more than making them later under pressure.`
              : `You have about ${Math.floor(v)} months before cash makes your decisions for you, and that is not enough time for a plan that depends on revenue arriving. Write the specific list of cuts that would buy six months and put a date on when you would trigger it — choosing cuts calmly now beats making them under pressure later. Then work the two levers that move fastest: unpaid invoices in, and the largest discretionary cost out.`,
          warning: `Under a full cycle of cash means a bad quarter and a fundraise or a big cut arrive together. Model the month you run out at today's burn and put a decision date two months before it — a date, in the calendar, not a feeling.`,
          ok: `Runway is adequate. Re-forecast it whenever burn moves more than 20%, and remember it shortens fastest right after a hire.`,
        }),
      }),
    );
  }

  assess(
    {
      id: 'customer-concentration',
      pillar: 'resilience',
      value: m.topCustomerShare,
      target: bm.topCustomerShare,
      direction: 'lower',
      requires: ['topCustomerShare'],
    },
    (v, sev) => ({
      title:
        sev === 'ok'
          ? `Largest customer is ${pct(v)} of revenue`
          : `One customer is ${pct(v)} of your revenue`,
      evidence: `Losing them removes ${money(m.revenueCents * v)} a month.`,
      benchmark: `Under ${pct(bm.topCustomerShare)} for ${modelLabel}.`,
      pointer: pick(sev, {
        critical: `At this share they are not a customer, they are your board — and a renewal conversation is an existential event. Two moves, in this order: find out when their next renewal or budget decision lands, and put a specific revenue target on second-largest accounts for the next two quarters. Diversifying takes longer than a notice period, which is why it has to start before you feel it.`,
        warning: `One account this size sets your pricing and priorities whether or not you intend it. Track the share monthly and treat a rise as a growth failure elsewhere, not a win here.`,
        ok: `Revenue is spread widely enough that no single loss is existential. That is what lets you say no to bad terms.`,
      }),
    }),
  );

  // ---- Roll up ------------------------------------------------------------

  const pillars: PillarScore[] = PILLAR_ORDER.map((pillar) => {
    const list = scores.get(pillar)!;
    return {
      pillar,
      label: PILLAR_LABEL[pillar],
      score: list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null,
      missing: [...missing.get(pillar)!],
      findings: findings
        .filter((f) => f.pillar === pillar)
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    };
  });

  // Weights are renormalised over the pillars that could be scored, so a
  // missing pillar lowers coverage instead of quietly scoring zero.
  const scored = pillars.filter((p) => p.score !== null);
  const totalWeight = scored.reduce((sum, p) => sum + PILLAR_WEIGHT[p.pillar], 0);
  const overallScore =
    totalWeight > 0
      ? Math.round(
          scored.reduce((sum, p) => sum + p.score! * PILLAR_WEIGHT[p.pillar], 0) / totalWeight,
        )
      : null;

  const priorities = findings
    .filter((f) => f.severity !== 'ok')
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        PILLAR_WEIGHT[b.pillar] - PILLAR_WEIGHT[a.pillar],
    );

  return {
    businessId: business.id,
    period: m.period,
    overallScore,
    coverage: totalWeight,
    summary: summarise(overallScore, totalWeight, priorities, modelLabel),
    metrics: m,
    pillars,
    priorities,
  };
}

function summarise(
  score: number | null,
  coverage: number,
  priorities: Finding[],
  modelLabel: string,
): string {
  if (score === null) {
    return 'Not enough figures yet to score anything. Add a month of revenue, cost of sales, and operating costs and the picture fills in immediately.';
  }
  const criticals = priorities.filter((f) => f.severity === 'critical').length;
  const base =
    score >= 80
      ? 'Strong. The fundamentals hold, so the work now is compounding what already works rather than repair.'
      : score >= 60
        ? 'Sound, with specific weak spots. Nothing here is fatal, and two or three fixes move the whole number.'
        : score >= 40
          ? `Under strain. Several core ratios sit below what ${modelLabel} needs, and they interact — fixing the worst one usually lifts the others.`
          : 'Fragile. Enough of the core ratios are broken that growth would amplify the problem rather than solve it. Fix the critical items before adding volume.';
  const urgency =
    criticals > 0
      ? ` ${criticals} item${criticals === 1 ? '' : 's'} need${criticals === 1 ? 's' : ''} attention now.`
      : '';
  const gap =
    coverage < 0.7
      ? ` This is based on ${Math.round(coverage * 100)}% of the checks — filling the missing figures would sharpen it.`
      : '';
  return base + urgency + gap;
}

function pick(severity: Severity, options: Record<Severity, string>): string {
  return options[severity];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.1 ? 1 : 0)}%`;
}

function moneyFormatter(currency: string): (cents: number) => string {
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
  return (cents: number) => fmt.format(Math.round(cents) / 100);
}

export { PILLAR_LABEL, PILLAR_WEIGHT };
export type { DerivedMetrics };
