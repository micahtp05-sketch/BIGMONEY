import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Channel,
  CommunityData,
  Credential,
  IdentityRequest,
  MeetupMessage,
  ModerationCase,
  PublicUser,
  Reply,
  Review,
  Session,
  Thread,
  User,
  VerificationCode,
  Wave,
} from './types.ts';

const EMPTY: CommunityData = {
  version: 1,
  users: [],
  credentials: [],
  sessions: [],
  channels: [],
  threads: [],
  replies: [],
  waves: [],
  meetupMessages: [],
  reviews: [],
  moderation: [],
  identityRequests: [],
  codes: [],
};

/**
 * The whole community, held in memory and mirrored to one JSON file.
 *
 * A real deployment wants Postgres. This is deliberately the smallest thing
 * that is *correct* for a single process: reads are synchronous map lookups,
 * writes mutate memory and schedule a debounced atomic file replace, so a
 * crash mid-write leaves the previous good file rather than a truncated one.
 * Pass `path: null` for a purely in-memory store (what the tests use).
 */
export class CommunityStore {
  readonly users = new Map<string, User>();
  readonly channels = new Map<string, Channel>();
  readonly threads = new Map<string, Thread>();
  readonly replies = new Map<string, Reply>();
  readonly sessions = new Map<string, Session>();
  readonly waves = new Map<string, Wave>();
  readonly meetupMessages = new Map<string, MeetupMessage>();
  readonly reviews = new Map<string, Review>();
  readonly moderation = new Map<string, ModerationCase>();
  /** userId -> their outstanding or decided identity request. */
  readonly identityRequests = new Map<string, IdentityRequest>();
  readonly codes = new Map<string, VerificationCode>();

  /** userId -> credential. */
  private readonly credentials = new Map<string, Credential>();
  /** Secondary indexes, kept in step with the maps above by the add* methods. */
  private readonly usersByHandle = new Map<string, string>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly usersByPhone = new Map<string, string>();
  private readonly channelsBySlug = new Map<string, string>();
  private readonly threadsByChannel = new Map<string, string[]>();
  private readonly repliesByThread = new Map<string, string[]>();
  /** Keyed `threadId:guestId` — one private channel per meetup per guest. */
  private readonly messagesByChannel = new Map<string, string[]>();
  private readonly reviewsBySubject = new Map<string, string[]>();

  private readonly path: string | null;
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(path: string | null) {
    this.path = path;
    if (path) this.load(path);
  }

  // ---------------------------------------------------------------- lifecycle

  private load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      // A missing file is the normal first-run case; anything else is not.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const data = { ...EMPTY, ...(JSON.parse(raw) as Partial<CommunityData>) };
    for (const u of data.users) this.indexUser(u);
    for (const c of data.credentials) this.credentials.set(c.userId, c);
    for (const s of data.sessions) this.sessions.set(s.token, s);
    for (const c of data.channels) this.indexChannel(c);
    for (const t of data.threads) this.indexThread(t);
    for (const r of data.replies) this.indexReply(r);
    for (const w of data.waves) this.waves.set(w.id, w);
    for (const m of data.meetupMessages ?? []) this.indexMeetupMessage(m);
    for (const r of data.reviews ?? []) this.indexReview(r);
    for (const c of data.moderation ?? []) this.moderation.set(c.id, c);
    for (const r of data.identityRequests ?? []) this.identityRequests.set(r.userId, r);
    for (const c of data.codes ?? []) this.codes.set(c.id, c);
  }

  /** Mark dirty and schedule a flush. Callers use this after every mutation. */
  touch(): void {
    if (!this.path) return;
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
    this.flushTimer.unref?.();
  }

  /** Write now. Safe to call when clean — it does nothing. */
  flush(): void {
    if (!this.path || !this.dirty) return;
    const data: CommunityData = {
      version: 1,
      users: [...this.users.values()],
      credentials: [...this.credentials.values()],
      sessions: [...this.sessions.values()],
      channels: [...this.channels.values()],
      threads: [...this.threads.values()],
      replies: [...this.replies.values()],
      waves: [...this.waves.values()],
      meetupMessages: [...this.meetupMessages.values()],
      reviews: [...this.reviews.values()],
      moderation: [...this.moderation.values()],
      identityRequests: [...this.identityRequests.values()],
      codes: [...this.codes.values()],
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, this.path); // atomic on the same filesystem
    this.dirty = false;
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  // -------------------------------------------------------------------- users

  private indexUser(user: User): void {
    this.users.set(user.id, user);
    this.usersByHandle.set(user.handle.toLowerCase(), user.id);
    if (user.email) this.usersByEmail.set(user.email.toLowerCase(), user.id);
    if (user.phone) this.usersByPhone.set(normalisePhone(user.phone), user.id);
  }

  userByEmail(email: string): User | undefined {
    const id = this.usersByEmail.get(email.trim().toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  userByPhone(phone: string): User | undefined {
    const id = this.usersByPhone.get(normalisePhone(phone));
    return id ? this.users.get(id) : undefined;
  }

  userByHandle(handle: string): User | undefined {
    const id = this.usersByHandle.get(handle.trim().toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  createUser(input: {
    handle: string;
    displayName: string;
    email: string;
    phone: string;
    credential: Omit<Credential, 'userId'>;
  }): User {
    const now = Date.now();
    const user: User = {
      id: randomUUID(),
      handle: input.handle.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      email: input.email.trim().toLowerCase(),
      emailVerifiedAt: null,
      phone: normalisePhone(input.phone),
      phoneVerifiedAt: null,
      identity: null,
      bio: '',
      skills: [],
      neighborhood: '',
      openToChat: false,
      role: 'member',
      trade: '',
      worksInTrade: false,
      helpfulCount: 0,
      createdAt: now,
      lastSeenAt: now,
    };
    this.indexUser(user);
    this.credentials.set(user.id, { userId: user.id, ...input.credential });
    this.touch();
    return user;
  }

  credentialFor(userId: string): Credential | undefined {
    return this.credentials.get(userId);
  }

  setCredential(userId: string, credential: Omit<Credential, 'userId'>): void {
    this.credentials.set(userId, { userId, ...credential });
    this.touch();
  }

  /** Sign somebody out everywhere — used after a password reset. */
  dropSessionsFor(userId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(token);
    }
    this.touch();
  }

  // ----------------------------------------------------------------- sessions

  createSession(userId: string, token: string, ttlMs: number): Session {
    const now = Date.now();
    const session: Session = { token, userId, createdAt: now, expiresAt: now + ttlMs };
    this.sessions.set(token, session);
    this.touch();
    return session;
  }

  /** Returns the user for a live session, sweeping the session if it expired. */
  userForSession(token: string): User | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this.touch();
      return undefined;
    }
    return this.users.get(session.userId);
  }

  deleteSession(token: string): void {
    if (this.sessions.delete(token)) this.touch();
  }

  // ----------------------------------------------------------------- channels

  private indexChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
    this.channelsBySlug.set(channel.slug, channel.id);
    if (!this.threadsByChannel.has(channel.id)) this.threadsByChannel.set(channel.id, []);
  }

  channelBySlug(slug: string): Channel | undefined {
    const id = this.channelsBySlug.get(slug.trim().toLowerCase());
    return id ? this.channels.get(id) : undefined;
  }

  addChannel(channel: Omit<Channel, 'id' | 'createdAt'> & { id?: string }): Channel {
    const full: Channel = { id: channel.id ?? randomUUID(), createdAt: Date.now(), ...channel };
    this.indexChannel(full);
    this.touch();
    return full;
  }

  // ------------------------------------------------------------------ threads

  private indexThread(thread: Thread): void {
    this.threads.set(thread.id, thread);
    const list = this.threadsByChannel.get(thread.channelId);
    if (list) list.push(thread.id);
    else this.threadsByChannel.set(thread.channelId, [thread.id]);
    if (!this.repliesByThread.has(thread.id)) this.repliesByThread.set(thread.id, []);
  }

  addThread(thread: Thread): Thread {
    this.indexThread(thread);
    this.touch();
    return thread;
  }

  /** Visible threads in a channel, most recently active first. */
  threadsIn(channelId: string): Thread[] {
    const ids = this.threadsByChannel.get(channelId) ?? [];
    const out: Thread[] = [];
    for (const id of ids) {
      const t = this.threads.get(id);
      if (t && !t.hidden && t.deletedAt === null) out.push(t);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ------------------------------------------------------------------ replies

  private indexReply(reply: Reply): void {
    this.replies.set(reply.id, reply);
    const list = this.repliesByThread.get(reply.threadId);
    if (list) list.push(reply.id);
    else this.repliesByThread.set(reply.threadId, [reply.id]);
  }

  addReply(reply: Reply): Reply {
    this.indexReply(reply);
    this.touch();
    return reply;
  }

  /** Visible replies on a thread, oldest first — a conversation reads forward. */
  repliesOn(threadId: string): Reply[] {
    const ids = this.repliesByThread.get(threadId) ?? [];
    const out: Reply[] = [];
    for (const id of ids) {
      const r = this.replies.get(id);
      if (r && !r.hidden && r.deletedAt === null) out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  // -------------------------------------------------------------------- waves

  addWave(wave: Wave): Wave {
    this.waves.set(wave.id, wave);
    this.touch();
    return wave;
  }

  wavesFor(userId: string): Wave[] {
    return [...this.waves.values()]
      .filter((w) => w.toUserId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ------------------------------------------------------------ moderation

  static caseId(kind: string, targetId: string): string {
    return `${kind}:${targetId}`;
  }

  moderationCase(kind: string, targetId: string): ModerationCase | undefined {
    return this.moderation.get(CommunityStore.caseId(kind, targetId));
  }

  putModerationCase(record: ModerationCase): ModerationCase {
    this.moderation.set(record.id, record);
    this.touch();
    return record;
  }

  /** Cases nobody has ruled on yet — the queue, oldest report first. */
  openCases(): ModerationCase[] {
    return [...this.moderation.values()]
      .filter((c) => c.decision === null && c.reports.length > 0)
      .sort((a, b) => (a.reports[0]?.createdAt ?? 0) - (b.reports[0]?.createdAt ?? 0));
  }

  /** Rulings already made, most recent first. */
  decidedCases(): ModerationCase[] {
    return [...this.moderation.values()]
      .filter((c) => c.decision !== null)
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  }

  // --------------------------------------------------------------- reviews

  private indexReview(review: Review): void {
    this.reviews.set(review.id, review);
    const list = this.reviewsBySubject.get(review.subjectId);
    if (list) list.push(review.id);
    else this.reviewsBySubject.set(review.subjectId, [review.id]);
  }

  addReview(review: Review): Review {
    this.indexReview(review);
    this.touch();
    return review;
  }

  /** Visible reviews of one member, newest first. */
  reviewsOf(subjectId: string): Review[] {
    const ids = this.reviewsBySubject.get(subjectId) ?? [];
    const out: Review[] = [];
    for (const id of ids) {
      const r = this.reviews.get(id);
      if (r && !r.hidden) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** One person gets one review of another — this finds an existing one. */
  reviewBy(authorId: string, subjectId: string): Review | undefined {
    for (const id of this.reviewsBySubject.get(subjectId) ?? []) {
      const r = this.reviews.get(id);
      if (r && r.authorId === authorId) return r;
    }
    return undefined;
  }

  // ----------------------------------------------------------- meetup chat

  /** The key for one private channel: a meetup and the guest it belongs to. */
  private static channelKey(threadId: string, guestId: string): string {
    return `${threadId}:${guestId}`;
  }

  private indexMeetupMessage(message: MeetupMessage): void {
    this.meetupMessages.set(message.id, message);
    const key = CommunityStore.channelKey(message.threadId, message.guestId);
    const list = this.messagesByChannel.get(key);
    if (list) list.push(message.id);
    else this.messagesByChannel.set(key, [message.id]);
  }

  addMeetupMessage(message: MeetupMessage): MeetupMessage {
    this.indexMeetupMessage(message);
    this.touch();
    return message;
  }

  /**
   * Every message in one host-to-guest channel, oldest first.
   *
   * Callers must have already established that the reader is the host or the
   * guest — this method does not authorise, it only looks up.
   */
  meetupMessagesIn(threadId: string, guestId: string): MeetupMessage[] {
    const ids = this.messagesByChannel.get(CommunityStore.channelKey(threadId, guestId)) ?? [];
    const out: MeetupMessage[] = [];
    for (const id of ids) {
      const m = this.meetupMessages.get(id);
      if (m && !m.hidden) out.push(m);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Unread messages waiting for one person, across every meetup. */
  unreadMeetupMessages(userId: string): number {
    let count = 0;
    for (const m of this.meetupMessages.values()) {
      if (m.hidden || m.readAt !== null || m.authorId === userId) continue;
      if (m.hostId === userId || m.guestId === userId) count += 1;
    }
    return count;
  }

  /** How recently `from` waved at `to`, or null. Used to rate-limit nudges. */
  lastWaveAt(fromUserId: string, toUserId: string): number | null {
    let latest: number | null = null;
    for (const w of this.waves.values()) {
      if (w.fromUserId !== fromUserId || w.toUserId !== toUserId) continue;
      if (latest === null || w.createdAt > latest) latest = w.createdAt;
    }
    return latest;
  }
}

/** Phone numbers are compared without spaces, dashes or brackets. */
export function normalisePhone(phone: string): string {
  return phone.replace(/[\s().-]/g, '');
}

/** Strip everything a member shouldn't see about another member. */
export function publicUser(user: User): PublicUser {
  const {
    id, handle, displayName, bio, skills, neighborhood, openToChat, role,
    trade, worksInTrade, helpfulCount, createdAt, lastSeenAt,
  } = user;
  // Email, phone and everything about the identity check stay behind. The only
  // thing other members learn is whether a real person was confirmed.
  return {
    id, handle, displayName, bio, skills, neighborhood, openToChat, role,
    trade, worksInTrade, identityVerified: user.identity !== null,
    helpfulCount, createdAt, lastSeenAt,
  };
}
