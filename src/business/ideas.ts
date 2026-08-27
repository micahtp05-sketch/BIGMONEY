import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { RefusalError, withCategory } from '../refusal.ts';
import type { Business, IdeaReview } from './types.ts';

const ReviewSchema = z.object({
  sharpened: z.object({
    oneLiner: z
      .string()
      .describe(
        'The idea in one sentence a stranger would understand, in the form "we help X do Y so they can Z". Keep the ambition but remove the vagueness.',
      ),
    customer: z
      .string()
      .describe(
        'Who specifically pays. Narrow it until you could name ten real examples — "small businesses" is not an answer.',
      ),
    problem: z
      .string()
      .describe(
        'The problem in the customer\'s own terms, and what they do about it today. Every problem already has a substitute, even if it is a spreadsheet or doing nothing.',
      ),
    solution: z.string().describe('What is actually delivered, concretely.'),
    wedge: z
      .string()
      .describe(
        'The narrowest first version worth selling — the specific slice where this can win before it is good at anything else.',
      ),
  }),
  scores: z.object({
    problemClarity: z
      .number()
      .min(0)
      .max(10)
      .describe('Is there a specific, painful, recurring problem here, or a category of interest?'),
    demandEvidence: z
      .number()
      .min(0)
      .max(10)
      .describe(
        'How much evidence exists that people already pay to solve this — existing spend, workarounds, competitors making money. Absence of competition usually scores low, not high.',
      ),
    differentiation: z
      .number()
      .min(0)
      .max(10)
      .describe('Is there a reason to pick this over the substitute that survives a competitor copying the obvious parts?'),
    feasibility: z
      .number()
      .min(0)
      .max(10)
      .describe('Can a small team ship a sellable first version in about ninety days?'),
    unitEconomics: z
      .number()
      .min(0)
      .max(10)
      .describe('Is there a plausible path to a price that beats the cost of delivery and acquisition?'),
    timing: z
      .number()
      .min(0)
      .max(10)
      .describe('Why now? Something must have changed recently, or the window is neutral at best.'),
  }),
  riskiestAssumption: z
    .string()
    .describe(
      'The single belief that, if wrong, makes everything else irrelevant. Usually about demand, rarely about technology.',
    ),
  cheapestTest: z.object({
    test: z
      .string()
      .describe(
        'The cheapest way to find out whether that assumption holds, without building the product. Be specific about what is done and what is measured.',
      ),
    timeboxDays: z.number().describe('Working days this should take. Prefer under fourteen.'),
    costEstimate: z.string().describe('Rough out-of-pocket cost, e.g. "under $200".'),
    killCriterion: z
      .string()
      .describe(
        'The result that means stop — stated as a number and decided in advance, so it cannot be rationalised away afterwards.',
      ),
  }),
  whatWouldMakeThisBig: z
    .string()
    .describe(
      'The version of this idea that is worth ten times more than the current one, and the condition that would have to be true for it.',
    ),
  nextSteps: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe('Ordered actions for the next two weeks. Each one finishable and unambiguous.'),
});

const SYSTEM_PROMPT = `You pressure-test business ideas for an owner who wants the truth early, while changing course is still cheap.

Sharpen before you judge. Most ideas arrive vague, and a vague idea cannot be evaluated — restate it in its strongest specific form first, then assess that version rather than the muddle you were handed. If you have to make an assumption to sharpen it, make the most plausible one and let it show in the wording.

Score honestly and use the whole range. Everything at 7 is useless to the owner. A high score has to be earned by evidence in the idea itself, not by enthusiasm; low demand evidence with no known substitutes usually means nobody wants it, not that the market is untapped.

The most valuable thing you produce is the riskiest assumption and the cheapest test of it. Aim the test at whether anyone wants this, not at whether it can be built — ideas fail on demand far more often than on execution. The kill criterion must be a number decided now.

Be specific enough to act on and short enough to read. No hedging, no encouragement that outruns the evidence, and no advice that would apply equally to any other idea.`;

export interface RefineInput {
  /** What the user typed, verbatim. */
  raw: string;
  /** The business it would sit inside, when there is one. */
  business: Business | null;
}

/**
 * Turn a rough idea into something decidable: sharpened, scored on six
 * dimensions, and attached to one cheap experiment with a kill criterion.
 *
 * The overall score and verdict are computed here rather than asked for. A
 * model asked to both score dimensions and pronounce a verdict tends to
 * reconcile the two after the fact; deriving the verdict arithmetically keeps
 * it consistent across ideas and across runs.
 */
export async function refineIdea(
  client: Anthropic,
  { raw, business }: RefineInput,
): Promise<IdeaReview> {
  const context = business
    ? `\n\nThis idea belongs to an existing business, so judge it partly on fit — an idea that pulls this team away from what already works is expensive even when it is good:\n${JSON.stringify(
        {
          name: business.name,
          industry: business.industry,
          model: business.model,
          stage: business.stage,
          ownerGoals: business.goals,
        },
        null,
        2,
      )}`
    : '';

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: 'high',
      format: zodOutputFormat(ReviewSchema),
    },
    messages: [
      {
        role: 'user',
        content: `Pressure-test this idea.\n\n"""\n${raw}\n"""${context}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    throw new RefusalError(
      withCategory('Claude declined to review this idea', category) + '.',
      category,
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('The review was cut off before completing. Try again.');
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Model returned no structured review.');

  const overall = meanScore(parsed.scores);
  return {
    ...parsed,
    overall,
    verdict: verdictFor(overall),
    reviewedAt: new Date().toISOString(),
  };
}

export function meanScore(scores: IdeaReview['scores']): number {
  const values = Object.values(scores);
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1));
}

/** Deliberately hard to reach "promising": the point of the refinery is to
 *  kill ideas cheaply, and a generous verdict defeats that. */
export function verdictFor(overall: number): IdeaReview['verdict'] {
  if (overall >= 7) return 'promising';
  if (overall >= 5) return 'needs_work';
  return 'weak';
}
