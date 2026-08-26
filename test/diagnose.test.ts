import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { demoBusiness } from '../src/business/demo.ts';
import { diagnose, scoreAgainst, severityOf } from '../src/business/diagnose.ts';
import type { Business, BusinessModel, MetricsSnapshot } from '../src/business/types.ts';

function business(over: Partial<Business> = {}, snapshots: Partial<MetricsSnapshot>[] = [{}]): Business {
  return {
    id: 'b1',
    name: 'Test Co',
    industry: 'testing',
    model: 'services',
    stage: 'early',
    currency: 'USD',
    goals: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    actions: [],
    ...over,
    snapshots: snapshots.map((s, i) => ({
      period: `2026-0${i + 1}`,
      revenueCents: 1_000_000,
      cogsCents: 400_000,
      opexCents: 400_000,
      cashCents: null,
      marketingSpendCents: null,
      newCustomers: null,
      churnedCustomers: null,
      activeCustomers: null,
      headcount: null,
      topCustomerShare: null,
      notes: null,
      ...s,
    })),
  };
}

describe('scoreAgainst', () => {
  it('puts the benchmark itself at 80, leaving room above for genuinely good', () => {
    assert.equal(scoreAgainst(0.5, 0.5, 'higher'), 80);
    assert.equal(scoreAgainst(0.05, 0.05, 'lower'), 80);
  });

  it('caps at 100 rather than rewarding overshoot without limit', () => {
    assert.equal(scoreAgainst(5, 0.5, 'higher'), 100);
    assert.equal(scoreAgainst(50, 0.5, 'higher'), 100);
  });

  it('inverts for lower-is-better measures', () => {
    // Twice the benchmark churn scores the same as half the benchmark margin.
    assert.equal(scoreAgainst(0.1, 0.05, 'lower'), scoreAgainst(0.25, 0.5, 'higher'));
  });

  it('treats zero on a lower-is-better measure as perfect, not as a divide by zero', () => {
    assert.equal(scoreAgainst(0, 0.05, 'lower'), 100);
  });

  it('floors at zero when a value is negative', () => {
    assert.equal(scoreAgainst(-0.2, 0.1, 'higher'), 0);
  });

  it('rejects a benchmark that cannot be divided by', () => {
    assert.throws(() => scoreAgainst(1, 0, 'higher'), /must be positive/);
  });

  it('maps scores to severities at the documented cut-offs', () => {
    assert.equal(severityOf(39), 'critical');
    assert.equal(severityOf(40), 'warning');
    assert.equal(severityOf(69), 'warning');
    assert.equal(severityOf(70), 'ok');
  });
});

describe('diagnose', () => {
  it('judges the same margin differently by business model', () => {
    const snapshots = [{ revenueCents: 1_000_000, cogsCents: 650_000 }]; // 35% gross margin
    const scoreFor = (model: BusinessModel) => {
      const d = diagnose(business({ model }, snapshots));
      return d.pillars
        .find((p) => p.pillar === 'profitability')!
        .findings.find((f) => f.id === 'gross-margin')!;
    };
    assert.equal(scoreFor('retail').severity, 'ok');
    assert.equal(scoreFor('saas').severity, 'critical');
  });

  it('reports what is missing instead of scoring absent inputs as zero', () => {
    const d = diagnose(business());
    const retention = d.pillars.find((p) => p.pillar === 'retention')!;
    assert.equal(retention.score, null, 'retention cannot be scored without customer counts');
    assert.ok(retention.missing.includes('churnedCustomers'));
    assert.ok(d.coverage < 1, 'coverage should fall when pillars are unscored');
    assert.match(d.summary, /% of the checks/);
  });

  it('scores every pillar when the figures are complete', () => {
    const full = business({ model: 'saas', stage: 'growth' }, [
      {
        period: '2026-01',
        revenueCents: 2_000_000,
        activeCustomers: 200,
        cashCents: 20_000_000,
        headcount: 3,
        topCustomerShare: 0.1,
      },
      {
        period: '2026-02',
        revenueCents: 2_200_000,
        cogsCents: 500_000,
        opexCents: 1_300_000,
        cashCents: 20_000_000,
        marketingSpendCents: 300_000,
        newCustomers: 20,
        churnedCustomers: 4,
        activeCustomers: 216,
        headcount: 3,
        topCustomerShare: 0.1,
      },
    ]);
    const d = diagnose(full);
    assert.ok(
      d.pillars.every((p) => p.score !== null),
      `unscored: ${d.pillars.filter((p) => p.score === null).map((p) => p.pillar)}`,
    );
    assert.equal(d.coverage, 1);
    assert.ok(d.overallScore !== null && d.overallScore > 0);
  });

  it('puts cash first when cash is short', () => {
    const burning = business({ model: 'saas' }, [
      { period: '2026-01', revenueCents: 500_000, cogsCents: 200_000, opexCents: 1_500_000, cashCents: 1_000_000 },
      { period: '2026-02', revenueCents: 500_000, cogsCents: 200_000, opexCents: 1_500_000, cashCents: 1_000_000 },
    ]);
    const d = diagnose(burning);
    const runway = d.priorities.find((f) => f.id === 'runway');
    assert.ok(runway, 'expected a runway finding');
    assert.equal(runway.severity, 'critical');
    assert.match(runway.title, /months of cash left/);
    assert.equal(d.priorities[0]?.severity, 'critical');
  });

  it('keeps healthy checks out of the working list', () => {
    const d = diagnose(business({ model: 'retail' }, [{ revenueCents: 1_000_000, cogsCents: 300_000 }]));
    assert.ok(d.priorities.every((f) => f.severity !== 'ok'));
    const all = d.pillars.flatMap((p) => p.findings);
    assert.ok(all.some((f) => f.severity === 'ok'), 'ok findings still belong to their pillar');
  });

  it('gives every finding a pointer that says what to do', () => {
    const d = diagnose(demoBusiness(new Date('2026-08-01T00:00:00Z')));
    const all = d.pillars.flatMap((p) => p.findings);
    assert.ok(all.length >= 8, `expected a full sweep of checks, got ${all.length}`);
    for (const f of all) {
      assert.ok(f.pointer.length > 40, `${f.id} has no usable pointer`);
      assert.ok(f.evidence.length > 0, `${f.id} has no evidence`);
    }
  });

  it('reads the demo business as a growing company in trouble', () => {
    const d = diagnose(demoBusiness(new Date('2026-08-01T00:00:00Z')));
    assert.ok(d.overallScore !== null && d.overallScore < 60, `scored ${d.overallScore}`);
    assert.ok(
      d.priorities.some((f) => f.id === 'runway' && f.severity === 'critical'),
      'the demo should be running out of cash',
    );
    assert.ok(
      d.priorities.some((f) => f.id === 'customer-concentration'),
      'the demo should flag its wholesale account',
    );
  });

  it('refuses to diagnose a business with no figures', () => {
    assert.throws(() => diagnose(business({}, [])), /no monthly figures/);
  });
});
