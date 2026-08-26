import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { replyWithError } from '../api-errors.ts';
import { writeBriefing } from './advisor.ts';
import { demoBusiness } from './demo.ts';
import { diagnose } from './diagnose.ts';
import { refineIdea } from './ideas.ts';
import { deriveSeries, sortSnapshots } from './metrics.ts';
import type { WorkspaceStore } from './store.ts';
import type { ActionItem, Business, Idea, MetricsSnapshot } from './types.ts';

const cents = z.number().int().min(0);
const nullableCents = cents.nullable().default(null);
const nullableCount = z.number().int().min(0).nullable().default(null);

const BusinessInput = z.object({
  name: z.string().trim().min(1).max(120),
  industry: z.string().trim().max(200).default(''),
  model: z.enum(['saas', 'ecommerce', 'services', 'retail', 'marketplace', 'other']),
  stage: z.enum(['idea', 'pre_revenue', 'early', 'growth', 'established']),
  // Three-letter ISO code; used only for display formatting.
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  goals: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
});

const SnapshotInput = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be a calendar month, e.g. "2026-03"'),
  revenueCents: cents,
  cogsCents: cents,
  opexCents: cents,
  cashCents: nullableCents,
  marketingSpendCents: nullableCents,
  newCustomers: nullableCount,
  churnedCustomers: nullableCount,
  activeCustomers: nullableCount,
  headcount: z.number().min(0).max(100_000).nullable().default(null),
  topCustomerShare: z.number().min(0).max(1).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});

const ActionInput = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(2000).nullable().default(null),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  sourceFindingId: z.string().trim().max(80).nullable().default(null),
});

const ActionPatch = z
  .object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).nullable(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    status: z.enum(['open', 'doing', 'done']),
  })
  .partial();

const IdeaInput = z.object({
  raw: z.string().trim().min(10, 'Describe the idea in a sentence or two.').max(4000),
  businessId: z.string().trim().nullable().default(null),
});

export interface BusinessRoutesOptions {
  store: WorkspaceStore;
  anthropic: Anthropic;
}

/**
 * Everything under `/api/businesses` and `/api/ideas`.
 *
 * The split that matters: the diagnosis routes are pure computation over
 * stored figures and always work, while the briefing and idea routes call
 * Claude and can fail. Keeping them on separate endpoints means an expired API
 * key costs you the advice, not the dashboard.
 */
export function registerBusinessRoutes(app: FastifyInstance, opts: BusinessRoutesOptions): void {
  const { store, anthropic } = opts;

  const find = (id: string): Business | undefined =>
    store.read().businesses.find((b) => b.id === id);

  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ error: `No ${what} with that id.` });

  app.get('/api/businesses', async () => ({
    businesses: store.read().businesses.map(summarise),
  }));

  app.post('/api/businesses', async (request, reply) => {
    const parsed = BusinessInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const now = new Date().toISOString();
    const business: Business = {
      id: randomUUID(),
      ...parsed.data,
      createdAt: now,
      updatedAt: now,
      snapshots: [],
      actions: [],
    };
    await store.mutate((ws) => ws.businesses.push(business));
    return reply.code(201).send({ business });
  });

  app.get('/api/businesses/:id', async (request, reply) => {
    const business = find((request.params as { id: string }).id);
    if (!business) return notFound(reply, 'business');
    return reply.send({ business });
  });

  app.patch('/api/businesses/:id', async (request, reply) => {
    const business = find((request.params as { id: string }).id);
    if (!business) return notFound(reply, 'business');

    const parsed = BusinessInput.partial().safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    await store.mutate(() => {
      Object.assign(business, parsed.data, { updatedAt: new Date().toISOString() });
    });
    return reply.send({ business });
  });

  app.delete('/api/businesses/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!find(id)) return notFound(reply, 'business');
    await store.mutate((ws) => {
      ws.businesses = ws.businesses.filter((b) => b.id !== id);
      // Ideas keep their text but lose the link, rather than disappearing with
      // the business they were filed under.
      for (const idea of ws.ideas) if (idea.businessId === id) idea.businessId = null;
    });
    return reply.send({ ok: true });
  });

  /** Upsert one month. PUT because re-submitting a period replaces it — owners
   *  correct last month's figures far more often than they add new ones. */
  app.put('/api/businesses/:id/snapshots', async (request, reply) => {
    const business = find((request.params as { id: string }).id);
    if (!business) return notFound(reply, 'business');

    const parsed = SnapshotInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const snapshot: MetricsSnapshot = parsed.data;

    await store.mutate(() => {
      const existing = business.snapshots.findIndex((s) => s.period === snapshot.period);
      if (existing >= 0) business.snapshots[existing] = snapshot;
      else business.snapshots.push(snapshot);
      business.snapshots = sortSnapshots(business.snapshots);
      business.updatedAt = new Date().toISOString();
    });
    return reply.send({ business });
  });

  app.delete('/api/businesses/:id/snapshots/:period', async (request, reply) => {
    const params = request.params as { id: string; period: string };
    const business = find(params.id);
    if (!business) return notFound(reply, 'business');
    if (!business.snapshots.some((s) => s.period === params.period)) {
      return notFound(reply, 'month');
    }
    await store.mutate(() => {
      business.snapshots = business.snapshots.filter((s) => s.period !== params.period);
      business.updatedAt = new Date().toISOString();
    });
    return reply.send({ business });
  });

  app.get('/api/businesses/:id/diagnosis', async (request, reply) => {
    const business = find((request.params as { id: string }).id);
    if (!business) return notFound(reply, 'business');
    if (business.snapshots.length === 0) {
      return reply.code(409).send({
        error: 'Add at least one month of figures before running a diagnosis.',
      });
    }
    return reply.send({
      diagnosis: diagnose(business),
      series: deriveSeries(business.snapshots),
    });
  });

  app.post('/api/businesses/:id/briefing', async (request, reply) => {
    const business = find((request.params as { id: string }).id);
    if (!business) return notFound(reply, 'business');
    if (business.snapshots.length === 0) {
      return reply.code(409).send({
        error: 'Add at least one month of figures before asking for a briefing.',
      });
    }
    try {
      const diagnosis = diagnose(business);
      const briefing = await writeBriefing(anthropic, { business, diagnosis });
      return reply.send({ briefing, diagnosis });
    } catch (error) {
      return replyWithError(request, reply, error, 'briefing');
    }
  });

  app.post('/api/businesses/:id/actions', async (request, reply) => {
    const business = find((request.params as { id: string }).id);
    if (!business) return notFound(reply, 'business');

    const parsed = ActionInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const action: ActionItem = {
      id: randomUUID(),
      ...parsed.data,
      status: 'open',
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await store.mutate(() => {
      business.actions.push(action);
      business.updatedAt = new Date().toISOString();
    });
    return reply.code(201).send({ action });
  });

  app.patch('/api/businesses/:id/actions/:actionId', async (request, reply) => {
    const params = request.params as { id: string; actionId: string };
    const business = find(params.id);
    if (!business) return notFound(reply, 'business');
    const action = business.actions.find((a) => a.id === params.actionId);
    if (!action) return notFound(reply, 'action');

    const parsed = ActionPatch.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    await store.mutate(() => {
      Object.assign(action, parsed.data);
      if (parsed.data.status !== undefined) {
        action.completedAt = parsed.data.status === 'done' ? new Date().toISOString() : null;
      }
      business.updatedAt = new Date().toISOString();
    });
    return reply.send({ action });
  });

  app.delete('/api/businesses/:id/actions/:actionId', async (request, reply) => {
    const params = request.params as { id: string; actionId: string };
    const business = find(params.id);
    if (!business) return notFound(reply, 'business');
    if (!business.actions.some((a) => a.id === params.actionId)) return notFound(reply, 'action');
    await store.mutate(() => {
      business.actions = business.actions.filter((a) => a.id !== params.actionId);
      business.updatedAt = new Date().toISOString();
    });
    return reply.send({ ok: true });
  });

  app.get('/api/ideas', async () => ({ ideas: store.read().ideas }));

  app.post('/api/ideas', async (request, reply) => {
    const parsed = IdeaInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const business = parsed.data.businessId ? (find(parsed.data.businessId) ?? null) : null;
    if (parsed.data.businessId && !business) return notFound(reply, 'business');

    try {
      const review = await refineIdea(anthropic, { raw: parsed.data.raw, business });
      const idea: Idea = {
        id: randomUUID(),
        businessId: business?.id ?? null,
        raw: parsed.data.raw,
        createdAt: new Date().toISOString(),
        review,
      };
      await store.mutate((ws) => ws.ideas.unshift(idea));
      return reply.code(201).send({ idea });
    } catch (error) {
      return replyWithError(request, reply, error, 'idea review');
    }
  });

  app.delete('/api/ideas/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!store.read().ideas.some((i) => i.id === id)) return notFound(reply, 'idea');
    await store.mutate((ws) => {
      ws.ideas = ws.ideas.filter((i) => i.id !== id);
    });
    return reply.send({ ok: true });
  });

  /** Seed a worked example so the dashboard can be judged before anyone types
   *  a year of their own figures into it. */
  app.post('/api/demo', async (_request, reply) => {
    const business = demoBusiness();
    await store.mutate((ws) => ws.businesses.push(business));
    return reply.code(201).send({ business });
  });
}

/** The list view needs a score, not a whole history. */
function summarise(business: Business) {
  const scored = business.snapshots.length > 0 ? diagnose(business) : null;
  return {
    id: business.id,
    name: business.name,
    industry: business.industry,
    model: business.model,
    stage: business.stage,
    currency: business.currency,
    months: business.snapshots.length,
    latestPeriod: business.snapshots.at(-1)?.period ?? null,
    overallScore: scored?.overallScore ?? null,
    openActions: business.actions.filter((a) => a.status !== 'done').length,
  };
}

function badRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: 'Invalid request.',
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}
