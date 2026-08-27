import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { aggregate } from './aggregate.ts';
import { replyWithError } from './api-errors.ts';
import { registerBusinessRoutes } from './business/routes.ts';
import { WorkspaceStore } from './business/store.ts';
import { gatherListings, sourcesFromEnv } from './sources/index.ts';
import type { EstimateResponse } from './types.ts';
import { identifyItem } from './vision.ts';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export async function buildServer(opts: { store?: WorkspaceStore } = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const anthropic = new Anthropic();
  const sources = sourcesFromEnv();
  const store = opts.store ?? (await WorkspaceStore.open());

  app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
  });

  app.get('/api/health', async () => ({
    ok: true,
    sources: sources.map((s) => s.name),
    businesses: store.read().businesses.length,
  }));

  // The dashboard is the second half of the product; static serving would only
  // find it at /dashboard.html, and that is not a URL anyone types twice.
  app.get('/dashboard', async (_request, reply) => reply.sendFile('dashboard.html'));

  registerBusinessRoutes(app, { store, anthropic });

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
      return replyWithError(request, reply, error, 'estimate');
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
