# BIGMONEY

Two tools for the same job — knowing what something is worth.

**Business command** (`/dashboard`) takes your monthly figures and returns a scored read on the business, every weak ratio paired with the move it implies, a plan you can work, and an idea refinery that pressure-tests what you are thinking of doing next.

**Price estimator** (`/`) takes a photograph of an item and returns a resale estimate built from comparable marketplace listings.

```bash
npm install
cp .env.example .env      # optional — see Configuration
npm start                 # http://localhost:3000/dashboard

npm test         # 65 tests, no network required
npm run typecheck
```

Both halves run offline. The dashboard's scoring, the plan, and the price aggregation need no credentials; only the Claude-backed parts — the monthly briefing, the idea refinery, and photo identification — call the API.

---

## Business command

You enter one row per month: revenue, cost of sales, operating costs, and whatever else you actually track — cash, marketing spend, customer counts, headcount, what share of revenue your largest customer is. Everything past the first three is optional.

From that it derives the ratios that decide whether a business works (gross and net margin, burn and runway, growth, churn, CAC, LTV, payback, revenue per head, concentration), scores each one against benchmarks for **your business model and stage**, and turns every failing check into a specific next move.

### What it does with the numbers

**Benchmarks are per model, because "good" is.** A 35% gross margin is healthy for retail and alarming for software. The bar for every check lives in one table (`src/business/benchmarks.ts`) rather than scattered through the code, so disagreeing with a number is a one-line change.

**Every score is a ratio to its benchmark.** One curve serves margins, churn, and runway alike; hitting the benchmark exactly scores 80, leaving room above for genuinely good, and the curve flattens past that so overshooting one measure can't paper over a broken one.

**Missing data removes checks — it never becomes a zero.** Leave a field blank and the checks that need it disappear, the pillar reports what it would need, and `coverage` tells you what share of the checks had data behind them. A 90 built from two numbers is not the same claim as a 90 built from ten, and the dashboard says which one you are looking at.

**Trailing figures where a single month would mislead.** Runway uses three-month average burn, so one heavy month of equipment spend doesn't report a runway of weeks for a business that is fine. Growth compounds across four months rather than reacting to one good week.

**No number is invented to fill a gap.** Zero observed churn yields no LTV rather than an infinite one. Customers-at-start comes from last month's closing count, not this month's. The same rule the price estimator follows — no defensible number, no number.

### The five pillars

| Pillar | Weight | Checks |
|---|---|---|
| Profitability | 25% | gross margin, net margin |
| Growth | 20% | compound monthly revenue growth vs. stage |
| Retention & acquisition | 20% | churn, LTV:CAC, CAC payback |
| Operating efficiency | 15% | opex ratio, revenue per person |
| Resilience | 20% | runway, customer concentration |

Weights are renormalised over the pillars that could be scored, so an unscored pillar lowers coverage instead of quietly scoring zero.

### What Claude adds

The scores are deterministic and reproducible; they don't need a model and they don't drift. Two things do go through Claude:

- **The monthly briefing** reads your figures and the finished diagnosis and returns what to do *first* — the prioritisation, the causal read that connects two symptoms to one cause, the risk worth watching, and the one question whose answer would change your next move. It is told to cite your actual figures and to list what's missing rather than invent it.
- **The idea refinery** sharpens a rough idea into a specific one, scores it on six dimensions, names the riskiest assumption, and designs the cheapest test of that assumption with a kill criterion decided in advance. The overall score and verdict are computed from the six dimensions rather than asked for, so they stay consistent across ideas and across runs.

Both are separate endpoints from the diagnosis, so an expired API key costs you the advice, not the dashboard.

### Try it without typing in a year of figures

Click **Load the worked example** on the setup screen, or `POST /api/demo`. It seeds a small coffee subscription business that is growing and losing money at the same time: thin margins, acquisition costs that nearly match what a customer returns, one wholesale account at a third of revenue, and cash running out inside two quarters. Every pillar has something real in it.

---

## Price estimator

The pipeline is three steps:

1. **Identify** — a Claude vision call turns the photo into a structured item record: title, brand, model, condition, and the search queries a seller would actually use.
2. **Gather** — those queries run against one or more price sources, most-specific query first, stopping once enough comparables accumulate.
3. **Aggregate** — outliers are fenced out, then the surviving sample produces a median estimate, an interquartile range, and a confidence score.

It runs out of the box with no marketplace credentials: `PRICE_SOURCE` defaults to `fixture`, an offline source backed by `data/fixtures.json`.

**Median, not mean.** Marketplace data is full of bad comparables — an accessory listed under the product's name, a ten-unit lot priced as one, a for-parts unit. The median resists them; the mean does not.

**Tukey fences before anything else.** Values outside `[Q1 − 1.5·IQR, Q3 + 1.5·IQR]` are dropped. Two guards keep this from misfiring: samples under four points are left alone (quartiles are meaningless there), and a sample whose IQR is zero is left alone (otherwise every price that isn't the modal one gets fenced).

**Confidence is multiplied, not averaged.** Sample size, price spread, and identification confidence each score 0–1 and multiply, so any one of them being terrible caps the result. A tight price band on a misidentified item should not read as high confidence.

**One currency per estimate.** Listings are grouped by currency and the dominant group wins. Averaging dollars with yen produces a confident, meaningless number.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API credentials. Falls back to an `ant auth login` profile. |
| `WORKSPACE_FILE` | `data/workspace.json` | Where businesses, monthly figures, plans, and ideas are stored. |
| `PRICE_SOURCE` | `fixture` | `fixture` (offline) or `ebay` (live). |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | — | Required when `PRICE_SOURCE=ebay`. |
| `EBAY_ENV` | `PRODUCTION` | `PRODUCTION` or `SANDBOX`. |
| `EBAY_MARKETPLACE` | `EBAY_US` | e.g. `EBAY_GB`, `EBAY_DE`. |
| `PORT` | `3000` | HTTP port. |

## API

Money is carried in **minor units (cents) as integers** everywhere, so nothing accumulates float drift. Ratios are fractions, never percentages.

### Business

| Route | Purpose |
|---|---|
| `GET /api/businesses` | List, each with its current score and open-action count. |
| `POST /api/businesses` | Create. `{ name, industry, model, stage, currency, goals }`. |
| `GET · PATCH · DELETE /api/businesses/:id` | Read, edit the profile, remove. |
| `PUT /api/businesses/:id/snapshots` | Add or replace one month. Re-submitting a period corrects it. |
| `DELETE /api/businesses/:id/snapshots/:period` | Drop a month. |
| `GET /api/businesses/:id/diagnosis` | Scores, findings, pointers, and the derived series behind them. No Claude call. |
| `POST /api/businesses/:id/briefing` | Claude's read on what to do first. |
| `POST · PATCH · DELETE /api/businesses/:id/actions[/:actionId]` | The plan. |
| `GET · POST · DELETE /api/ideas[/:id]` | The idea refinery. |
| `POST /api/demo` | Seed the worked example. |

`model` is one of `saas`, `ecommerce`, `services`, `retail`, `marketplace`, `other`; `stage` is one of `idea`, `pre_revenue`, `early`, `growth`, `established`. Both choose the benchmarks you are measured against.

### Estimator

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

`GET /api/health` — liveness, the active source list, and how many businesses are stored.

## Adding a price source

Implement `PriceSource` (`src/types.ts`) and register it in `sourcesFromEnv()`:

```ts
export interface PriceSource {
  readonly name: string;
  search(query: string, opts: { limit: number }): Promise<Listing[]>;
}
```

## Known limitations

- **Single workspace, no accounts.** One JSON document, no authentication, no per-user separation. It is a tool you run for your own businesses, not a service you host for other people's.
- **Benchmarks are published operating ranges, not your industry's.** They are deliberately mid-range, and `src/business/benchmarks.ts` is meant to be edited when you know better than the table does.
- **Monthly granularity only.** One row per calendar month; weekly or per-product breakdowns would need a different shape.
- **The briefing has no memory between months.** Each one is written fresh from the current figures, so it cannot yet tell you that it recommended the same thing last month and nothing moved.
- **The eBay adapter has not been run against the live API.** It is written against eBay's documented Browse API and client-credentials OAuth flow, but the development container has no outbound network access, so the first live run is the real test.
- **Browse API returns asking prices, not sold prices.** Active listings skew high relative to realized value. Sold-price data needs eBay's Marketplace Insights API, which is access-gated. Listings from this source carry `sold: false` to make that visible rather than silently optimistic.
- **One source at a time.** `gatherListings` already accepts and merges an array of sources; `sourcesFromEnv` just doesn't yet build more than one.
- **No caching or rate limiting.** Every Claude-backed request is a fresh call.
- **Server-side refusal fallbacks are not wired up.** Every Claude call handles `stop_reason: "refusal"` explicitly, but adding the server-side `fallbacks` parameter requires the `client.beta.messages` path, which does not currently expose the typed `.parse()` helper this code uses for structured output.

## Layout

```
src/
  types.ts             Pricing types — the contract between every stage
  refusal.ts           RefusalError, shared by every Claude call
  api-errors.ts        One mapping from a failed Claude call to an HTTP status
  vision.ts            Claude vision call, schema, refusal handling
  aggregate.ts         Quantiles, outlier rejection, confidence scoring
  server.ts            Fastify app: static, estimator route, business routes
  sources/
    index.ts           PriceSource registry + multi-query gathering
    ebay.ts            eBay Browse API adapter
    fixture.ts         Offline source for tests and local development
  business/
    types.ts           The business domain — one place to look
    benchmarks.ts      What "good" is, per business model and stage
    metrics.ts         Snapshots -> derived ratios, nulls where data is missing
    diagnose.ts        Scoring, findings, and the pointer each one implies
    advisor.ts         Claude briefing: what to do first, and why
    ideas.ts           Claude idea refinery: sharpen, score, design the test
    store.ts           Single-document JSON persistence, atomic writes
    routes.ts          The /api/businesses and /api/ideas surface
    demo.ts            The worked example
public/
  index.html           Price estimator
  dashboard.html       Business command
data/fixtures.json     Sample listings for the offline source
test/                  Unit + integration tests
```
