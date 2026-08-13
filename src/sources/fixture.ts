import { readFile } from 'node:fs/promises';
import type { Listing, PriceSource } from '../types.ts';

interface FixtureFile {
  [keyword: string]: Array<{
    title: string;
    price: number;
    currency?: string;
    condition?: string;
    sold?: boolean;
  }>;
}

/**
 * Offline price source backed by a JSON file.
 *
 * This exists so the whole pipeline is runnable and testable without network
 * access or marketplace credentials — and so tests have deterministic input.
 * It matches a query against fixture keys by token overlap, which is crude but
 * enough to exercise every downstream code path.
 */
export class FixtureSource implements PriceSource {
  readonly name = 'fixture';
  #data: FixtureFile | null = null;

  readonly #path: URL;

  constructor(path = new URL('../../data/fixtures.json', import.meta.url)) {
    this.#path = path;
  }

  async #load(): Promise<FixtureFile> {
    this.#data ??= JSON.parse(await readFile(this.#path, 'utf8')) as FixtureFile;
    return this.#data;
  }

  async search(query: string, opts: { limit: number }): Promise<Listing[]> {
    const data = await this.#load();
    const tokens = tokenize(query);

    let best: { key: string; score: number } | null = null;
    for (const key of Object.keys(data)) {
      const keyTokens = tokenize(key);
      const overlap = keyTokens.filter((t) => tokens.includes(t)).length;
      const score = overlap / keyTokens.length;
      if (score > 0 && (best === null || score > best.score)) best = { key, score };
    }
    if (!best || best.score < 0.4) return [];

    return (data[best.key] ?? []).slice(0, opts.limit).map((row) => ({
      title: row.title,
      priceCents: Math.round(row.price * 100),
      currency: row.currency ?? 'USD',
      condition: row.condition ?? null,
      url: null,
      source: this.name,
      sold: row.sold ?? true,
    }));
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
