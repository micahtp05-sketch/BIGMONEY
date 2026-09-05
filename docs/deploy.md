# Putting Commons on the internet

One Node process, one JSON file, no build step. Anything that can run a container or
`node` can run it. This page is the whole checklist.

## 1. What it needs

| Need | Why |
|---|---|
| **HTTPS** | Cookies are `Secure`-ready, the service worker will not register over plain HTTP, and the app cannot be installed to a phone without it. Every host below gives you HTTPS for free. |
| **A way to send one-time codes** | Signing up confirms an email address and a phone number with a six-digit code. Set at least one provider or the server refuses to start in production — deliberately (see the README's design notes). |
| **A moderator** | Somebody has to be able to rule on the first report and record the first identity check. `COMMUNITY_MODERATORS=yourhandle` makes that account a moderator the moment it signs up. |
| **A disk that persists** | State is `COMMUNITY_DATA` (a JSON file). Put it on a volume. |

## 2. Environment

Copy `.env.example`; these are the ones that matter for Commons:

```bash
NODE_ENV=production
PORT=3000
COMMUNITY_DATA=/data/community.json     # on a persistent volume
COMMUNITY_MODERATORS=yourhandle          # comma separated
COMMUNITY_SIGNUPS_PER_HOUR=5             # per IP; raise for a launch day

# At least one of these. Email covers sign-up and password reset; SMS covers phone numbers.
EMAIL_PROVIDER=resend                    # resend | postmark | sendgrid
EMAIL_API_KEY=...
EMAIL_FROM="Commons <hello@yourdomain.org>"   # an address the provider has verified

SMS_PROVIDER=twilio                      # twilio | messagebird — optional
SMS_API_KEY=...
SMS_FROM=+15550001111
SMS_ACCOUNT_ID=AC...                     # Twilio only
```

The estimator at `/estimate/` additionally needs `ANTHROPIC_API_KEY`. Commons does not;
without a key the estimator page reports that it is not configured and everything
else works.

## 3. Run it

**Docker (any host that takes a container — Fly, Railway, Render, a VPS):**

```bash
docker build -t commons .
docker run -d --name commons -p 3000:3000 -v commons-data:/data --env-file .env commons
```

The image runs as an unprivileged user, keeps state on the `/data` volume, and answers
`GET /api/community/health` for the platform's health check.

**Plain Node 22 (a VPS, a Pi, a laptop under a tunnel):**

```bash
npm ci --omit=dev
NODE_ENV=production npm start
```

Put it behind whatever gives you HTTPS: Caddy (`reverse_proxy localhost:3000` and it
fetches the certificate itself), nginx with certbot, Cloudflare Tunnel, or the platform's
own edge.

## 4. The first five minutes after it is up

1. Open `/`. Sign up with the handle you put in `COMMUNITY_MODERATORS`.
2. Confirm your email — this is the first live send. If the code does not arrive, the
   provider's dashboard shows the attempt and the server log shows the response
   status (never the body, never the key). A failed send never fails a sign-up: the
   account exists, the person is signed in, and **Send me a code** on their page
   tries again.
3. You are a moderator: the **Reports** tab is there. Ask for an identity check on your
   own page and approve it, so there is one checked professional to start with.
4. Open `/welcome/` on a phone and add it to the home screen.

## 5. Backups and moving house

The whole community is one file. Copy it.

```bash
docker cp commons:/data/community.json backup-$(date +%F).json
```

Writes are atomic (temp file then rename), so a copy taken at any moment is a valid
file. To move to another host, stop the old one, copy the file, start the new one with
the same `COMMUNITY_DATA` path.

## 6. What this setup is honest about

- One process, one file. Correct and durable for a single instance; it does not survive
  two, and it will not stay fast past tens of thousands of posts. `CommunityStore` is the
  seam for Postgres when that day comes.
- The `Dockerfile` has not been built where this was written (no Docker daemon in the
  build container). Its exact file set was copied out, installed with production
  dependencies only, booted under `NODE_ENV=production` with a provider configured,
  and served every page and asset with state written to the data path — everything
  except the base image itself. The first `docker build` is the last check.
- No email or SMS provider has been exercised from a build container (no outbound
  network there). Step 4.2 is the first live send. The adapters are tested against a
  stub for request shape, auth, retries and timeouts.
- Identity checking is a moderator seeing a document in person. Fine for a street; the
  queue is the bottleneck for a city.
