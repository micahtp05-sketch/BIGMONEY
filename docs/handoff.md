# Commons — handoff

**Status:** built and tested, not deployed. Nobody has used it.
**Branch:** `claude/community-needs-platform-cttvf4` · **PR:** micahtp05-sketch/BIGMONEY#2 → `main`
**One click only the owner can make:** the repository's default branch is still
`claude/hello-76xcdg` (the pre-Commons state `main` was cut from). Settings →
General → Default branch → `main`. The two unrelated `claude/…` branches can go.

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
- Looks like it is out of a film and reads at 7:1: see "What the look is for" in the README
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
| `npm run test:all` | everything below, in order — what CI runs | Chromium once (`npx playwright install chromium`) |
| `npm test` | 294 unit + API tests, including 106 contrast pairs read from the shipped stylesheet and the production boot guard | nothing, runs offline |
| `npm run test:e2e` | the three browser suites against a server it starts and stops itself | Chromium |
| `npm run app:sync` | syncs the native projects, bakes `COMMONS_URL`, draws icons and splashes; CI runs it before `npm test` so the 15 app checks are asserted | nothing |
| `npm run typecheck` | `tsc --noEmit` | nothing |
| `npm run test:browser` | 23 interface checks | a running server + Playwright |
| `npm run test:pwa` | 7 install checks | a running server + Playwright |
| `npm run test:cinematic` | 9 checks: theme, sky, morph, live beat, reduced motion, the notifications card and worker | a running server + Playwright |
| `npm run seed:demo` | fills an empty instance via the public API | a running server |
| `npm run icons` | regenerates app icons from source | nothing |

**333 checks, all green** (294 + 23 + 7 + 9), and the 23 interface checks pass again under `prefers-reduced-motion: reduce`. `.github/workflows/ci.yml` runs `npm run test:all` on every push.

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

**A block closes contact, never speech.** Waves, the private meetup channel, RSVPs
between the two, and new reviews all close — in both directions from one
record. Nothing either has posted is touched and no review already written is
removed, because hiding posts would let somebody erase a checked professional's
answers from a trade room, and a vanishing review would make blocking the
cheapest way to clear a bad rating. A block never puts anybody beyond
moderation, and the blocked person is never told who shut the door.

**The film is in the frame, not the polarity.** Light by default, dark following
the device, one visible tap to switch. The constellation lives in the header
only, still at rest, drawn dim under any word so every header token clears 7:1
against the brightest pixel it can make. Nothing moves under body text. A
full-page sky behind glass scored highest for cinema and failed the fit gate;
the reasoning is in the README under "What the look is for". The two things
that carry the identity — the title card on every route and one light
travelling one link when somebody actually speaks — are theme-independent.

**A notification carries a name, a verb, a title and a link — never more.** Four
moments only; nothing across a block; never a private message's text, because a
lock screen is not one of the two screens an address may appear on. `web-push` is
the one runtime dependency added since the build, by the owner's decision.

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
   Still true as of the latest session: `api.resend.com`, `api.postmarkapp.com`,
   `api.sendgrid.com` and `api.twilio.com` were each tried and every one was
   refused at the egress proxy. This needs somebody with credentials and a host,
   not another build container.
2. **Deploy over HTTPS.** Nothing is hosted. The PWA cannot be installed without
   it. `docs/deploy.md` and the `Dockerfile` make this an afternoon, not a project.
3. **Appoint moderators.** `COMMUNITY_MODERATORS=handle1,handle2` seeds the
   first; after that they appoint each other. Without one, nobody can be
   identity-checked, so nobody can answer in a trade room.
4. **Decide the data story.** State is one JSON file in one process, with no
   backups. It is correct and durable for a single instance and will not survive
   two. `CommunityStore` is the seam for Postgres — every route goes through it.

## 5. Known gaps, ranked

| | Gap | Why it matters |
|---|---|---|
| High | **Identity checking does not scale** | A moderator arranges to see something in person. Fine for a street, not a city, and while the queue is unattended nobody new can answer. |
| Med | **Store apps get no notifications yet** | Web Push is built and reaches the website and the home-screen app; the Capacitor WebViews have no push service. Native push (FCM + APNs via `@capacitor/push-notifications` and a second server sender) is a delivery route on top of what exists. `docs/apps.md` §4. |
| Med | **Reviews cannot be answered** | Deliberate (owner's call). A mistaken `hired` review sits on someone's trade and now also moves them down a ranked list. |
| Med | **Private channels are unmoderatable** | By design. Nothing reaches a moderator unless the recipient reports it. |
| Med | **Nothing paginates** | Every list stops at 50 with no "show more". |
| Low | **Trade→room matching is string-based** | "Gas engineer" finds Heating & Gas; "Sparky" finds nothing. Fix is a picklist mapped to rooms. |
| Low | **Search is a substring scan** | Over every thread, every time. |
| Low | **Service worker version is manual** | Change `commons.js` or `commons.css` without bumping `SHELL_VERSION` and returning users keep the old file. Currently `commons-shell-v5`. |
| Low | **Accessibility specified, not audited** | `docs/simple-ui.md` sets a numeric floor and some of it is enforced by tests. No screen reader has touched it. |
| Med | **Store apps not yet compiled** | The iPhone and Android projects are generated, carry real icons and splashes, sync with one command and have 15 tests — but no Xcode or Android SDK exists in the build container. The first build is on the owner's machine; `docs/apps.md` is the path. Electron: shell reviewed, build configured, binary not installed. |
| Low | **eBay adapter never ran live** | Inherited from the pre-existing estimator, unchanged. |

## 6. If you do three things

1. Wire the code senders and deploy over HTTPS. Everything else is blocked
   behind those two.
2. Add notifications. Without them the community will not retain anyone, and
   they are what makes an app-store submission defensible. Web push needs the
   HTTPS from (1) before it can be finished.
3. Make identity checking scale past one moderator seeing people in person.
   Until it does, the queue is the bottleneck on anybody new being able to
   answer in a trade room.

Blocking, which used to be the top of this list, is built — see §3.

---

## 7. Where things are

```
src/community/          the platform: store, auth, routes, views, moderation, verify
src/community/senders/  email + SMS adapters behind one CodeSender interface
public/commons.js       the whole client, plain ES modules, no framework
public/commons.css      the design system: tokens with computed ratios, type scale, motion
public/ambient.js       the constellation inside the header, still until somebody speaks
public/welcome/         landing page + the 3D constellation (canvas, no library)
public/fonts/           the five faces shared by site and app
test/                   294 offline tests, contrast.test.ts among them
test/browser/           39 checks that need a real browser (ui, pwa, cinematic); run.mjs runs them
Dockerfile              one image, /data volume, unprivileged user — see docs/deploy.md
CLAUDE.md               the short version of this file, for whoever opens the repo next
android/  ios/          the native app projects (Capacitor); desktop/ the Electron shell
capacitor.config.ts     the apps' identity, colours and server address
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
