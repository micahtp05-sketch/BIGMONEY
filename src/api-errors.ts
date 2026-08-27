import Anthropic from '@anthropic-ai/sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RefusalError } from './refusal.ts';

/**
 * One mapping from a failed Claude call to an HTTP response, shared by every
 * route that makes one. Kept in a single place so the status codes can't drift
 * apart route by route — a refusal is a 422 everywhere or nowhere.
 */
export function replyWithError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  context: string,
): FastifyReply {
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
  request.log.error({ err: error }, `${context} failed`);
  return reply.code(500).send({
    error: error instanceof Error ? error.message : 'Unexpected failure.',
  });
}
