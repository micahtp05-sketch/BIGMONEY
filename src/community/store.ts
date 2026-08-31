import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Channel,
  CommunityData,
  Credential,
  PublicUser,
  Reply,
  Session,
  Thread,
  User,
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

  /** userId -> credential. */
  private readonly credentials = new Map<string, Credential>();
  /** Secondary indexes, kept in step with the maps above by the add* methods. */
  private readonly usersByHandle = new Map<string, string>();
  private readonly channelsBySlug = new Map<string, string>();
  private readonly threadsByChannel = new Map<string, string[]>();
  private readonly repliesByThread = new Map<string, string[]>();

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
  }

  userByHandle(handle: string): User | undefined {
    const id = this.usersByHandle.get(handle.trim().toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  createUser(input: {
    handle: string;
    displayName: string;
    credential: Omit<Credential, 'userId'>;
  }): User {
    const now = Date.now();
    const user: User = {
      id: randomUUID(),
      handle: input.handle.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      bio: '',
      skills: [],
      neighborhood: '',
      openToChat: false,
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

/** Strip everything a member shouldn't see about another member. */
export function publicUser(user: User): PublicUser {
  const { id, handle, displayName, bio, skills, neighborhood, openToChat, helpfulCount, createdAt, lastSeenAt } = user;
  return { id, handle, displayName, bio, skills, neighborhood, openToChat, helpfulCount, createdAt, lastSeenAt };
}
