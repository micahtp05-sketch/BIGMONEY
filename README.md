# BIGMONEY

Two things live in this repo, served by one Fastify process:

- **Commons** (`/`) — a community platform where people ask the people nearby for help
  with the house, join standing public groups, and find company. See
  [Commons](#commons) below.
- **The price estimator** (`/estimate/`) — photograph an item, get a price estimate
  built from comparable marketplace listings.

They are joined at one seam: a question in a help channel can carry a price estimate
made from a photo, so "repair or replace?" starts from a number instead of a guess.

## The price estimator

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

`http://localhost:3000` is Commons; the estimator is at `/estimate/`.

Commons needs no credentials at all. The estimator runs out of the box with no marketplace credentials — `PRICE_SOURCE` defaults to `fixture`, an offline source backed by `data/fixtures.json` — but does need Claude API credentials for the identification step (`ANTHROPIC_API_KEY`, or an `ant auth login` profile).

```bash
npm test         # 62 tests, no network required
npm run typecheck
```

A brand-new instance opens with fourteen channels and nothing in them, which
tells you very little. To see it with a day of activity in it:

```bash
COMMUNITY_DATA=:memory: COMMUNITY_SIGNUPS_PER_HOUR=100 npm start &
npm run seed:demo
```

That creates six members and a dozen threads **through the public API**, the
same calls a browser makes — an answered question with the accepted reply, two
meetups with RSVPs, a repair-or-replace question carrying a price estimate, and
somebody posting at 3am in The Front Porch. It prints the handles to sign in as
when it finishes.

Every account it creates shares one well-known password, so it refuses to run
against a non-localhost host, and refuses to add to an instance that already has
members. `SEED_ALLOW_REMOTE=1` and `SEED_FORCE=1` override those; read what they
say first.

There is also a browser pass over the Commons client, kept out of `npm test`
because it needs a running server and a real browser:

```bash
npm install --no-save playwright && npx playwright install chromium
COMMUNITY_DATA=:memory: PORT=3210 npm start &
BASE=http://127.0.0.1:3210 npm run test:browser
```

It catches what the API tests structurally cannot — a falsy value rendered into
the page as the text "null", a live event that never arrives, markup in a post
escaping into the DOM.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API credentials. Falls back to an `ant auth login` profile. |
| `PRICE_SOURCE` | `fixture` | `fixture` (offline) or `ebay` (live). |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | — | Required when `PRICE_SOURCE=ebay`. |
| `EBAY_ENV` | `PRODUCTION` | `PRODUCTION` or `SANDBOX`. |
| `EBAY_MARKETPLACE` | `EBAY_US` | e.g. `EBAY_GB`, `EBAY_DE`. |
| `PORT` | `3000` | HTTP port. |
| `COMMUNITY_DATA` | `data/community.json` | Where Commons persists. `:memory:` runs without a file. |
| `COMMUNITY_SIGNUPS_PER_HOUR` | `5` | New accounts allowed per hour from one IP. |

## Estimator API

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

## Commons

A place for three things that turn out to need the same substrate and different
surfaces:

| Channel kind | What it is for | Seeded channels |
|---|---|---|
| `help` | Somebody has a problem and wants an answer from someone who has done it | Home & Repair, Is It Worth Fixing?, Garden & Yard, Tech Help, Borrow a Tool, Money & Paperwork |
| `group` | A standing public group around a shared interest | The Cook's Table, Makers & Menders, New Parents, Book Club |
| `social` | Getting people who are alone into the same room | The Front Porch, Daily Check-In, Walks & Coffee, Sunday Supper |

Members can also create channels of any kind (three a day, so the list stays
navigable).

### What it does

- **Ask and answer.** Threads and replies. The person who asked marks the reply that
  actually worked; it sorts to the top of the thread, so the next person with the same
  problem does not have to read the whole argument.
- **Expertise, disclosed rather than certified.** Members list skills on their profile.
  Where a skill matches a channel topic, replies carry a *"says they know plumbing"*
  chip. Nothing is verified, and the UI never claims otherwise — see
  [Why expertise works this way](#why-expertise-works-this-way).
- **Meetups.** A meetup *is* a thread, with a time, a place, and RSVPs. Past capacity
  people join a waitlist rather than being turned away. `/api/community/meetups` is the
  cross-channel "what's on".
- **Presence and waves.** An opt-in *open to chat right now* flag puts you on the
  members page, and any member can send a wave — one per person per day, so it can
  never become a way to pester.
- **Live updates.** New threads, replies, RSVPs and presence changes arrive over SSE.
- **Moderation.** Anyone can report; three distinct reporters hide a post pending
  review. One person cannot hide another's post alone, and authors can always delete
  their own.

### Commons API

All routes are under `/api/community`. Session lives in an `HttpOnly`, `SameSite=Lax`
cookie.

```
POST   /auth/signup | /auth/login | /auth/logout
GET    /me                         PATCH /me            profile + presence
GET    /channels                   POST  /channels
GET    /channels/:slug             channel + recent threads
POST   /channels/:slug/threads     ask, post, or schedule a meetup
GET    /threads/:id                thread + replies + RSVPs
DELETE /threads/:id                author only
POST   /threads/:id/replies
POST   /threads/:id/accept         {replyId} — asker only, null to unmark
POST   /threads/:id/rsvp           toggle
POST   /replies/:id/helpful        toggle    DELETE /replies/:id
GET    /meetups                    upcoming, across every channel
GET    /people                     ?open=1&skill=plumbing
GET    /people/:handle
POST   /waves | GET /waves | POST /waves/read
GET    /search?q=
POST   /report                     {kind: thread|reply, id, reason}
GET    /stream                     server-sent events
GET    /health
```

### Design notes

**Why expertise works this way.** Verifying trades is a licensing problem, not a
software problem, and a badge that looks like verification is worse than no badge —
it launders a stranger's confidence into apparent authority. So Commons reports two
facts and no judgements: what a member *says* they know (shown with "says they know"
wording, next to the answer where it can be weighed), and how many times an asker
marked one of their answers as the one that worked. Credit follows the mark, so
un-marking takes the point back.

**Why public-only, with no direct messages.** A platform whose whole point is
reaching isolated people is exactly the platform a predator would want private
channels on. Everything here is in the open, and the one private-ish primitive — a
wave — carries a short note, is rate-limited to once per person per day, and cannot
be replied to except in public.

**Why the state layer is a JSON file.** Reads are map lookups; writes mutate memory
and schedule a debounced atomic replace (write to a temp file, then rename), so a
crash mid-write leaves the last good file rather than a truncated one. It is correct
for one process and honest about being so — the seam to swap for Postgres is
`CommunityStore`, which every route goes through.

**Why SSE and not WebSockets.** Every event here travels server-to-client. SSE
reconnects on its own, needs no protocol upgrade in front of proxies, and adds no
dependency.

**Why no email address.** Nothing on Commons needs to reach a member anywhere else, so
signup is a handle and a password. Passwords are scrypt with a per-user salt, verified
in constant time; login says the same thing for a wrong password as for a handle that
does not exist.


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
- **Commons stores state in one JSON file in one process.** Correct and durable for a
  single instance; it does not survive being run behind more than one process, and it
  will not stay fast past tens of thousands of threads. `CommunityStore` is the seam.
- **Commons has no email, so there is no password reset.** A forgotten password means a
  new account, which is the honest consequence of not collecting an address.
- **Moderation is community-only.** Three reports hide a post; nothing un-hides it,
  because there is no moderator role or review queue yet.
- **SSE has no replay.** A client that loses its connection may miss events until its
  next navigation re-fetches; nothing is lost server-side, but the page can be briefly
  stale.
- **Search is a substring scan over every thread.** Fine at this size, and the obvious
  next thing to replace.
- **Server-side refusal fallbacks are not wired up.** `identifyItem` handles `stop_reason: "refusal"` explicitly, but adding the server-side `fallbacks` parameter requires the `client.beta.messages` path, which does not currently expose the typed `.parse()` helper this code uses for structured output.

## Layout

```
src/
  types.ts             Estimator types — the contract between every stage
  vision.ts            Claude vision call, schema, refusal handling
  aggregate.ts         Quantiles, outlier rejection, confidence scoring
  server.ts            Fastify wiring for both surfaces
  sources/
    index.ts           PriceSource registry + multi-query gathering
    ebay.ts            eBay Browse API adapter
    fixture.ts         Offline source for tests and local development
  community/
    types.ts           Commons domain types, including the SSE event union
    store.ts           In-memory maps + atomic JSON persistence
    auth.ts            scrypt passwords, session tokens, cookie handling
    routes.ts          Every Commons route, as a Fastify plugin
    views.ts           Domain records -> what a client is allowed to see
    events.ts          In-process fan-out for SSE
    ratelimit.ts       Fixed-window limiter
    seed.ts            The channels a new instance opens with
public/
  index.html           Commons shell
  commons.js           Commons client — no framework, no build step
  commons.css
  estimate/index.html  The price estimator page
scripts/seed-demo.mjs  Fills an empty instance with a day of activity
data/fixtures.json     Sample listings for the offline source
data/community.json    Commons state (created on first write, gitignored)
test/                  Unit + integration tests
```
