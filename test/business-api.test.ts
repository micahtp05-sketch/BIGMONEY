import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The Anthropic client is constructed at boot even though these tests never
// reach a Claude-backed route, so it needs credentials shaped like credentials.
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
process.env.LOG_LEVEL = 'silent';

const { WorkspaceStore } = await import('../src/business/store.ts');
type Store = Awaited<ReturnType<typeof WorkspaceStore.open>>;
const { buildServer } = await import('../src/server.ts');

type App = Awaited<ReturnType<typeof buildServer>>;

/**
 * The business half of the API end to end, against a real store in a temp
 * directory. Everything here is deterministic — the Claude-backed briefing and
 * idea routes are the only ones left out, since they cannot run offline.
 */
describe('business API', () => {
  let app: App;
  let store: Store;

  before(async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'bigmoney-api-')), 'workspace.json');
    store = await WorkspaceStore.open(path);
    app = await buildServer({ store });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/businesses',
      payload: {
        name: 'Acme Roasters',
        industry: 'coffee',
        model: 'ecommerce',
        stage: 'early',
        currency: 'usd',
        goals: ['Break even'],
        ...over,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().business as { id: string; currency: string };
  };

  const putMonth = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/businesses/${id}/snapshots`, payload });

  it('creates a business, normalising the currency code', async () => {
    const business = await create();
    assert.equal(business.currency, 'USD');

    const list = await app.inject({ method: 'GET', url: '/api/businesses' });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().businesses.some((b: { id: string }) => b.id === business.id));
  });

  it('rejects a malformed business with the offending fields named', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/businesses',
      payload: { name: '', model: 'crypto', stage: 'early' },
    });
    assert.equal(res.statusCode, 400);
    const paths = res.json().issues.map((i: { path: string }) => i.path);
    assert.deepEqual(paths.sort(), ['model', 'name']);
  });

  it('replaces a month when the same period is submitted again', async () => {
    const business = await create();
    await putMonth(business.id, { period: '2026-02', revenueCents: 100, cogsCents: 40, opexCents: 30 });
    await putMonth(business.id, { period: '2026-01', revenueCents: 90, cogsCents: 30, opexCents: 20 });
    const res = await putMonth(business.id, {
      period: '2026-02',
      revenueCents: 250,
      cogsCents: 40,
      opexCents: 30,
    });

    const snapshots = res.json().business.snapshots as { period: string; revenueCents: number }[];
    assert.deepEqual(
      snapshots.map((s) => s.period),
      ['2026-01', '2026-02'],
      'months are stored oldest first regardless of entry order',
    );
    assert.equal(snapshots[1]?.revenueCents, 250, 'the corrected figure replaced the original');
  });

  it('rejects a period that is not a calendar month', async () => {
    const business = await create();
    const res = await putMonth(business.id, {
      period: 'last quarter',
      revenueCents: 1,
      cogsCents: 1,
      opexCents: 1,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().issues[0].message, /calendar month/);
  });

  it('will not diagnose a business with no figures, and says why', async () => {
    const business = await create();
    const res = await app.inject({ method: 'GET', url: `/api/businesses/${business.id}/diagnosis` });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /at least one month/);
  });

  it('diagnoses a business and returns the series behind it', async () => {
    const business = await create();
    await putMonth(business.id, {
      period: '2026-01',
      revenueCents: 1_000_000,
      cogsCents: 700_000,
      opexCents: 500_000,
      cashCents: 400_000,
    });
    await putMonth(business.id, {
      period: '2026-02',
      revenueCents: 1_050_000,
      cogsCents: 730_000,
      opexCents: 500_000,
      cashCents: 200_000,
    });

    const res = await app.inject({ method: 'GET', url: `/api/businesses/${business.id}/diagnosis` });
    assert.equal(res.statusCode, 200);
    const { diagnosis, series } = res.json();
    assert.equal(diagnosis.period, '2026-02');
    assert.equal(series.length, 2);
    assert.ok(diagnosis.overallScore !== null);
    assert.ok(diagnosis.priorities.length > 0, 'a business burning cash should have priorities');
    assert.ok(diagnosis.priorities.every((f: { pointer: string }) => f.pointer.length > 0));
  });

  it('tracks an action through to done and back off the open list', async () => {
    const business = await create();
    const created = await app.inject({
      method: 'POST',
      url: `/api/businesses/${business.id}/actions`,
      payload: { title: 'Call the ten customers who left', priority: 1, sourceFindingId: 'churn' },
    });
    assert.equal(created.statusCode, 201);
    const action = created.json().action;
    assert.equal(action.status, 'open');

    const done = await app.inject({
      method: 'PATCH',
      url: `/api/businesses/${business.id}/actions/${action.id}`,
      payload: { status: 'done' },
    });
    assert.equal(done.json().action.completedAt !== null, true);

    const reopened = await app.inject({
      method: 'PATCH',
      url: `/api/businesses/${business.id}/actions/${action.id}`,
      payload: { status: 'doing' },
    });
    assert.equal(reopened.json().action.completedAt, null, 'reopening clears the completion time');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/businesses/${business.id}/actions/${action.id}`,
    });
    assert.equal(removed.statusCode, 200);
    const business2 = await app.inject({ method: 'GET', url: `/api/businesses/${business.id}` });
    assert.equal(business2.json().business.actions.length, 0);
  });

  it('seeds a demo business that diagnoses cleanly', async () => {
    const seeded = await app.inject({ method: 'POST', url: '/api/demo' });
    assert.equal(seeded.statusCode, 201);
    const id = seeded.json().business.id;

    const res = await app.inject({ method: 'GET', url: `/api/businesses/${id}/diagnosis` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().series.length, 8);
    assert.ok(res.json().diagnosis.priorities.length >= 3);
  });

  it('answers 404 for ids that do not exist', async () => {
    for (const url of ['/api/businesses/nope', '/api/businesses/nope/diagnosis']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
    }
  });

  it('unlinks ideas from a deleted business instead of deleting them too', async () => {
    const business = await create();
    // Ideas normally arrive through Claude; insert one directly so the unlink
    // behaviour can be tested without a network call.
    await store.mutate((ws) =>
      ws.ideas.push({
        id: 'idea-1',
        businessId: business.id,
        raw: 'Sell subscriptions to offices',
        createdAt: new Date().toISOString(),
        review: null,
      }),
    );

    const res = await app.inject({ method: 'DELETE', url: `/api/businesses/${business.id}` });
    assert.equal(res.statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/businesses/${business.id}` })).statusCode,
      404,
    );

    const ideas = (await app.inject({ method: 'GET', url: '/api/ideas' })).json().ideas;
    const kept = ideas.find((i: { id: string }) => i.id === 'idea-1');
    assert.ok(kept, 'the idea survived its business');
    assert.equal(kept.businessId, null);
  });

  it('serves the dashboard at a URL a person would type', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
  });
});
