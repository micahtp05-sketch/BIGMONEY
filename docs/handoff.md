# Commons — handoff

**Status:** built and tested, not deployed. Nobody has used it.
**Branch:** `claude/community-needs-platform-cttvf4` · **PR:** micahtp05-sketch/BIGMONEY#2
**Head:** `c9182fd` · 17 commits · 50 files · ~10,700 lines added

---

## 1. What it is

A community platform where people talk to **each other** and to the **checked
professionals among them**. Not a helpdesk — nobody is asking the operator for
anything. Three kinds of room:

| Kind | What it is | Who opens one |
|---|---|---|
| **Trade rooms** | One per trade: Electricians, Plumbers, Heating & Gas, Builders & Renovation, Landscapers & Gardeners, Roofers, Painters & Decorators, Tech & Wifi. Anyone asks; identity-checked professionals answer and are listed at the top. | Moderators only |
| **Groups** | Sunday Book Club, Bike Club, Walking & Exercise, Cooking — examples. The point is members starting their own. | Any member, 3/day |
| **Just talk** | Chat & Check In, Meetups. | Any member |

It lives alongside a pre-existing price estimator (photo → comparable listings →
median estimate) which was in the repo before this work and is unchanged.

- App at `/` · landing page at `/welcome/` · estimator at `/estimate/`
- Installs as a PWA on iPhone, Android, Mac and Windows

---

## 2. Run it in two minutes

```bash
npm install
COMMUNITY_DATA=:memory: COMMUNITY_SIGNUPS_PER_HOUR=100 COMMUNITY_MODERATORS=commonsmod npm start &
npm run seed:demo          # 7 members, 11 threads, prints who to sign in as
```

Everything is Node 22 with `--experimental-strip-types`. **No build step, no
framework, no runtime dependencies beyond Fastify + Zod + the Anthropic SDK.**
That constraint held for the whole build and is worth keeping — it is why there
is no bundler, no lockfile churn, and why the client is plain ES modules.

| Command | What it does | Needs |
|---|---|---|
| `npm test` | 136 unit + API tests | nothing, runs offline |
| `npm run typecheck` | `tsc --noEmit` | nothing |
| `npm run test:browser` | 22 interface checks | a running server + Playwright |
| `npm run test:pwa` | 7 install checks | a running server + Playwright |
| `npm run seed:demo` | fills an empty instance via the public API | a running server |
| `npm run icons` | regenerates app icons from source | nothing |

**165 checks, all green at `c9182fd`.**

---

## 3. Decisions that constrain everything

These were argued through and are load-bearing. Changing one changes the product.

**Identity is checked; competence is not.** Anyone answering in a trade room,
listing a trade, or hosting a get-together must be identity-checked by a
moderator. Asking, chatting and attending never require it — the members the
social half exists for are the least likely to have a passport to hand. The
badge says *a real, contactable person is behind this account*, never *this is a
good plumber*.

**No identity document is ever stored.** A moderator arranges to see something
and records only that a check happened, when, by what method, by whom. Passport
scans in a JSON file would be the least secure thing in the codebase.

**Contact details never leave the server.** `publicUser()` does not carry email
or phone and no route returns them for anyone but the owner. There is a test
that fetches a profile and the whole directory and fails if either string
appears anywhere in the response. *Keep that test.*

**A meetup has no location field at all.** The host tells each guest privately
once they say they are coming. A client that sends an address anyway has it
stripped. This closed a real leak — the demo data used to contain a home address
because that is what a host naturally writes.

**One private channel, scoped to one meetup and two people.** It exists only for
a (meetup, guest) pair, sending requires the guest is currently coming, and
naming somebody else's channel is refused rather than answered emptily so it
cannot be used to probe who is going. This was a deliberate softening of a
no-DMs rule, taken to kill the address leak.

**Two kinds of review, kept visibly apart.** `helped` reviews are anchored to
something the server witnessed and refused otherwise. `hired` reviews are about
off-platform work, are unverifiable, and are labelled *"we cannot check this"*
everywhere they appear. One review per person per subject, never anonymous.

**Ranking has a prior.** The directory orders by
`(3 × 3.5 + Σ weight × rating) / (3 + Σ weight)`, weight 2 for a checked review
and 1 for an unchecked one. The prior stops one glowing review winning; the
weighting halves what a fabricated one buys. People with no reviews get their
own section rather than being ranked last — otherwise nobody new is ever seen.

**Three reports are a holding action, not a verdict.** A moderator rules
afterwards and the ruling sticks: keeping something clears the reports and it is
never auto-hidden again, so the same three people cannot re-report their way
back. Authors are told the reasons, never the reporters.

Full reasoning for each is in `README.md` under "Design notes"; the interface
rules are in `docs/simple-ui.md`; packaging is in `docs/apps.md`.

---

## 4. Before anyone signs up — blocking

1. **Wire a real code sender.** Email/SMS verification is built behind a
   `CodeSender` interface with adapters for Resend, Postmark, SendGrid, Twilio
   and MessageBird. Configure with `EMAIL_PROVIDER`/`EMAIL_API_KEY`/`EMAIL_FROM`
   and `SMS_PROVIDER`/`SMS_API_KEY`/`SMS_FROM` (plus `SMS_ACCOUNT_ID` for
   Twilio). **None has made a live call** — the build container had no outbound
   network. They are tested against a stub for request shape, auth, retries and
   timeouts. The default console sender refuses to start under
   `NODE_ENV=production`, so this fails loudly, but until it is wired the checks
   that stop somebody claiming an address they do not own are not running.
2. **Deploy over HTTPS.** Nothing is hosted. The PWA cannot be installed without
   it and the whole thing currently runs on a laptop.
3. **Appoint moderators.** `COMMUNITY_MODERATORS=handle1,handle2` seeds the
   first; after that they appoint each other. Without one, nobody can be
   identity-checked, so nobody can answer in a trade room.
4. **Decide the data story.** State is one JSON file in one process, with no
   backups. It is correct and durable for a single instance and will not survive
   two. `CommunityStore` is the seam for Postgres — every route goes through it.

## 5. Known gaps, ranked

| | Gap | Why it matters |
|---|---|---|
| High | **Nobody can be blocked** | You can report content but not stop a specific person contacting you. The one-hello-a-day limit slows a nuisance; it does not stop one. |
| High | **Identity checking does not scale** | A moderator arranges to see something in person. Fine for a street, not a city, and while the queue is unattended nobody new can answer. |
| Med | **No notifications** | Ask a question, close the tab, never learn it was answered. Biggest retention risk, and the native justification a store submission needs. |
| Med | **Reviews cannot be answered** | Deliberate (owner's call). A mistaken `hired` review sits on someone's trade and now also moves them down a ranked list. |
| Med | **Private channels are unmoderatable** | By design. Nothing reaches a moderator unless the recipient reports it. |
| Med | **Nothing paginates** | Every list stops at 50 with no "show more". |
| Med | **Chat re-renders on live updates** | Loses scroll position and a half-typed message. |
| Low | **Trade→room matching is string-based** | "Gas engineer" finds Heating & Gas; "Sparky" finds nothing. Fix is a picklist mapped to rooms. |
| Low | **Search is a substring scan** | Over every thread, every time. |
| Low | **Service worker version is manual** | Change `commons.js` without bumping `SHELL_VERSION` and returning users keep the old file. |
| Low | **Accessibility specified, not audited** | `docs/simple-ui.md` sets a numeric floor and some of it is enforced by tests. No screen reader has touched it. |
| Low | **Capacitor / Electron never built** | Scaffolded only; no Xcode, no Android SDK, no Electron binary in the build container. See `docs/apps.md`. |
| Low | **eBay adapter never ran live** | Inherited from the pre-existing estimator, unchanged. |

## 6. If you do three things

1. Wire the code senders and deploy over HTTPS. Everything else is blocked
   behind those two.
2. Build blocking. It is the largest hole in a platform whose stated purpose is
   reaching isolated people, and private channels make it matter more.
3. Add notifications. Without them the community will not retain anyone, and
   they are what makes an app-store submission defensible.

---

## 7. Where things are

```
src/community/          the platform: store, auth, routes, views, moderation, verify
src/community/senders/  email + SMS adapters behind one CodeSender interface
public/commons.js       the whole client, plain ES modules, no framework
public/welcome/         landing page + the 3D constellation (canvas, no library)
public/fonts/           the five faces shared by site and app
test/                   136 offline tests
test/browser/           29 checks that need a real browser
docs/simple-ui.md       the interface standard the UI is held to
docs/apps.md            what installs where, and what was never built
scripts/seed-demo.mjs   fills an instance through the public API
```

**Two habits worth keeping.** Everything user-facing was checked by looking at
it in a real browser, not only by assertion — that is how the three worst bugs
of this build were found (a literal `null` rendered on the page, a router race
that threw people off the post they had just made, and a get-together whose
title never appeared). And every limitation above is written down rather than
discovered later; when you close one, delete the row.
