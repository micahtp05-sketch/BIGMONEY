import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { RefusalError, withCategory } from './refusal.ts';
import type { ItemIdentification } from './types.ts';

/**
 * The schema doubles as the prompt: every `.describe()` here is read by the
 * model, so field descriptions do more work than the system prompt does.
 */
const IdentificationSchema = z.object({
  title: z
    .string()
    .describe(
      'Specific, searchable name for the item, as a marketplace listing would title it. Include brand and model when visible.',
    ),
  category: z
    .string()
    .describe('Broad category, lowercase, e.g. "electronics", "furniture", "clothing", "tools".'),
  brand: z.string().nullable().describe('Brand name if identifiable, else null. Do not guess.'),
  model: z
    .string()
    .nullable()
    .describe('Model number or product line if identifiable, else null. Do not guess.'),
  condition: z
    .enum(['new', 'like_new', 'good', 'fair', 'poor', 'unknown'])
    .describe('Condition judged from visible wear, damage, packaging, and completeness.'),
  searchQueries: z
    .array(z.string())
    .min(1)
    .max(4)
    .describe(
      'Marketplace search strings, most specific first. Start with brand + model; end with a broad fallback that will still return comparables if the specific one finds nothing.',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How confident you are in this identification. Be honest: a blurry photo of a generic object should score low.',
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      'Anything visible that materially changes value but a text search would miss — damage, missing parts, rare variant, included accessories. Null if nothing notable.',
    ),
});

const SYSTEM_PROMPT = `You identify second-hand items from photographs so their resale value can be estimated from marketplace listings.

Identify the single most prominent item in the photo. Ignore background objects, hands, and surfaces unless they are part of what is being sold.

Your search queries are fed verbatim into marketplace search. Write them the way a seller would title the listing, not the way a person would describe the photo. Include the brand and model when you can read them; a query that is too specific returns nothing, and one that is too vague returns the wrong price band, so order them specific to broad.

Judge condition only from what you can see. Report low confidence when the photo is unclear or the item is generic — a confident wrong answer produces a confidently wrong price.`;

export interface VisionOptions {
  /** Base64-encoded image bytes, no data: prefix. */
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Free-text hint from the user, e.g. "bought 2019, box included". */
  hint?: string;
}

export async function identifyItem(
  client: Anthropic,
  opts: VisionOptions,
): Promise<ItemIdentification> {
  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    // Identification is perception plus a little inference — it does not need
    // deep reasoning, and effort is the main lever on latency here.
    output_config: {
      effort: 'low',
      format: zodOutputFormat(IdentificationSchema),
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: opts.mediaType, data: opts.imageBase64 },
          },
          {
            type: 'text',
            text: opts.hint
              ? `Identify this item for resale pricing.\n\nThe seller adds: ${opts.hint}`
              : 'Identify this item for resale pricing.',
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    throw new RefusalError(
      withCategory('The vision model declined to analyze this image', category) +
        '. Try a different photo.',
      category,
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Identification was cut off before completing. Try again.');
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Model returned no structured identification.');
  return parsed;
}
