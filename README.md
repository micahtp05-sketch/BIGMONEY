# BIGMONEY

Photograph an item, get a price estimate built from comparable marketplace listings.

The pipeline is three steps:

1. **Identify** — a Claude vision call turns the photo into a structured item record: title, brand, model, condition, and the search queries a seller would actually use.
2. **Gather** — those queries run against one or more price sources, most-specific query first, stopping once enough comparables accumulate.
3. **Aggregate** — outliers are fenced out, then the surviving sample produces a median estimate, an interquartile range, and a confidence score.

## Quick start

```bash
npm install
cp .env.example .env      # optional — see Configuration
npm start                 # http://localhost:3000
```

It runs out of the box with no marketplace credentials: `PRICE_SOURCE` defaults to `fixture`, an offline source backed by `data/fixtures.json`. You still need Claude API credentials for the identification step (`ANTHROPIC_API_KEY`, or an `ant auth login` profile).

```bash
npm test         # 21 tests, no network required
npm run typecheck
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API credentials. Falls back to an `ant auth login` profile. |
| `PRICE_SOURCE` | `fixture` | `fixture` (offline) or `ebay` (live). |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | — | Required when `PRICE_SOURCE=ebay`. |
| `EBAY_ENV` | `PRODUCTION` | `PRODUCTION` or `SANDBOX`. |
| `EBAY_MARKETPLACE` | `EBAY_US` | e.g. `EBAY_GB`, `EBAY_DE`. |
| `PORT` | `3000` | HTTP port. |

## API

`POST /api/estimate` — multipart form, field `image` (JPEG/PNG/GIF/WebP, ≤10MB), optional field `hint`.

```jsonc
{
  "item":     { "title": "...", "brand": "...", "condition": "good", "confidence": 0.92, ... },
  "estimate": { "estimateCents": 16850, "lowCents": 15762, "highCents": 17612,
                "currency": "USD", "sampleSize": 10, "outliersRemoved": 2,
                "confidence": 0.71, "confidenceReason": "..." },
  "listings": [ ... ],
  "warnings": [ ... ]
}
```

`estimate` is `null` when no defensible number exists — the API does not invent one from a single data point.

`GET /api/health` — liveness plus the active source list.

## Adding a price source

Implement `PriceSource` (`src/types.ts`) and register it in `sourcesFromEnv()`:

```ts
export interface PriceSource {
  readonly name: string;
  search(query: string, opts: { limit: number }): Promise<Listing[]>;
}
```

Prices are carried in **minor units** (cents) as integers throughout, so nothing accumulates float drift.

## Why the numbers are shaped this way

**Median, not mean.** Marketplace data is full of bad comparables — an accessory listed under the product's name, a ten-unit lot priced as one, a for-parts unit. The median resists them; the mean does not.

**Tukey fences before anything else.** Values outside `[Q1 − 1.5·IQR, Q3 + 1.5·IQR]` are dropped. Two guards keep this from misfiring: samples under four points are left alone (quartiles are meaningless there), and a sample whose IQR is zero is left alone (otherwise every price that isn't the modal one gets fenced).

**Confidence is multiplied, not averaged.** Sample size, price spread, and identification confidence each score 0–1 and multiply, so any one of them being terrible caps the result. A tight price band on a misidentified item should not read as high confidence.

**One currency per estimate.** Listings are grouped by currency and the dominant group wins. Averaging dollars with yen produces a confident, meaningless number.

## Known limitations

- **The eBay adapter has not been run against the live API.** It is written against eBay's documented Browse API and client-credentials OAuth flow, but the development container has no outbound network access, so the first live run is the real test.
- **Browse API returns asking prices, not sold prices.** Active listings skew high relative to realized value. Sold-price data needs eBay's Marketplace Insights API, which is access-gated. Listings from this source carry `sold: false` to make that visible rather than silently optimistic.
- **One source at a time.** `gatherListings` already accepts and merges an array of sources; `sourcesFromEnv` just doesn't yet build more than one.
- **No caching or rate limiting.** Every request is a fresh Claude call plus fresh marketplace queries.
- **Server-side refusal fallbacks are not wired up.** `identifyItem` handles `stop_reason: "refusal"` explicitly, but adding the server-side `fallbacks` parameter requires the `client.beta.messages` path, which does not currently expose the typed `.parse()` helper this code uses for structured output.

## Layout

```
src/
  types.ts           Shared types — the contract between every stage
  vision.ts          Claude vision call, schema, refusal handling
  aggregate.ts       Quantiles, outlier rejection, confidence scoring
  server.ts          Fastify routes, upload validation, error mapping
  sources/
    index.ts         PriceSource registry + multi-query gathering
    ebay.ts          eBay Browse API adapter
    fixture.ts       Offline source for tests and local development
public/index.html    Single-page frontend
data/fixtures.json   Sample listings for the offline source
test/                Unit + integration tests
```
