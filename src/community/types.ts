/**
 * Commons — the community side of the house.
 *
 * Three kinds of channel, because the three needs are genuinely different:
 *   help   — someone has a problem and wants an experienced answer
 *   group  — a standing public group around a shared interest
 *   social — getting people who are alone into the same room
 *
 * They share one thread/reply substrate; the differences live in what the
 * client surfaces and in which fields threads carry.
 */

export type ChannelKind = 'help' | 'group' | 'social';

export interface Channel {
  id: string;
  /** URL-safe name, unique. */
  slug: string;
  name: string;
  kind: ChannelKind;
  description: string;
  /**
   * Skill tags relevant here, e.g. ["plumbing", "electrical"]. A reply author
   * whose profile claims one of these is badged as experienced — a disclosure,
   * not a credential.
   */
  topics: string[];
  createdAt: number;
  createdBy: string | null;
}

export interface User {
  id: string;
  /** Unique, lowercase, URL-safe. */
  handle: string;
  displayName: string;
  bio: string;
  /** Self-declared skills, matched against channel topics. */
  skills: string[];
  /** Free text — "Riverside", "north end". Deliberately not a precise address. */
  neighborhood: string;
  /** Opt-in flag meaning "I'm around and happy to talk right now". */
  openToChat: boolean;
  /** Times another member marked one of this user's replies as the one that helped. */
  helpfulCount: number;
  createdAt: number;
  lastSeenAt: number;
}

/** What other members are allowed to see. Never carries the password hash. */
export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  skills: string[];
  neighborhood: string;
  openToChat: boolean;
  helpfulCount: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface Credential {
  userId: string;
  salt: string;
  hash: string;
}

export interface Session {
  /** The bearer value in the cookie. Random, never derived from the user. */
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/** A meetup lives on a thread rather than in its own table — it *is* the post. */
export interface MeetupDetails {
  /** Epoch ms. */
  startsAt: number;
  place: string;
  /** 0 means no limit. */
  capacity: number;
  /** User ids, in RSVP order. Past `capacity` they are the waitlist. */
  rsvps: string[];
}

/**
 * A price estimate carried into a thread from the estimator pipeline, so
 * "is this worth fixing?" starts from a number instead of a guess.
 */
export interface EstimateAttachment {
  title: string;
  estimateCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  currency: string;
  confidence: number;
  sampleSize: number;
}

export interface Thread {
  id: string;
  channelId: string;
  authorId: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  /** Bumped by replies — this is what "recent activity" sorts on. */
  updatedAt: number;
  replyCount: number;
  /** Set by the thread author when one reply is the answer. */
  acceptedReplyId: string | null;
  meetup: MeetupDetails | null;
  estimate: EstimateAttachment | null;
  reportedBy: string[];
  hidden: boolean;
  deletedAt: number | null;
}

export interface Reply {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: number;
  /** User ids who found it useful. Length is the score. */
  helpfulBy: string[];
  reportedBy: string[];
  hidden: boolean;
  deletedAt: number | null;
}

/** A nudge from one member to another. Public-by-design platform, private-ish nudge. */
export interface Wave {
  id: string;
  fromUserId: string;
  toUserId: string;
  note: string;
  createdAt: number;
  readAt: number | null;
}

/** The whole world, as persisted. */
export interface CommunityData {
  version: 1;
  users: User[];
  credentials: Credential[];
  sessions: Session[];
  channels: Channel[];
  threads: Thread[];
  replies: Reply[];
  waves: Wave[];
}

/** Server-sent event payloads. One union so the client can switch exhaustively. */
export type CommunityEvent =
  | { type: 'thread.created'; channelId: string; threadId: string }
  | { type: 'thread.updated'; channelId: string; threadId: string }
  | { type: 'reply.created'; channelId: string; threadId: string; replyId: string }
  | { type: 'presence.changed'; userId: string; openToChat: boolean }
  | { type: 'wave.sent'; toUserId: string };
