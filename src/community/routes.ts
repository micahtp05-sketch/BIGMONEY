import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SESSION_TTL_MS,
  SESSION_COOKIE,
  clearSessionCookie,
  hashPassword,
  newSessionToken,
  parseCookies,
  serializeSessionCookie,
  validateHandle,
  validatePassword,
  verifyPassword,
} from './auth.ts';
import { EventBus } from './events.ts';
import { RateLimiter } from './ratelimit.ts';
import { SEED_CHANNELS } from './seed.ts';
import {
  type CodeSender,
  ConsoleSender,
  checkCode,
  issueCode,
  validateEmail,
  validatePhone,
} from './verify.ts';
import { CommunityStore, publicUser } from './store.ts';
import type { MeetupMessage, ModerationCase, ReportTarget, Reply, Review, Thread, User } from './types.ts';
import { replyView, reviewView, summarise, threadView } from './views.ts';

/** Reports from this many distinct members hide content pending review. */
const HIDE_AFTER_REPORTS = 3;
/** One nudge per person per day — a wave should never become a way to pester. */
const WAVE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE = 50;

const textField = (max: number) => z.string().trim().min(1).max(max);
const tagsField = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(8).optional();

const signupSchema = z.object({
  handle: z.string(),
  displayName: z.string().trim().min(1).max(60).optional(),
  email: z.string(),
  phone: z.string(),
  password: z.string(),
});

const meetupSchema = z.object({
  startsAt: z.number().int().positive(),
  capacity: z.number().int().min(0).max(500).default(0),
});

const estimateSchema = z.object({
  title: textField(160),
  estimateCents: z.number().int().nonnegative().nullable(),
  lowCents: z.number().int().nonnegative().nullable(),
  highCents: z.number().int().nonnegative().nullable(),
  currency: z.string().trim().length(3).default('USD'),
  confidence: z.number().min(0).max(1).default(0),
  sampleSize: z.number().int().nonnegative().default(0),
});

const threadSchema = z.object({
  title: textField(140),
  body: textField(8000),
  tags: tagsField,
  meetup: meetupSchema.optional(),
  estimate: estimateSchema.optional(),
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(500).optional(),
  neighborhood: z.string().trim().max(80).optional(),
  skills: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(12).optional(),
  openToChat: z.boolean().optional(),
  trade: z.string().trim().max(60).optional(),
  worksInTrade: z.boolean().optional(),
});

const reviewSchema = z.object({
  kind: z.enum(['helped', 'hired']),
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(2000),
  /** Required for a `helped` review — it is what makes it checkable. */
  threadId: z.string().optional(),
});

export interface CommunityOptions {
  /** JSON file to persist to, or null for in-memory (tests). */
  dataPath?: string | null;
  store?: CommunityStore;
  bus?: EventBus;
  /**
   * New accounts allowed per hour from one IP. The default is deliberately
   * low, but a whole street behind one NAT — or a test suite — needs it
   * raised, so it is a knob rather than a constant.
   */
  signupsPerHourPerIp?: number;
  /** Handles that are moderators from the start. */
  moderators?: string[];
  /** How one-time codes reach people. Defaults to logging them to the console. */
  sender?: CodeSender;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Every Commons route. Registered under a prefix by the caller, so the plugin
 * itself never hardcodes where it lives.
 */
export function communityRoutes(options: CommunityOptions = {}) {
  const store = options.store ?? new CommunityStore(options.dataPath ?? null);
  const bus = options.bus ?? new EventBus();
  const limiter = new RateLimiter();
  const signupsPerHour = options.signupsPerHourPerIp ?? 5;
  // Somebody has to be able to rule on the first report, and there is no way
  // to appoint them from inside an empty instance.
  const sender = options.sender ?? new ConsoleSender();
  const seededModerators = new Set((options.moderators ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));

  // A fresh instance opens with somewhere to post rather than a blank page.
  if (store.channels.size === 0) {
    for (const seed of SEED_CHANNELS) store.addChannel({ ...seed, createdBy: null });
  }
  for (const handle of seededModerators) {
    const existing = store.userByHandle(handle);
    if (existing && existing.role !== 'moderator') {
      existing.role = 'moderator';
      store.touch();
    }
  }

  return async function plugin(app: FastifyInstance): Promise<void> {
    // ------------------------------------------------------------- helpers

    /** The signed-in user, or null. Also refreshes their last-seen stamp. */
    function viewer(request: FastifyRequest): User | null {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (!token) return null;
      const user = store.userForSession(token);
      if (!user) return null;
      // Coarse stamp: only write when it moves by more than a minute.
      if (Date.now() - user.lastSeenAt > 60_000) {
        user.lastSeenAt = Date.now();
        store.touch();
      }
      return user;
    }

    function requireUser(request: FastifyRequest): User {
      const user = viewer(request);
      if (!user) throw new HttpError(401, 'Sign in to do that.');
      return user;
    }

    /**
     * Offering help means a real person has to be behind the account.
     *
     * Deliberately one-sided. Asking a question, chatting, saying you are
     * coming to something — none of that needs an identity check, because the
     * people who most need this site are the least likely to have a passport
     * to hand. Answering in a help category, listing a trade, or hosting a
     * get-together does, because those are the ways somebody could do harm.
     */
    function requireVerifiedHelper(user: User, doing: string): void {
      if (user.identity !== null) return;
      throw new HttpError(
        403,
        `Your identity has to be checked before you can ${doing}. Ask for a check on your own page.`,
      );
    }

    function limit(user: User, action: string, max: number, windowMs: number): void {
      if (!limiter.allow(`${user.id}:${action}`, max, windowMs)) {
        throw new HttpError(429, 'You are doing that too quickly. Give it a minute.');
      }
    }

    function channelOr404(slug: string) {
      const channel = store.channelBySlug(slug);
      if (!channel) throw new HttpError(404, 'No such channel.');
      return channel;
    }

    function threadOr404(id: string): Thread {
      const thread = store.threads.get(id);
      if (!thread || thread.deletedAt !== null) throw new HttpError(404, 'No such thread.');
      return thread;
    }

    function replyOr404(id: string): Reply {
      const reply = store.replies.get(id);
      if (!reply || reply.deletedAt !== null) throw new HttpError(404, 'No such reply.');
      return reply;
    }

    type Reportable = Thread | Reply | MeetupMessage | Review;

    /**
     * Record a report, and hide the content once enough distinct people agree.
     *
     * Two things are new next to a bare count. The reason is kept, so a
     * moderator can see what people objected to rather than only that they
     * did. And a piece of content a moderator has already kept is never
     * auto-hidden again — otherwise the same three people could re-report
     * their way straight back to the outcome a moderator just overturned.
     */
    function report(
      kind: ReportTarget,
      target: Reportable,
      reporterId: string,
      reason: string,
    ): boolean {
      const id = CommunityStore.caseId(kind, target.id);
      const existing = store.moderationCase(kind, target.id);
      const record: ModerationCase = existing ?? {
        id,
        kind,
        targetId: target.id,
        authorId: target.authorId,
        reports: [],
        appeal: null,
        appealAt: null,
        decision: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: '',
      };
      if (!record.reports.some((r) => r.reporterId === reporterId)) {
        record.reports.push({ reporterId, reason, createdAt: Date.now() });
      }
      store.putModerationCase(record);

      if (!target.reportedBy.includes(reporterId)) target.reportedBy.push(reporterId);
      if (record.decision === null && target.reportedBy.length >= HIDE_AFTER_REPORTS) {
        target.hidden = true;
      }
      store.touch();
      return target.hidden;
    }

    // Turn thrown HttpErrors and zod failures into clean JSON, so no route
    // needs its own try/catch around validation.
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof HttpError) {
        return reply.code(error.status).send({ error: error.message });
      }
      if (error instanceof z.ZodError) {
        const first = error.issues[0];
        const where = first?.path.join('.') ?? 'request';
        return reply.code(400).send({ error: `${where}: ${first?.message ?? 'invalid input'}` });
      }
      request.log.error({ err: error }, 'community route failed');
      // Fastify's own errors (bad JSON, payload too large) carry a status code.
      const carried = (error as { statusCode?: unknown }).statusCode;
      const status = typeof carried === 'number' ? carried : 500;
      const message = error instanceof Error ? error.message : 'Request failed.';
      return reply
        .code(status)
        .send({ error: status >= 500 ? 'Something went wrong on our end.' : message });
    });

    // ---------------------------------------------------------------- auth

    app.post('/auth/signup', async (request, reply) => {
      const ip = request.ip ?? 'unknown';
      if (!limiter.allow(`signup:${ip}`, signupsPerHour, 60 * 60 * 1000)) {
        throw new HttpError(429, 'Too many accounts from this address. Try again later.');
      }
      const input = signupSchema.parse(request.body);
      const handleError = validateHandle(input.handle);
      if (handleError) throw new HttpError(400, handleError);
      const passwordError = validatePassword(input.password);
      if (passwordError) throw new HttpError(400, passwordError);
      const emailError = validateEmail(input.email);
      if (emailError) throw new HttpError(400, emailError);
      const phoneError = validatePhone(input.phone);
      if (phoneError) throw new HttpError(400, phoneError);

      if (store.userByHandle(input.handle)) throw new HttpError(409, 'That username is taken.');
      // One account per address and per number, which is most of what stops a
      // spammer opening fifty of them.
      if (store.userByEmail(input.email)) throw new HttpError(409, 'There is already an account with that email address.');
      if (store.userByPhone(input.phone)) throw new HttpError(409, 'There is already an account with that phone number.');

      const credential = await hashPassword(input.password);
      const user = store.createUser({
        handle: input.handle,
        displayName: input.displayName?.trim() || input.handle.trim(),
        email: input.email,
        phone: input.phone,
        credential,
      });
      await issueCode(store, sender, user.id, 'email', user.email);
      await issueCode(store, sender, user.id, 'phone', user.phone);
      if (seededModerators.has(user.handle)) {
        user.role = 'moderator';
        store.touch();
      }
      return sendSession(reply, user);
    });

    app.post('/auth/login', async (request, reply) => {
      const input = z.object({ handle: z.string(), password: z.string() }).parse(request.body);
      const ip = request.ip ?? 'unknown';
      if (!limiter.allow(`login:${ip}`, 20, 15 * 60 * 1000)) {
        throw new HttpError(429, 'Too many attempts. Wait a few minutes.');
      }
      const user = store.userByHandle(input.handle);
      const credential = user ? store.credentialFor(user.id) : undefined;
      // Same message either way: never reveal which handles exist.
      const invalid = new HttpError(401, 'Handle or password is incorrect.');
      if (!user || !credential) throw invalid;
      if (!(await verifyPassword(input.password, credential))) throw invalid;
      return sendSession(reply, user);
    });

    function sendSession(reply: FastifyReply, user: User) {
      const token = newSessionToken();
      store.createSession(user.id, token, SESSION_TTL_MS);
      return reply
        .header('set-cookie', serializeSessionCookie(token, SESSION_TTL_MS / 1000))
        .send({ user: publicUser(user) });
    }

    app.post('/auth/logout', async (request, reply) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) store.deleteSession(token);
      return reply.header('set-cookie', clearSessionCookie()).send({ ok: true });
    });

    app.get('/me', async (request) => {
      const user = viewer(request);
      return {
        user: user ? publicUser(user) : null,
        unreadMessages: user ? store.unreadMeetupMessages(user.id) : 0,
        queueSize: user?.role === 'moderator' ? store.openCases().length : 0,
        // Only the account's owner ever sees these, and only about themselves.
        account: user
          ? {
              email: user.email,
              phone: user.phone,
              emailVerified: user.emailVerifiedAt !== null,
              phoneVerified: user.phoneVerifiedAt !== null,
              identityVerified: user.identity !== null,
              identityRequest: store.identityRequests.get(user.id) ?? null,
            }
          : null,
      };
    });

    app.patch('/me', async (request) => {
      const user = requireUser(request);
      const input = profileSchema.parse(request.body);
      if (input.displayName !== undefined) user.displayName = input.displayName;
      if (input.bio !== undefined) user.bio = input.bio;
      if (input.neighborhood !== undefined) user.neighborhood = input.neighborhood;
      if (input.skills !== undefined) user.skills = [...new Set(input.skills)];
      if (input.trade !== undefined || input.worksInTrade !== undefined) {
        const wantsListing = (input.trade ?? user.trade).length > 0 || (input.worksInTrade ?? user.worksInTrade);
        if (wantsListing) requireVerifiedHelper(user, 'list a trade');
      }
      if (input.trade !== undefined) user.trade = input.trade;
      if (input.worksInTrade !== undefined) user.worksInTrade = input.worksInTrade;
      if (input.openToChat !== undefined && input.openToChat !== user.openToChat) {
        user.openToChat = input.openToChat;
        bus.publish({ type: 'presence.changed', userId: user.id, openToChat: user.openToChat });
      }
      store.touch();
      return { user: publicUser(user) };
    });

    // -------------------------------------------------- contact verification

    app.post('/auth/send-code', async (request) => {
      const user = requireUser(request);
      const input = z.object({ channel: z.enum(['email', 'phone']) }).parse(request.body);
      limit(user, `code-${input.channel}`, 5, 60 * 60 * 1000);
      await issueCode(store, sender, user.id, input.channel, input.channel === 'email' ? user.email : user.phone);
      return { ok: true, sentTo: input.channel === 'email' ? user.email : user.phone };
    });

    app.post('/auth/confirm-code', async (request) => {
      const user = requireUser(request);
      const input = z.object({ channel: z.enum(['email', 'phone']), code: z.string() }).parse(request.body);
      const result = await checkCode(store, user.id, input.channel, input.code);
      if (result === 'ok') {
        if (input.channel === 'email') user.emailVerifiedAt = Date.now();
        else user.phoneVerifiedAt = Date.now();
        store.touch();
        return { ok: true };
      }
      const messages = {
        wrong: 'That code is not right.',
        expired: 'That code has run out. Ask for a new one.',
        none: 'Ask for a code first.',
        'too-many': 'Too many tries. Ask for a new code.',
      } as const;
      throw new HttpError(400, messages[result]);
    });

    /** Forgotten passwords, now that there is an address to send to. */
    app.post('/auth/forgot', async (request) => {
      const input = z.object({ email: z.string() }).parse(request.body);
      const ip = request.ip ?? 'unknown';
      if (!limiter.allow(`forgot:${ip}`, 10, 60 * 60 * 1000)) {
        throw new HttpError(429, 'Too many attempts. Wait a while.');
      }
      const user = store.userByEmail(input.email);
      // Always the same answer, so this cannot be used to find out who is here.
      if (user) await issueCode(store, sender, user.id, 'reset', user.email);
      return { ok: true };
    });

    app.post('/auth/reset', async (request, reply) => {
      const input = z
        .object({ email: z.string(), code: z.string(), password: z.string() })
        .parse(request.body);
      const passwordError = validatePassword(input.password);
      if (passwordError) throw new HttpError(400, passwordError);
      const user = store.userByEmail(input.email);
      const invalid = new HttpError(400, 'That code is not right, or it has run out.');
      if (!user) throw invalid;

      const result = await checkCode(store, user.id, 'reset', input.code);
      if (result !== 'ok') throw invalid;

      const credential = await hashPassword(input.password);
      store.setCredential(user.id, credential);
      // Anybody signed in as them elsewhere is signed out.
      store.dropSessionsFor(user.id);
      return sendSession(reply, user);
    });

    // ---------------------------------------------------- identity checking

    app.post('/identity/request', async (request) => {
      const user = requireUser(request);
      if (user.identity) throw new HttpError(409, 'You are already verified.');
      const input = z.object({ note: z.string().trim().min(1).max(500) }).parse(request.body);
      const existing = store.identityRequests.get(user.id);
      if (existing && existing.outcome === null) {
        throw new HttpError(409, 'We are already looking at your request.');
      }
      store.identityRequests.set(user.id, {
        userId: user.id,
        note: input.note,
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        outcome: null,
        refusedReason: '',
      });
      store.touch();
      return { ok: true };
    });

    app.get('/identity/queue', async (request) => {
      requireModerator(request);
      const waiting = [...store.identityRequests.values()]
        .filter((r) => r.outcome === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => {
          const person = store.users.get(r.userId);
          return {
            user: person ? publicUser(person) : null,
            note: r.note,
            createdAt: r.createdAt,
            // A moderator needs to know these are real before vouching for the person.
            contactVerified: person
              ? { email: person.emailVerifiedAt !== null, phone: person.phoneVerifiedAt !== null }
              : null,
          };
        })
        .filter((r) => r.user !== null);
      return { requests: waiting };
    });

    app.post('/identity/:handle/decide', async (request) => {
      const moderator = requireModerator(request);
      const { handle } = z.object({ handle: z.string() }).parse(request.params);
      const input = z
        .object({
          outcome: z.enum(['verified', 'refused']),
          method: z.string().trim().max(120).optional(),
          reference: z.string().trim().max(120).optional(),
          reason: z.string().trim().max(500).optional(),
        })
        .parse(request.body);

      const person = store.userByHandle(handle);
      if (!person) throw new HttpError(404, 'No such member.');
      const record = store.identityRequests.get(person.id);
      if (!record) throw new HttpError(404, 'They have not asked to be verified.');

      record.outcome = input.outcome;
      record.decidedAt = Date.now();
      record.decidedBy = moderator.id;
      record.refusedReason = input.outcome === 'refused' ? (input.reason ?? '') : '';

      if (input.outcome === 'verified') {
        // The outcome is recorded. The document is not, was not uploaded, and
        // is not wanted — only that a person confirmed it, how, and when.
        person.identity = {
          verifiedAt: Date.now(),
          method: input.method?.trim() || 'checked by a moderator',
          reference: input.reference?.trim() || '',
          checkedBy: moderator.id,
        };
      } else {
        person.identity = null;
      }
      store.touch();
      return { user: publicUser(person) };
    });

    // ------------------------------------------------------------ channels

    app.get('/channels', async (request) => {
      const me = viewer(request);
      const channels = [...store.channels.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((channel) => {
          const threads = store.threadsIn(channel.id);
          const claimed = new Set((me?.skills ?? []).map((s) => s.toLowerCase()));
          return {
            ...channel,
            threadCount: threads.length,
            lastActiveAt: threads[0]?.updatedAt ?? channel.createdAt,
            /** Surfaces "you know about this" without ranking people. */
            matchesYourSkills: channel.topics.some((t) => claimed.has(t.toLowerCase())),
          };
        });
      return { channels };
    });

    app.post('/channels', async (request) => {
      const user = requireUser(request);
      limit(user, 'channel', 3, 24 * 60 * 60 * 1000);
      const input = z
        .object({
          name: textField(60),
          kind: z.enum(['help', 'group', 'social']),
          description: textField(280),
          topics: tagsField,
        })
        .parse(request.body);

      const slug = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      if (!slug) throw new HttpError(400, 'Give the channel a name with letters or numbers in it.');
      if (store.channelBySlug(slug)) throw new HttpError(409, 'A channel with that name exists.');

      const channel = store.addChannel({
        slug,
        name: input.name,
        kind: input.kind,
        description: input.description,
        topics: input.topics ?? [],
        createdBy: user.id,
      });
      return { channel };
    });

    app.get('/channels/:slug', async (request) => {
      const { slug } = z.object({ slug: z.string() }).parse(request.params);
      const me = viewer(request);
      const channel = channelOr404(slug);
      const threads = store
        .threadsIn(channel.id)
        .slice(0, MAX_PAGE)
        .map((t) => threadView(store, t, me?.id ?? null));
      return { channel, threads };
    });

    // ------------------------------------------------------------- threads

    app.post('/channels/:slug/threads', async (request, reply) => {
      const user = requireUser(request);
      limit(user, 'thread', 10, 60 * 60 * 1000);
      const { slug } = z.object({ slug: z.string() }).parse(request.params);
      const channel = channelOr404(slug);
      const input = threadSchema.parse(request.body);

      if (input.meetup && channel.kind === 'help') {
        throw new HttpError(400, 'Meetups belong in a group or social channel.');
      }
      if (input.meetup && input.meetup.startsAt < Date.now() - 60_000) {
        throw new HttpError(400, 'That meetup time is already in the past.');
      }
      if (input.meetup) requireVerifiedHelper(user, 'host a get-together');

      const now = Date.now();
      const thread = store.addThread({
        id: randomUUID(),
        channelId: channel.id,
        authorId: user.id,
        title: input.title,
        body: input.body,
        tags: [...new Set(input.tags ?? [])],
        createdAt: now,
        updatedAt: now,
        replyCount: 0,
        acceptedReplyId: null,
        meetup: input.meetup ? { ...input.meetup, rsvps: [user.id] } : null,
        estimate: input.estimate ?? null,
        reportedBy: [],
        hidden: false,
        deletedAt: null,
      });
      bus.publish({ type: 'thread.created', channelId: channel.id, threadId: thread.id });
      return reply.code(201).send({ thread: threadView(store, thread, user.id) });
    });

    app.get('/threads/:id', async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const me = viewer(request);
      const thread = threadOr404(id);
      if (thread.hidden && thread.authorId !== me?.id) {
        throw new HttpError(404, 'No such thread.');
      }
      const replies = store.repliesOn(thread.id).map((r) => replyView(store, r, thread, me?.id ?? null));
      // Accepted answer first: the person who arrives with the same problem
      // should not have to read the whole thread to find what worked.
      replies.sort((a, b) => Number(b.accepted) - Number(a.accepted) || a.createdAt - b.createdAt);
      const rsvps = (thread.meetup?.rsvps ?? [])
        .map((uid) => store.users.get(uid))
        .filter((u): u is User => u !== undefined)
        .map(publicUser);
      return { thread: threadView(store, thread, me?.id ?? null), replies, rsvps };
    });

    app.delete('/threads/:id', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const thread = threadOr404(id);
      if (thread.authorId !== user.id) throw new HttpError(403, 'That is not yours to delete.');
      thread.deletedAt = Date.now();
      store.touch();
      bus.publish({ type: 'thread.updated', channelId: thread.channelId, threadId: thread.id });
      return { ok: true };
    });

    // ------------------------------------------------------------- replies

    app.post('/threads/:id/replies', async (request, reply) => {
      const user = requireUser(request);
      limit(user, 'reply', 60, 60 * 60 * 1000);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z.object({ body: textField(8000) }).parse(request.body);
      const thread = threadOr404(id);
      if (thread.hidden) throw new HttpError(403, 'This thread is under review.');
      const channel = store.channels.get(thread.channelId);
      if (channel?.kind === 'help') requireVerifiedHelper(user, 'answer questions');

      const created = store.addReply({
        id: randomUUID(),
        threadId: thread.id,
        authorId: user.id,
        body: input.body,
        createdAt: Date.now(),
        helpfulBy: [],
        reportedBy: [],
        hidden: false,
        deletedAt: null,
      });
      thread.replyCount += 1;
      thread.updatedAt = created.createdAt;
      store.touch();
      bus.publish({
        type: 'reply.created',
        channelId: thread.channelId,
        threadId: thread.id,
        replyId: created.id,
      });
      return reply.code(201).send({ reply: replyView(store, created, thread, user.id) });
    });

    app.post('/replies/:id/helpful', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = replyOr404(id);
      if (target.authorId === user.id) throw new HttpError(400, 'You cannot vote for yourself.');
      const at = target.helpfulBy.indexOf(user.id);
      if (at === -1) target.helpfulBy.push(user.id);
      else target.helpfulBy.splice(at, 1);
      store.touch();
      const thread = store.threads.get(target.threadId);
      if (thread) {
        bus.publish({ type: 'thread.updated', channelId: thread.channelId, threadId: thread.id });
      }
      return { helpfulCount: target.helpfulBy.length, viewerFoundHelpful: at === -1 };
    });

    app.delete('/replies/:id', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = replyOr404(id);
      if (target.authorId !== user.id) throw new HttpError(403, 'That is not yours to delete.');
      target.deletedAt = Date.now();
      const thread = store.threads.get(target.threadId);
      if (thread) {
        thread.replyCount = Math.max(0, thread.replyCount - 1);
        if (thread.acceptedReplyId === target.id) thread.acceptedReplyId = null;
      }
      store.touch();
      return { ok: true };
    });

    /** The thread author marks the reply that actually solved it. */
    app.post('/threads/:id/accept', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z.object({ replyId: z.string().nullable() }).parse(request.body);
      const thread = threadOr404(id);
      if (thread.authorId !== user.id) {
        throw new HttpError(403, 'Only the person who asked can mark the answer.');
      }

      // Credit follows the mark, so un-accepting takes the point back.
      const previous = thread.acceptedReplyId ? store.replies.get(thread.acceptedReplyId) : undefined;
      if (previous) {
        const author = store.users.get(previous.authorId);
        if (author) author.helpfulCount = Math.max(0, author.helpfulCount - 1);
      }

      if (input.replyId === null) {
        thread.acceptedReplyId = null;
      } else {
        const target = replyOr404(input.replyId);
        if (target.threadId !== thread.id) throw new HttpError(400, 'That reply is on another thread.');
        thread.acceptedReplyId = target.id;
        const author = store.users.get(target.authorId);
        if (author && author.id !== user.id) author.helpfulCount += 1;
      }
      store.touch();
      bus.publish({ type: 'thread.updated', channelId: thread.channelId, threadId: thread.id });
      return { acceptedReplyId: thread.acceptedReplyId };
    });

    // ------------------------------------------------------------- meetups

    app.post('/threads/:id/rsvp', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const thread = threadOr404(id);
      const meetup = thread.meetup;
      if (!meetup) throw new HttpError(400, 'That thread is not a meetup.');

      const at = meetup.rsvps.indexOf(user.id);
      if (at === -1) meetup.rsvps.push(user.id);
      else meetup.rsvps.splice(at, 1);
      store.touch();
      bus.publish({ type: 'thread.updated', channelId: thread.channelId, threadId: thread.id });

      const going = meetup.rsvps.length;
      return {
        going,
        viewerRsvpd: at === -1,
        // Past capacity people are on a waitlist rather than turned away.
        waitlisted: meetup.capacity > 0 && at === -1 && going > meetup.capacity,
      };
    });

    // ------------------------------------------------- meetup message channels

    /**
     * Resolve and authorise one private channel.
     *
     * A channel is a (meetup, guest) pair with exactly two people in it. The
     * host may open any of their guests' channels; anybody else may only open
     * their own. Reading is allowed on identity alone, so that a cancelled
     * guest keeps the history they may need in order to report it; sending
     * additionally requires that the guest is currently coming.
     */
    function channelFor(thread: Thread, user: User, guestParam?: string) {
      if (!thread.meetup) throw new HttpError(400, 'That post is not a get-together.');
      const hostId = thread.authorId;

      if (user.id === hostId) {
        if (!guestParam) throw new HttpError(400, 'Say which guest you mean.');
        if (guestParam === hostId) throw new HttpError(400, 'You cannot message yourself.');
        return { hostId, guestId: guestParam };
      }
      // Not the host: the only channel that can be theirs is their own, and
      // naming somebody else must not reveal whether that channel exists.
      if (guestParam && guestParam !== user.id) {
        throw new HttpError(403, 'That is not your conversation.');
      }
      return { hostId, guestId: user.id };
    }

    const isComing = (thread: Thread, userId: string) =>
      thread.meetup?.rsvps.includes(userId) ?? false;

    function messageView(message: MeetupMessage, viewerId: string) {
      const author = store.users.get(message.authorId);
      return {
        id: message.id,
        body: message.body,
        createdAt: message.createdAt,
        author: author ? publicUser(author) : null,
        viewerIsAuthor: message.authorId === viewerId,
      };
    }

    /** One conversation: the guest's own, or the one the host asked for. */
    app.get('/threads/:id/messages', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z.object({ guest: z.string().optional() }).parse(request.query);
      const thread = threadOr404(id);
      const { hostId, guestId } = channelFor(thread, user, query.guest);

      // Somebody who never came and never wrote has no conversation to see.
      if (user.id !== hostId && !isComing(thread, user.id)) {
        const existing = store.meetupMessagesIn(thread.id, guestId);
        if (existing.length === 0) throw new HttpError(403, 'Say you are coming first.');
      }

      const messages = store.meetupMessagesIn(thread.id, guestId);
      // Mark the other side's messages read on the way out.
      let touched = false;
      for (const m of messages) {
        if (m.authorId !== user.id && m.readAt === null) { m.readAt = Date.now(); touched = true; }
      }
      if (touched) store.touch();

      const host = store.users.get(hostId);
      const guest = store.users.get(guestId);
      return {
        threadId: thread.id,
        host: host ? publicUser(host) : null,
        guest: guest ? publicUser(guest) : null,
        viewerIsHost: user.id === hostId,
        guestIsComing: isComing(thread, guestId),
        messages: messages.map((m) => messageView(m, user.id)),
      };
    });

    app.post('/threads/:id/messages', async (request, reply) => {
      const user = requireUser(request);
      limit(user, 'message', 120, 60 * 60 * 1000);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z.object({ body: textField(4000), guest: z.string().optional() }).parse(request.body);
      const thread = threadOr404(id);
      if (thread.hidden) throw new HttpError(403, 'This get-together is under review.');
      const { hostId, guestId } = channelFor(thread, user, input.guest);

      // Sending needs a live channel: the guest has to actually be coming.
      if (!isComing(thread, guestId)) {
        throw new HttpError(403, user.id === hostId
          ? 'They are not coming any more.'
          : 'Say you are coming first.');
      }

      const message = store.addMeetupMessage({
        id: randomUUID(),
        threadId: thread.id,
        hostId,
        guestId,
        authorId: user.id,
        body: input.body,
        createdAt: Date.now(),
        readAt: null,
        reportedBy: [],
        hidden: false,
      });
      bus.publish({
        type: 'meetup.message',
        threadId: thread.id,
        toUserId: user.id === hostId ? guestId : hostId,
      });
      return reply.code(201).send({ message: messageView(message, user.id) });
    });

    /** The host's list of conversations — one per person coming. */
    app.get('/threads/:id/message-channels', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const thread = threadOr404(id);
      if (!thread.meetup) throw new HttpError(400, 'That post is not a get-together.');
      if (thread.authorId !== user.id) throw new HttpError(403, 'Only the host can see this.');

      const channels = thread.meetup.rsvps
        .filter((guestId) => guestId !== user.id)
        .map((guestId) => {
          const guest = store.users.get(guestId);
          const messages = store.meetupMessagesIn(thread.id, guestId);
          const last = messages[messages.length - 1];
          return {
            guest: guest ? publicUser(guest) : null,
            count: messages.length,
            lastAt: last?.createdAt ?? null,
            unread: messages.filter((m) => m.authorId !== user.id && m.readAt === null).length,
          };
        })
        .filter((c) => c.guest !== null);
      return { channels };
    });

    /** Upcoming meetups across every channel — the "what's on" view. */
    app.get('/meetups', async (request) => {
      const me = viewer(request);
      const now = Date.now();
      const upcoming = [...store.threads.values()]
        .filter((t) => t.meetup !== null && !t.hidden && t.deletedAt === null && t.meetup.startsAt >= now)
        .sort((a, b) => (a.meetup?.startsAt ?? 0) - (b.meetup?.startsAt ?? 0))
        .slice(0, MAX_PAGE)
        .map((t) => threadView(store, t, me?.id ?? null));
      return { meetups: upcoming };
    });

    // -------------------------------------------------------------- people

    app.get('/people', async (request) => {
      const me = viewer(request);
      const query = z
        .object({ skill: z.string().optional(), open: z.string().optional(), trade: z.string().optional() })
        .parse(request.query);
      const skill = query.skill?.trim().toLowerCase();
      const trade = query.trade?.trim().toLowerCase();
      const people = [...store.users.values()]
        .filter((u) => (query.open === '1' ? u.openToChat : true))
        .filter((u) => (query.trade !== undefined ? u.worksInTrade : true))
        .filter((u) => (skill ? u.skills.some((s) => s.toLowerCase() === skill) : true))
        .filter((u) => (trade ? u.trade.toLowerCase().includes(trade) : true))
        .map((u) => ({ ...publicUser(u), reviews: summarise(store.reviewsOf(u.id)) }))
        // Well-reviewed people first, so somebody looking for help finds them.
        // Nobody with no reviews is buried by this: they come back unranked and
        // the client gives them their own section, or there is no way in.
        .sort((a, b) => {
          const byScore = (b.reviews.score ?? -1) - (a.reviews.score ?? -1);
          if (byScore !== 0) return byScore;
          if (b.reviews.count !== a.reviews.count) return b.reviews.count - a.reviews.count;
          return b.lastSeenAt - a.lastSeenAt;
        })
        .slice(0, 100);
      return { people, viewerId: me?.id ?? null };
    });

    app.get('/people/:handle', async (request) => {
      const { handle } = z.object({ handle: z.string() }).parse(request.params);
      const me = viewer(request);
      const user = store.userByHandle(handle);
      if (!user) throw new HttpError(404, 'No such member.');
      const threads = [...store.threads.values()]
        .filter((t) => t.authorId === user.id && !t.hidden && t.deletedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((t) => threadView(store, t, me?.id ?? null));
      const reviews = store.reviewsOf(user.id);
      return {
        user: publicUser(user),
        threads,
        summary: summarise(reviews),
        reviews: reviews.slice(0, 20).map((r) => reviewView(store, r, me?.id ?? null)),
      };
    });

    // -------------------------------------------------------------- reviews

    /**
     * Did the thing a `helped` review describes actually happen here?
     *
     * Two shapes count, and both are visible in the data: the subject answered
     * a question the reviewer asked, or the subject hosted a get-together the
     * reviewer said they were coming to. Anything else is not a `helped`
     * review, whatever the person writing it believes.
     */
    function helpedMe(threadId: string, subjectId: string, reviewerId: string): boolean {
      const thread = store.threads.get(threadId);
      if (!thread || thread.deletedAt !== null) return false;

      if (thread.authorId === reviewerId) {
        return store.repliesOn(thread.id).some((r) => r.authorId === subjectId);
      }
      if (thread.authorId === subjectId && thread.meetup) {
        return thread.meetup.rsvps.includes(reviewerId);
      }
      return false;
    }

    app.get('/people/:handle/reviews', async (request) => {
      const { handle } = z.object({ handle: z.string() }).parse(request.params);
      const me = viewer(request);
      const subject = store.userByHandle(handle);
      if (!subject) throw new HttpError(404, 'No such member.');

      const reviews = store.reviewsOf(subject.id);
      return {
        subject: publicUser(subject),
        summary: summarise(reviews),
        reviews: reviews.map((r) => reviewView(store, r, me?.id ?? null)),
        viewerHasReviewed: me ? store.reviewBy(me.id, subject.id) !== undefined : false,
      };
    });

    app.post('/people/:handle/reviews', async (request, reply) => {
      const user = requireUser(request);
      limit(user, 'review', 5, 24 * 60 * 60 * 1000);
      const { handle } = z.object({ handle: z.string() }).parse(request.params);
      const input = reviewSchema.parse(request.body);
      const subject = store.userByHandle(handle);
      if (!subject) throw new HttpError(404, 'No such member.');
      if (subject.id === user.id) throw new HttpError(400, 'You cannot review yourself.');
      if (store.reviewBy(user.id, subject.id)) {
        throw new HttpError(409, 'You have already reviewed them.');
      }

      // A `helped` review has to point at the thing it is about.
      let threadId: string | null = null;
      if (input.kind === 'helped') {
        if (!input.threadId) throw new HttpError(400, 'Say which question or get-together this was.');
        if (!helpedMe(input.threadId, subject.id, user.id)) {
          throw new HttpError(
            403,
            'We can only take that as help given here if they answered your question or hosted a get-together you went to.',
          );
        }
        threadId = input.threadId;
      }

      const review = store.addReview({
        id: randomUUID(),
        subjectId: subject.id,
        authorId: user.id,
        kind: input.kind,
        rating: input.rating,
        body: input.body,
        threadId,
        createdAt: Date.now(),
        reportedBy: [],
        hidden: false,
      });
      return reply.code(201).send({ review: reviewView(store, review, user.id) });
    });

    app.delete('/reviews/:id', async (request) => {
      const user = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const review = store.reviews.get(id);
      if (!review || review.hidden) throw new HttpError(404, 'No such review.');
      if (review.authorId !== user.id) throw new HttpError(403, 'That is not yours to delete.');
      store.reviews.delete(id);
      store.touch();
      return { ok: true };
    });

    /**
     * What the signed-in person could write a `helped` review about — the
     * threads that prove it. Saves the client guessing.
     */
    app.get('/people/:handle/shared', async (request) => {
      const user = requireUser(request);
      const { handle } = z.object({ handle: z.string() }).parse(request.params);
      const subject = store.userByHandle(handle);
      if (!subject) throw new HttpError(404, 'No such member.');

      const shared = [...store.threads.values()]
        .filter((t) => !t.hidden && t.deletedAt === null)
        .filter((t) => helpedMe(t.id, subject.id, user.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
        .map((t) => ({ id: t.id, title: t.title, isMeetup: t.meetup !== null }));
      return { shared };
    });

    // --------------------------------------------------------------- waves

    app.post('/waves', async (request, reply) => {
      const user = requireUser(request);
      const input = z
        .object({ toUserId: z.string(), note: z.string().trim().max(280).optional() })
        .parse(request.body);
      if (input.toUserId === user.id) throw new HttpError(400, 'You cannot wave at yourself.');
      const target = store.users.get(input.toUserId);
      if (!target) throw new HttpError(404, 'No such member.');

      const last = store.lastWaveAt(user.id, target.id);
      if (last !== null && Date.now() - last < WAVE_COOLDOWN_MS) {
        throw new HttpError(429, 'You already waved at them today.');
      }
      const wave = store.addWave({
        id: randomUUID(),
        fromUserId: user.id,
        toUserId: target.id,
        note: input.note ?? '',
        createdAt: Date.now(),
        readAt: null,
      });
      bus.publish({ type: 'wave.sent', toUserId: target.id });
      return reply.code(201).send({ wave: { ...wave, from: publicUser(user) } });
    });

    app.get('/waves', async (request) => {
      const user = requireUser(request);
      const waves = store.wavesFor(user.id).map((w) => {
        const from = store.users.get(w.fromUserId);
        return { ...w, from: from ? publicUser(from) : null };
      });
      return { waves, unread: waves.filter((w) => w.readAt === null).length };
    });

    app.post('/waves/read', async (request) => {
      const user = requireUser(request);
      const now = Date.now();
      for (const wave of store.wavesFor(user.id)) {
        if (wave.readAt === null) wave.readAt = now;
      }
      store.touch();
      return { ok: true };
    });

    // -------------------------------------------------------------- search

    app.get('/search', async (request) => {
      const me = viewer(request);
      const { q } = z.object({ q: z.string().trim().min(1).max(120) }).parse(request.query);
      const needle = q.toLowerCase();
      const results = [...store.threads.values()]
        .filter((t) => !t.hidden && t.deletedAt === null)
        .filter(
          (t) =>
            t.title.toLowerCase().includes(needle) ||
            t.body.toLowerCase().includes(needle) ||
            t.tags.some((tag) => tag.includes(needle)),
        )
        // Title hits first — they are what somebody searching actually meant.
        .sort((a, b) => {
          const aTitle = a.title.toLowerCase().includes(needle) ? 1 : 0;
          const bTitle = b.title.toLowerCase().includes(needle) ? 1 : 0;
          return bTitle - aTitle || b.updatedAt - a.updatedAt;
        })
        .slice(0, MAX_PAGE)
        .map((t) => threadView(store, t, me?.id ?? null));
      return { results };
    });

    // ------------------------------------------------------------ reporting

    app.post('/report', async (request) => {
      const user = requireUser(request);
      limit(user, 'report', 20, 60 * 60 * 1000);
      const input = z
        .object({
          kind: z.enum(['thread', 'reply', 'message', 'review']),
          id: z.string(),
          reason: z.string().trim().max(280).optional(),
        })
        .parse(request.body);
      let target: Thread | Reply | MeetupMessage | Review;
      if (input.kind === 'thread') target = threadOr404(input.id);
      else if (input.kind === 'reply') target = replyOr404(input.id);
      else if (input.kind === 'review') {
        const review = store.reviews.get(input.id);
        if (!review || review.hidden) throw new HttpError(404, 'No such review.');
        target = review;
      } else {
        // A private message is only reportable by the person it was sent to.
        const message = store.meetupMessages.get(input.id);
        if (!message) throw new HttpError(404, 'No such message.');
        if (message.hostId !== user.id && message.guestId !== user.id) {
          throw new HttpError(403, 'That is not your message.');
        }
        target = message;
      }
      if (target.authorId === user.id) throw new HttpError(400, 'Delete your own post instead.');
      const hidden = report(input.kind, target, user.id, input.reason?.trim() ?? '');
      return { ok: true, hidden };
    });

    // ---------------------------------------------------------- moderation

    function requireModerator(request: FastifyRequest): User {
      const user = requireUser(request);
      if (user.role !== 'moderator') throw new HttpError(403, 'Only moderators can do that.');
      return user;
    }

    /** Find a reported thing by kind, whether or not it is currently hidden. */
    function targetFor(kind: ReportTarget, id: string): Reportable | undefined {
      if (kind === 'thread') {
        const t = store.threads.get(id);
        return t && t.deletedAt === null ? t : undefined;
      }
      if (kind === 'reply') {
        const r = store.replies.get(id);
        return r && r.deletedAt === null ? r : undefined;
      }
      if (kind === 'message') return store.meetupMessages.get(id);
      return store.reviews.get(id);
    }

    /** Enough of the content to rule on it, without leaking a private channel. */
    function preview(record: ModerationCase): { title: string; body: string; where: string } {
      const target = targetFor(record.kind, record.targetId);
      if (!target) return { title: 'Deleted by its author', body: '', where: record.kind };
      if (record.kind === 'thread') {
        const thread = target as Thread;
        const channel = store.channels.get(thread.channelId);
        return { title: thread.title, body: thread.body, where: channel?.name ?? 'a category' };
      }
      if (record.kind === 'reply') {
        const reply = target as Reply;
        const thread = store.threads.get(reply.threadId);
        return { title: 'An answer', body: reply.body, where: thread?.title ?? 'a post' };
      }
      if (record.kind === 'review') {
        const review = target as Review;
        const subject = store.users.get(review.subjectId);
        return {
          title: `A ${review.rating}-star review of ${subject?.displayName ?? 'somebody'}`,
          body: review.body,
          where: review.kind === 'helped' ? 'help given here' : 'paid work, unchecked',
        };
      }
      // A private message is shown only because somebody in it asked for that.
      return { title: 'A private message about a get-together', body: (target as MeetupMessage).body, where: 'private' };
    }

    function caseView(record: ModerationCase) {
      const target = targetFor(record.kind, record.targetId);
      const author = store.users.get(record.authorId);
      const decidedBy = record.decidedBy ? store.users.get(record.decidedBy) : null;
      return {
        id: record.id,
        kind: record.kind,
        targetId: record.targetId,
        author: author ? publicUser(author) : null,
        hidden: target ? target.hidden : false,
        missing: target === undefined,
        preview: preview(record),
        reports: record.reports.map((r) => {
          const reporter = store.users.get(r.reporterId);
          return {
            reason: r.reason,
            createdAt: r.createdAt,
            reporter: reporter ? publicUser(reporter) : null,
          };
        }),
        appeal: record.appeal,
        appealAt: record.appealAt,
        decision: record.decision,
        decisionReason: record.decisionReason,
        decidedAt: record.decidedAt,
        decidedBy: decidedBy ? publicUser(decidedBy) : null,
      };
    }

    app.get('/moderation/queue', async (request) => {
      requireModerator(request);
      return { cases: store.openCases().map(caseView) };
    });

    /** What has been ruled on, so decisions are visible rather than private. */
    app.get('/moderation/log', async (request) => {
      requireModerator(request);
      return { cases: store.decidedCases().slice(0, 50).map(caseView) };
    });

    app.post('/moderation/:kind/:id/decide', async (request) => {
      const moderator = requireModerator(request);
      const params = z
        .object({ kind: z.enum(['thread', 'reply', 'message', 'review']), id: z.string() })
        .parse(request.params);
      const input = z
        .object({ decision: z.enum(['kept', 'removed']), reason: z.string().trim().max(500).optional() })
        .parse(request.body);

      const record = store.moderationCase(params.kind, params.id);
      if (!record) throw new HttpError(404, 'Nothing was reported about that.');
      const target = targetFor(params.kind, params.id);

      record.decision = input.decision;
      record.decidedBy = moderator.id;
      record.decidedAt = Date.now();
      record.decisionReason = input.reason ?? '';

      if (target) {
        if (input.decision === 'kept') {
          // Put it back, and clear the reports so the count cannot creep back
          // to the threshold on the strength of the ones already cast.
          target.hidden = false;
          target.reportedBy = [];
        } else {
          target.hidden = true;
        }
      }
      store.putModerationCase(record);
      return { case: caseView(record) };
    });

    /** The author's one note back. It does not overturn anything by itself. */
    app.post('/moderation/:kind/:id/appeal', async (request) => {
      const user = requireUser(request);
      const params = z
        .object({ kind: z.enum(['thread', 'reply', 'message', 'review']), id: z.string() })
        .parse(request.params);
      const input = z.object({ note: z.string().trim().min(1).max(1000) }).parse(request.body);

      const record = store.moderationCase(params.kind, params.id);
      if (!record) throw new HttpError(404, 'Nothing was reported about that.');
      if (record.authorId !== user.id) throw new HttpError(403, 'That is not yours.');
      if (record.appeal !== null) throw new HttpError(409, 'You have already replied to this.');

      record.appeal = input.note;
      record.appealAt = Date.now();
      // A note reopens the case, so somebody looks again.
      record.decision = null;
      record.decidedBy = null;
      record.decidedAt = null;
      store.putModerationCase(record);
      return { ok: true };
    });

    /** Anything of the signed-in person's that is hidden or was reported. */
    app.get('/moderation/mine', async (request) => {
      const user = requireUser(request);
      const mine = [...store.moderation.values()]
        .filter((c) => c.authorId === user.id)
        .sort((a, b) => (b.reports[0]?.createdAt ?? 0) - (a.reports[0]?.createdAt ?? 0))
        .map((record) => {
          const target = targetFor(record.kind, record.targetId);
          return {
            kind: record.kind,
            targetId: record.targetId,
            preview: preview(record),
            hidden: target ? target.hidden : false,
            decision: record.decision,
            decisionReason: record.decisionReason,
            canAppeal: record.appeal === null,
            appeal: record.appeal,
            // Reasons are shown, reporters are not. Naming them invites reprisal.
            reasons: record.reports.map((r) => r.reason).filter(Boolean),
          };
        });
      return { mine };
    });

    app.post('/people/:handle/role', async (request) => {
      const moderator = requireModerator(request);
      const { handle } = z.object({ handle: z.string() }).parse(request.params);
      const input = z.object({ role: z.enum(['member', 'moderator']) }).parse(request.body);
      const target = store.userByHandle(handle);
      if (!target) throw new HttpError(404, 'No such member.');
      if (target.id === moderator.id) {
        throw new HttpError(400, 'Ask another moderator to change your own role.');
      }
      target.role = input.role;
      store.touch();
      return { user: publicUser(target) };
    });

    // -------------------------------------------------------------- stream

    /**
     * Live updates over SSE. Chosen over WebSockets because every event here
     * is server -> client, and SSE reconnects on its own with no extra
     * dependency and no protocol upgrade in front of proxies.
     */
    app.get('/stream', (request, reply) => {
      // Anyone may watch: every thread here is public by design. The one
      // exception is waves, which are filtered to their recipient below.
      const watcherId = viewer(request)?.id ?? null;

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');

      const unsubscribe = bus.subscribe((event) => {
        // Who waved at whom is nobody else's business, so it never leaves the
        // process on a connection that is not the recipient's.
        if (event.type === 'wave.sent' && event.toUserId !== watcherId) return;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      // Comment frames keep intermediaries from reaping an idle connection.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
      heartbeat.unref?.();

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    app.get('/health', async () => ({
      ok: true,
      channels: store.channels.size,
      members: store.users.size,
      threads: store.threads.size,
      subscribers: bus.size,
    }));
  };
}

export { CommunityStore, EventBus };
