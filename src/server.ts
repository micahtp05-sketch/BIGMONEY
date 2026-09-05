import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { aggregate } from './aggregate.ts';
import { communityRoutes } from './community/routes.ts';
import { pushFromEnv } from './community/push.ts';
import { sendersFromEnv } from './community/senders/index.ts';
import { gatherListings, sourcesFromEnv } from './sources/index.ts';
import type { EstimateResponse } from './types.ts';
import { RefusalError, identifyItem } from './vision.ts';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Where Commons persists. Set COMMUNITY_DATA=:memory: to run without a file. */
function communityDataPath(): string | null {
  // An empty value means "unset" — .env files carry blank keys all the time,
  // and silently running without persistence would be the worst reading of it.
  const configured = process.env.COMMUNITY_DATA?.trim();
  if (!configured) return fileURLToPath(new URL('../data/community.json', import.meta.url));
  return configured === ':memory:' ? null : configured;
}

/** Signup cap, where 0 legitimately means "this instance is closed". */
function signupsPerHour(): number | undefined {
  const raw = process.env.COMMUNITY_SIGNUPS_PER_HOUR?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const anthropic = new Anthropic();
  const sources = sourcesFromEnv();

  app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
  });
  // An instance that boots happily and then fails on the first person to sign
  // up is worse than one that refuses to boot: the failure surfaces at 3am, to
  // a member, instead of at deploy time, to whoever deployed it.
  const sender = sendersFromEnv();
  // Push is optional: unset keys mean the client is told it is off, not a refusal.
  const push = await pushFromEnv();
  if (!sender && process.env.NODE_ENV === 'production') {
    throw new Error(
      'No way to send one-time codes is configured, so nobody could confirm an ' +
      'email address or a phone number. Set EMAIL_PROVIDER and/or SMS_PROVIDER ' +
      '(see .env.example), or run without NODE_ENV=production to log codes to the console.',
    );
  }

  app.register(
    communityRoutes({
      dataPath: communityDataPath(),
      signupsPerHourPerIp: signupsPerHour(),
      moderators: (process.env.COMMUNITY_MODERATORS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
      // Real providers when configured; otherwise the console sender, which
      // logs codes in development and refuses to start in production.
      sender: sender ?? undefined,
      push: push ?? undefined,
    }),
    { prefix: '/api/community' },
  );

  app.get('/api/health', async () => ({
    ok: true,
    sources: sources.map((s) => s.name),
  }));

  app.post('/api/estimate', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'Attach an image in the "image" field.' });
    }
    if (!ACCEPTED.has(file.mimetype)) {
      return reply
        .code(415)
        .send({ error: `Unsupported image type "${file.mimetype}". Use JPEG, PNG, GIF, or WebP.` });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'Image exceeds the 10MB limit.' });
    }

    const hint = typeof file.fields.hint === 'object' && file.fields.hint && 'value' in file.fields.hint
      ? String((file.fields.hint as { value: unknown }).value)
      : undefined;

    try {
      const item = await identifyItem(anthropic, {
        imageBase64: buffer.toString('base64'),
        mediaType: file.mimetype as 'image/jpeg',
        hint: hint?.trim() || undefined,
      });

      const { listings, warnings } = await gatherListings(sources, item.searchQueries);
      const estimate = aggregate(listings, item.confidence);

      if (listings.length > 0 && estimate === null) {
        warnings.push('Found listings but none had a usable price.');
      }

      const body: EstimateResponse = { item, estimate, listings, warnings };
      return reply.send(body);
    } catch (error) {
      if (error instanceof RefusalError) {
        return reply.code(422).send({ error: error.message });
      }
      if (error instanceof Anthropic.AuthenticationError) {
        request.log.error({ err: error }, 'Anthropic auth failed');
        return reply
          .code(500)
          .send({ error: 'Server is not configured with valid Claude API credentials.' });
      }
      if (error instanceof Anthropic.RateLimitError) {
        return reply.code(429).send({ error: 'Rate limited upstream. Try again shortly.' });
      }
      request.log.error({ err: error }, 'estimate failed');
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Unexpected failure.',
      });
    }
  });

  return app;
}

// Only listen when run directly, so tests can import buildServer().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
