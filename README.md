# Commons

Rooms where people talk to each other and to the identity-checked professionals among
them. Eight trade rooms (Electricians, Plumbers, Heating & Gas, Builders & Renovation,
Landscapers & Gardeners, Roofers, Painters & Decorators, Tech & Wifi), the groups
members start themselves, and somewhere to just talk. Built for the person who will
close the tab rather than ask what a word means.

- **The app** is at `/`. It installs to a phone or a desktop as a PWA.
- **The landing page** is at `/welcome/`.
- **A photo-to-price estimator** lives alongside it at `/estimate/`, joined at one seam:
  a question in a trade room can carry a rough price made from a photo, so "repair or
  replace?" starts from a number. It is described [further down](#the-price-estimator).

One Fastify process, one JSON file, no build step, no framework, no runtime
dependencies beyond Fastify, Zod and the Anthropic SDK. Node 22.

## Quick start

```bash
npm ci
npm start                 # http://localhost:3000 — one-time codes print to the console
```

To see it with a day of activity in it instead of fourteen empty rooms:

```bash
COMMUNITY_DATA=:memory: COMMUNITY_SIGNUPS_PER_HOUR=100 COMMUNITY_MODERATORS=commonsmod npm start &
npm run seed:demo         # six members, a dozen posts, through the public API; prints who to sign in as
```

Every account the seeder creates shares one well-known password, so it refuses to run
against anything but localhost and refuses to add to an instance that already has
members (`SEED_ALLOW_REMOTE=1` / `SEED_FORCE=1` override; read what they say first).

## Tests

```bash
npm run test:all          # everything below, in order
npm run typecheck
npm test                  # 294 unit and API tests. No network, no browser.
npm run test:e2e          # 39 checks in a real browser: interface, install, cinematic layer, notifications
```

`npm test` runs offline with nothing beyond what is in `package.json`. It includes 106
contrast pairs read from the shipped stylesheet, a test that fails if an email or phone
number ever appears in a profile or directory response, the production boot guard, and
sign-up surviving a code provider that is down.

`npm run test:e2e` starts its own in-memory server on a free port, seeds it, runs the
three browser suites and stops it. It needs a Chromium once: `npx playwright install
chromium`. It catches what the API tests structurally cannot — a `null` rendered into
the page, a live event that never arrives, markup escaping into the DOM, a manifest no
browser would install, a theme that flashes on reload.

The interface is held to [docs/simple-ui.md](docs/simple-ui.md). Installing it as an
app is in [docs/apps.md](docs/apps.md). Putting it on the internet is
[docs/deploy.md](docs/deploy.md). The manager handoff — status, the decisions that
must not be undone, the ranked gaps — is [docs/handoff.md](docs/handoff.md).

## Commons

A place for three things that turn out to need the same substrate and different
surfaces:

| Room kind | What it is for | Who can start one | Seeded rooms |
|---|---|---|---|
| `help` | One room per trade. Anyone asks; identity-checked professionals answer, and are listed at the top. | Moderators only | Electricians, Plumbers, Heating & Gas, Builders & Renovation, Landscapers & Gardeners, Roofers, Painters & Decorators, Tech & Wifi |
| `group` | A club or a standing group. The seeded ones are examples; the point is members starting their own. | Any member | Sunday Book Club, Bike Club, Walking & Exercise, Cooking |
| `social` | Plain company. | Any member | Chat & Check In, Meetups |

Members start groups and chats (three a day, so the list stays readable). A room
called *Plumbers* is a claim about who answers in it, so trade rooms are set up by
moderators. A member who does a trade for a living, and has been identity-checked, is
listed at the top of the matching room automatically — "Gas engineer" lands in Heating
& Gas, "Painter" in Painters & Decorators.

### What it does

- **Ask and answer.** Threads and replies. The person who asked marks the reply that
  actually worked; it sorts to the top of the thread, so the next person with the same
  problem does not have to read the whole argument.
- **Expertise, disclosed rather than certified.** Members list skills on their profile.
  Where a skill matches a channel topic, replies carry a *"says they know plumbing"*
  chip. Nothing is verified, and the UI never claims otherwise — see
  [Why expertise works this way](#why-expertise-works-this-way).
- **Meetups.** A meetup *is* a thread, with a time and RSVPs — and deliberately **no
  location field at all**. Past capacity people join a waitlist rather than being turned
  away. `/api/community/meetups` is the cross-channel "what's on".
- **Reviews.** Two kinds, kept visibly apart: *helped* reviews are anchored to
  something Commons watched happen and are refused otherwise; *hired* reviews are
  about paid work off the platform and are labelled unchecked wherever they appear.
  A member can add a self-declared trade, and the directory can be filtered by it.
  See [Why reviews look like this](#why-reviews-look-like-this).
- **Private messages, only around a meetup.** When somebody says they are coming, a
  channel opens between them and the host, and that is where the address goes. See
  [Why a meetup has no address](#why-a-meetup-has-no-address).
- **Presence and waves.** An opt-in *open to chat right now* flag puts you on the
  members page, and any member can send a wave — one per person per day, so it can
  never become a way to pester.
- **Blocking.** Any member can stop another reaching them: waves, the private meetup
  channel, RSVPs to each other's get-togethers, and new reviews all close, in both
  directions. Posts and reviews already written stay exactly where they are, and a
  block never puts anybody beyond moderation. See
  [What a block does](#what-a-block-does-and-what-it-deliberately-does-not).
- **A look that holds to the standard.** Every page opens like a title card, a room card
  grows into its room, and the landing page's constellation lives in the app header and
  lights up when somebody actually answers. Light by default, dark following the device,
  one tap to switch. Every text pair is computed at 7:1 or better by a test that reads
  the shipped stylesheet. See [What the look is for](#what-the-look-is-for).
- **Notifications.** Turned on from your own page, per device. Four moments and only
  those: somebody answered your question, somebody said your answer worked, somebody said
  hello, a message about a get-together arrived. Never room chatter, never across a block,
  and never a private message's text. Web Push, so it reaches the website and the installed
  app alike; see [What a notification carries](#what-a-notification-carries).
- **Live updates.** New threads, replies, RSVPs and presence changes arrive over SSE.
- **Moderation.** Anyone can report, with a reason. Three distinct reporters hide
  something automatically; a moderator then rules on it, and that ruling sticks. See
  [How moderation works](#how-moderation-works).

### Commons API

All routes are under `/api/community`. Session lives in an `HttpOnly`, `SameSite=Lax`
cookie.

```
POST   /auth/signup     {handle, displayName?, email, phone, password}
POST   /auth/login | /auth/logout
POST   /auth/send-code | /auth/confirm-code   {channel: email|phone, code?}
POST   /auth/forgot | /auth/reset             forgotten password, by email code
POST   /identity/request           {note} — ask to be identity-checked
GET    /identity/queue             moderator: who is waiting
POST   /identity/:handle/decide    moderator: {outcome, method?, reference?, reason?}
GET    /me                         PATCH /me            profile + presence
GET    /channels                   each with professionals (trade rooms) and startedBy
POST   /channels                   {name, kind, description, topics?} — help kind is moderator-only
GET    /channels/:slug/professionals   checked members whose trade fits the room, best reviewed first
GET    /channels/:slug             channel + recent threads
POST   /channels/:slug/threads     ask, post, or schedule a meetup
GET    /threads/:id                thread + replies + RSVPs
DELETE /threads/:id                author only
POST   /threads/:id/replies
POST   /threads/:id/accept         {replyId} — asker only, null to unmark
POST   /threads/:id/rsvp           toggle
GET    /threads/:id/messages       one private channel (?guest=<id> for the host)
POST   /threads/:id/messages       {body, guest?} — host to a guest, or guest to host
GET    /threads/:id/message-channels   host only: one entry per person coming
POST   /replies/:id/helpful        toggle    DELETE /replies/:id
GET    /meetups                    upcoming, across every channel
GET    /people                     ?open=1&skill=plumbing
GET    /people/:handle
GET    /people/:handle/reviews      list + summary
POST   /people/:handle/reviews      {kind, rating, body, threadId?}
GET    /people/:handle/shared       what the viewer could write a checked review about
DELETE /reviews/:id                 author only
POST   /people/:handle/block        stop them reaching you   DELETE to lift it
GET    /blocks                      who you have blocked. Only ever your own
POST   /waves | GET /waves | POST /waves/read
GET    /search?q=
POST   /report                     {kind: thread|reply|message|review, id, reason?}
GET    /moderation/queue           moderator: open cases, with the reasons given
GET    /moderation/log             moderator: recent rulings
POST   /moderation/:kind/:id/decide   moderator: {decision: kept|removed, reason?}
POST   /moderation/:kind/:id/appeal   author: {note} — one note, reopens the case
GET    /moderation/mine            what has happened to your own posts
POST   /people/:handle/role        moderator: {role: member|moderator}
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

**Getting codes to people.** Confirming an address or a number needs something that
actually sends. Two halves, configured separately, either of which may be absent:

```bash
EMAIL_PROVIDER=resend      EMAIL_API_KEY=...   EMAIL_FROM='Commons <hello@example.org>'
SMS_PROVIDER=twilio        SMS_API_KEY=...     SMS_FROM=+15550001111   SMS_ACCOUNT_ID=AC...
```

Email codes and password-reset codes go by email; phone codes go by SMS. Set neither
and codes are written to the console, which is fine for development — and the console
sender **refuses to start under `NODE_ENV=production`**, because an instance that
silently sends codes nobody receives would let anybody claim any address. Set one half
only and the other fails with a clear message rather than pretending.

Adding a provider is one file: implement `EmailSender` or `SmsSender`
(`src/community/senders/`) and add it to the map. The shared `post` helper gives every
adapter the same behaviour — a ten second timeout, three attempts, retries on 5xx and
network failures but never on a 4xx, and errors that never repeat the provider's
response body back, because that body can contain the code that was just sent or the
API key that sent it.

**None of these adapters has been run against a live provider.** They are written
against the documented APIs and tested against a stub HTTP server that checks the URL,
the auth header, the body shape, the retry behaviour and the timeout — everything
except whether the real endpoint behaves as its documentation says. The first live send
is the real test, exactly as with the eBay adapter on the estimator side.

**Who is checked, and what that means.** An account needs an email address, a phone
number, a username and a password. Both contact details are confirmed with a
six-digit code, and there is one account per address and per number — which is most
of what stops somebody opening fifty.

On top of that, an **identity check** is required before you can answer a question in a
help category, list a trade, or host a get-together. It is not required to ask for
help, to chat, or to say you are coming to something. That asymmetry is deliberate:
the people this site exists for are often the least likely to have a passport to hand,
and shutting them out of the social half to guard the helping half would defeat it.

A check is arranged and recorded by a moderator. **No document is ever uploaded and
none is stored.** What is kept is that a check happened, when, by what method, and by
whom — a passport scan sitting in a JSON file would be the least secure thing in this
codebase, and the outcome is the only part anybody needs afterwards. The method and
reference are visible to moderators alone; other members see a single flag.

The badge says **a real, contactable person is behind this account**. It does not say
they are a competent plumber. Trade remains self-declared, and reviews of paid work
still carry their own "we cannot check this" label.

Email addresses and phone numbers never leave the server. `publicUser` does not carry
them and no route returns them for anybody but the account's owner; there is a test
that fetches a profile and the directory and fails if either string appears.

Having an email address also means a **forgotten password can be reset** — the one
thing the previous no-email design could not do. A reset signs out every existing
session, and `/auth/forgot` answers identically whether or not the address is
registered, so it cannot be used to find out who is here.

**How moderation works.** Three reports hide something within seconds. That is fast,
and blunt: three people who agree with each other can silence anybody. So the automatic
hide is a holding action, not a verdict, and a moderator rules afterwards.

The reason somebody types when reporting is now kept. It used to be accepted and thrown
away, which made a queue impossible to work — a moderator could see that three people
objected but not what to.

A ruling sticks. **Put it back** restores the content and clears the reports, and from
then on that item is never auto-hidden again, so the same three people cannot simply
report their way back to the outcome that was just overturned. **Remove it** keeps it
hidden, with a reason recorded against a named moderator in a log other moderators can
read.

An author is told. `/moderation/mine` shows them what of theirs is hidden and what
people said about it — the reasons, never the reporters, because naming them invites
reprisal. They can send one note back, which reopens the case so somebody looks again.

The first moderator comes from `COMMUNITY_MODERATORS`, because nobody can appoint one
from inside an empty instance. After that moderators appoint each other; nobody can
change their own role, so a moderator can neither lock themselves in nor accidentally
lock everyone out.

**Still missing:** there is no way to suspend or block a member, only to act on
individual pieces of content, so somebody determined to be a nuisance has to be handled
one post at a time.

**Why reviews look like this.** A `helped` review has to point at the thread it came
from, and the server checks that the person being reviewed actually answered the
reviewer's question, or hosted a get-together the reviewer said they were coming to.
Anything else is refused. That makes one class of review genuinely hard to fake.

A `hired` review is about paid work done somewhere Commons cannot see. None of it is
checkable: not that the job happened, not that these two ever met. It exists because
people judging a tradesperson want it, and it is labelled *"Says they hired them. We
cannot check this"* on every card, with a standing warning above the list.

Around that: one review per person per subject, so nobody can pile on; no anonymous
reviews, because an unverifiable claim about somebody's livelihood should carry a
name; no average until there are at least two, because printing "5.0" over a single
opinion reads like a track record; reviews are reportable and three reports hide one,
which also removes it from the score.

**How the directory ranks people.** Somebody looking for help sees well-reviewed
members first. The order is a score, never shown to anyone, because it is a sort key
and not a grade:

```
score = (3 × 3.5  +  Σ weight × rating) / (3 + Σ weight)
weight = 2 for a checked "helped" review, 1 for an unchecked "hired" one
```

Two decisions are doing the work there. The prior — three imaginary middling reviews —
means one glowing review lands near 3.9 while a real record of forties and fifties
sits above 4, so somebody with six good reviews outranks somebody with one friend. And
weighting the checkable kind double means a fabricated review buys half of what an
earned one does.

Anybody with no reviews yet keeps their own section on the page rather than being
ranked last. Without that the loop closes: you cannot earn reviews because nobody sees
you, and nobody sees you because you have no reviews — which would shut out every new
tradesperson and every newly retired engineer with forty years behind them.

Hiding a review removes it from the score as well as from the page.

**What is still wrong with it, stated plainly.** There is no right of reply, so a
mistaken or malicious `hired` review sits on a real person's trade with no recourse
except a report — and there is still no moderator to receive that report. A brand-new
account can post one. Nothing detects a business reviewing its competitor. Now that
reviews order the directory, those same reviews decide who gets found, so the missing
moderator matters more than it did when a review only sat on one profile. These are
consequences of decisions taken deliberately, not oversights, and they are the first
things to revisit if this goes anywhere near real tradespeople.

**Why a meetup has no address.** A meetup's location is the most dangerous thing this
platform could publish. Hosts write their own homes into it — the demo data used to say
"14 Mill Lane, Riverside", because that is exactly what somebody hosting a supper
writes — and a public page keeps it forever, for anyone, including people who never
had any intention of coming. So Commons stores no address anywhere. The host tells each
guest where to come, in a channel that opens when that guest says they are coming.

That channel is the one private space in Commons, and it is scoped as narrowly as it
can be: it exists only for a (meetup, guest) pair, it has exactly two people in it, and
sending requires that the guest is currently coming. Every read is authorised on the
server against both halves — naming somebody else's channel is refused rather than
answered emptily, so it cannot be used to probe who is going. Cancelling closes the
channel to new messages but keeps the history, so either side can still report what was
said.

This is a real softening of the rule below, made deliberately: a private channel is a
place abuse can happen unseen. It is bounded to a meetup rather than opened across the
whole site, and it buys back something worth more — no home addresses on a public page.

**Why otherwise public-only, with no direct messages.** A platform whose whole point is
reaching isolated people is exactly the platform a predator would want private
channels on. Everything here is in the open, and the one private-ish primitive — a
wave — carries a short note, is rate-limited to once per person per day, and cannot
be replied to except in public.

**What a block does, and what it deliberately does not.** Reporting content was never
the same thing as stopping a person: you could object to something already said and
still have no way to make somebody leave you alone. A block closes contact — waves, the
private meetup channel, saying you are coming to a get-together the other hosts, and
writing a review of each other — and it closes it **in both directions from one
record**, because a block that only ran the way it was set would leave the blocked
person free to carry on waving.

It does not touch a single thread or reply. The rooms stay public and both people go on
seeing what the other says in them. Hiding posts would let somebody block a checked
electrician and quietly erase their answers from a trade room, and — worse — hand
anyone a way to talk about a person who cannot see it being done. What a member needs
protecting from is being contacted, followed to their door, and rated; not from
reading.

Two consequences follow from that line and are worth stating plainly. **A review
already written survives the block**, because a review that vanished when its subject
blocked its author would make blocking the cheapest way on the platform to clear a bad
rating. And **a block never puts anybody beyond moderation**: reporting, rulings and
the queue never consult it, so blocking the person you are about to report costs you
nothing.

Blocking withdraws any RSVP standing between the two, in either direction — a meetup
has no location field, so being down as coming obliges the host to hand over an
address, and a block the moment before somebody arrives at your door has to undo that.
Only the host-to-guest relationship counts: two guests who fall out on a third
person's meetup are both left where they are, because that meetup is not either of
theirs to police. Saying you are no longer coming is never refused, blocked or not.

The blocked person is not told, and the refusal they meet does not say who shut the
door or distinguish a block from any other reason somebody cannot be reached. They do
learn they cannot get through, which is the point; they do not get it confirmed that
this particular person did it, which would be worth retaliating over.

**What the look is for.** The landing page had already committed to a world — a night
sky, a crowd of small lights, a line that appears when one of them speaks, a spark
travelling from one person to another — and the app then cut to a paper form under a
black bar. "One identity across site and app" was only half kept. The rework keeps it:
every route opens the way a film opens, with one large line of Instrument Serif alone on
the ground, a rule drawn under it in the room's colour, and only then the page; tapping a
room card grows it into the room and going back shrinks the room into the card, so a
person always knows where they are and how to get home; and the constellation lives, still
as a photograph, inside the night header on every page, lighting up with one travelling
point when the server says somebody answered, said hello or is coming — while the room's
name in the rail glows and the new answer arrives with the word **New** beside it.

Three things were argued rather than assumed. **Light by default.** Two of five judged
directions wanted dark for continuity with the landing page; three argued light from the
person `docs/simple-ui.md` names — presbyopic and cataract eyes scatter light, so ivory on
black halates where ink on paper does not, and a dark glowing screen is what television has
taught a nervous 70-year-old to associate with things going wrong. The mechanics settled
it: no shipping browser reports "no preference" — an unset OS reports *light* — so "dark
when unset" can only be built by overriding an explicit light choice. Dark follows
`prefers-color-scheme` and a visible **Turn lights off** button in the rail head makes the
night version one tap away, remembered across visits. **Nothing moves under body text.**
The sky is confined to the header, still at rest, redrawn only on scroll or on an event,
and drawn at a documented fraction of its brightness under any word so every header token
still clears 7:1 against the brightest pixel it can produce. A full-page ambient canvas
behind glass was proposed, scored highest for cinema, and failed the fit gate for exactly
this. **The discipline is removal.** No shadows, no rounded surfaces, no coloured links, one
accent per room lifted byte-for-byte from the constellation's hub colours; and every
entrance animation has a visible resting state, so the reduced-motion kill switch can never
hide anything. `test/contrast.test.ts` reads the shipped stylesheet — not a copy of its
values — and fails on any body pair under 7:1, any drift between the two dark blocks, any
font under 14 px, or any `outline: none`.

**What a notification carries.** A name, a verb, a post's title and a link — never
more. Four moments send one: somebody answered your question, somebody said your answer
worked, somebody said hello, somebody sent you a message about a get-together. Nothing
sends for ordinary posts in a room, nothing crosses a block (a block closes contact, and a
notification is contact), and a message about a get-together says that one arrived, never
what it says — the whole design keeps where somebody lives off every screen but the two
people's own, and a lock screen is not one of those. Subscriptions are per browser and
move with whoever is signed in on it; one the push service reports gone is deleted on
sight. `web-push` is the first runtime dependency taken beyond Fastify, Zod and the
Anthropic SDK, chosen by the owner over a week of per-platform native push because Web
Push reaches the website and the installed app alike.

**Why the state layer is a JSON file.** Reads are map lookups; writes mutate memory
and schedule a debounced atomic replace (write to a temp file, then rename), so a
crash mid-write leaves the last good file rather than a truncated one. It is correct
for one process and honest about being so — the seam to swap for Postgres is
`CommunityStore`, which every route goes through.

**Why SSE and not WebSockets.** Every event here travels server-to-client. SSE
reconnects on its own, needs no protocol upgrade in front of proxies, and adds no
dependency.

**How passwords are held.** scrypt with a per-user salt, verified in constant time.
Login says the same thing for a wrong password as for a handle that does not exist, so
the form cannot be used to find out who has an account.

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
| `COMMUNITY_MODERATORS` | — | Handles that are moderators from the start, comma separated. |
| `EMAIL_PROVIDER` | — | `resend`, `postmark` or `sendgrid`. With `EMAIL_API_KEY` and `EMAIL_FROM`. |
| `SMS_PROVIDER` | — | `twilio` or `messagebird`. With `SMS_API_KEY`, `SMS_FROM`, and `SMS_ACCOUNT_ID` for Twilio. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | — | Push notifications. `npm run push:keys` prints a pair; unset means the button says it is not set up. |

## Deploying

`docs/deploy.md` is the whole checklist. The short version: it needs HTTPS, at least one
way to send one-time codes (`EMAIL_PROVIDER` or `SMS_PROVIDER`), a handle in
`COMMUNITY_MODERATORS`, and a persistent path in `COMMUNITY_DATA`. The `Dockerfile`
builds an image that keeps state on a `/data` volume and runs as an unprivileged user;
`GET /api/community/health` is the health check.

## Apps

The website stays; the end product is an app. Every app is a window onto one shared
Commons, not a copy of one. The native projects for iPhone and Android are generated
and in the repo, with real icons and splash screens drawn from the same mark as the
web icons, and `npm run app:sync` bakes your server address into both:

```bash
COMMONS_URL=https://commons.yourdomain.org npm run app:sync
npm run app:android      # Android Studio → Play Store internal testing
npm run app:ios          # Xcode → TestFlight
```

The exact path to both stores, the desktop app, and the one decision still open
(push notifications) are in [docs/apps.md](docs/apps.md).

## The price estimator

The pipeline is three steps:

1. **Identify** — a Claude vision call turns the photo into a structured item record: title, brand, model, condition, and the search queries a seller would actually use.
2. **Gather** — those queries run against one or more price sources, most-specific query first, stopping once enough comparables accumulate.
3. **Aggregate** — outliers are fenced out, then the surviving sample produces a median estimate, an interquartile range, and a confidence score.

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
- **No code sender has ever made a live call.** Email and SMS adapters are written
  against the documented APIs and tested against a stub, but the build container had no
  outbound network. Until one is wired, the checks that stop somebody claiming an
  address they do not own are not running. The console sender refuses to start under
  `NODE_ENV=production`, so this fails loudly rather than quietly.
- **Identity checking does not scale.** A moderator arranges to see something in
  person. Fine for a street, not a city, and while the queue is unattended nobody new
  can answer in a trade room.
- **There are no notifications.** Ask a question, close the tab, and nothing tells you
  it was answered.
- **Private meetup channels cannot be moderated.** By design — nothing reaches a
  moderator unless one of the two people reports it.
- **SSE has no replay.** A client that loses its connection may miss events until its
  next navigation re-fetches; nothing is lost server-side, but the page can be briefly
  stale.
- **Search is a substring scan over every thread.** Fine at this size, and the obvious
  next thing to replace.
- **Nothing paginates.** Every list stops at 50 with no "show more".
- **The service worker version is manual.** Change `public/commons.js` or
  `public/commons.css` without bumping `SHELL_VERSION` in `public/sw.js` and returning
  visitors keep the old file.
- **Server-side refusal fallbacks are not wired up.** `identifyItem` handles `stop_reason: "refusal"` explicitly, but adding the server-side `fallbacks` parameter requires the `client.beta.messages` path, which does not currently expose the typed `.parse()` helper this code uses for structured output.

## Layout

```
src/
  server.ts            Fastify wiring for both surfaces; buildServer() is importable
  community/
    types.ts           Commons domain types, including the SSE event union
    store.ts           In-memory maps + atomic JSON persistence
    auth.ts            scrypt passwords, session tokens, cookie handling
    routes.ts          Every Commons route, as a Fastify plugin
    views.ts           Domain records -> what a client is allowed to see
    verify.ts          One-time codes, hashed and expiring
    senders/           Email and SMS adapters, and the env factory
    events.ts          In-process fan-out for SSE
    ratelimit.ts       Fixed-window limiter
    seed.ts            The fourteen rooms a new instance opens with
  types.ts             Estimator types — the contract between every stage
  vision.ts            Claude vision call, schema, refusal handling
  aggregate.ts         Quantiles, outlier rejection, confidence scoring
  sources/             PriceSource registry; eBay adapter; offline fixture source
public/
  index.html           The app shell
  commons.js           The client — no framework, no build step
  commons.css          The design system: tokens with computed ratios, type scale, motion
  ambient.js           The constellation inside the header
  sw.js                Service worker; bump SHELL_VERSION when the client changes
  welcome/             The landing page and its hand-written 3D scene
  estimate/            The price estimator page
  icons/  fonts/
scripts/seed-demo.mjs  Fills an empty instance with a day of activity, through the API
scripts/make-icons.mjs Regenerates the app icons
test/*.test.ts         Offline suites (node:test) — API, store, senders, contrast, server
test/browser/          ui, pwa and cinematic checks; run.mjs runs them with their own server
docs/                  handoff, simple-ui standard, deploy, apps
data/fixtures.json     Sample listings for the offline price source
data/community.json    Commons state (created on first write, gitignored)
Dockerfile             One image, /data volume, unprivileged user
capacitor.config.ts    The native apps: id, name, night colours, server from COMMONS_URL
android/  ios/         Native projects, generated by Capacitor; icons and splashes drawn by
scripts/app-assets.mjs   ...this, from scripts/lib/mark.mjs, the same mark as the web icons
scripts/app-sync.mjs   npm run app:sync — cap sync + iOS app-bound domain + assets
desktop/               Electron shell for Mac and Windows; build config in package.json
```
