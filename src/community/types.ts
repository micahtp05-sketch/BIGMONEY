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

export type UserRole = 'member' | 'moderator';

export interface IdentityCheck {
  verifiedAt: number;
  /** How it was confirmed, e.g. "in person" or the name of a provider. */
  method: string;
  /** A reference that can be traced back without holding the document. */
  reference: string;
  /** The moderator who recorded it, when a person did the checking. */
  checkedBy: string | null;
}

/** Somebody asking to be identity-checked, waiting for a moderator. */
export interface IdentityRequest {
  userId: string;
  /** What they say they can show, in their words. No document is uploaded. */
  note: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  outcome: 'verified' | 'refused' | null;
  refusedReason: string;
}

/** A one-time code sent to an email address or a phone. */
export interface VerificationCode {
  /** `${userId}:${channel}` — one live code per channel per person. */
  id: string;
  userId: string;
  channel: 'email' | 'phone' | 'reset';
  /** Hashed, never the code itself. */
  hash: string;
  salt: string;
  expiresAt: number;
  attempts: number;
}

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
  /** Unique, lowercase, URL-safe. The only name other members ever see. */
  handle: string;
  displayName: string;
  /**
   * Contact details. Never leave the server: `publicUser` does not carry them
   * and no route returns them for anybody but the account's owner.
   */
  email: string;
  emailVerifiedAt: number | null;
  phone: string;
  phoneVerifiedAt: number | null;
  /**
   * The outcome of an identity check, and nothing else.
   *
   * Commons never stores the document, the number on it, or an image of it.
   * Keeping passport scans in a JSON file would be the least secure thing in
   * this codebase, and the only thing anyone actually needs afterwards is
   * whether a real person was confirmed, when, how, and by whom.
   */
  identity: IdentityCheck | null;
  bio: string;
  /** Self-declared skills, matched against channel topics. */
  skills: string[];
  /** Free text — "Riverside", "north end". Deliberately not a precise address. */
  neighborhood: string;
  /** Opt-in flag meaning "I'm around and happy to talk right now". */
  openToChat: boolean;
  /**
   * Members can do everything ordinary; moderators can additionally rule on
   * reported content. Seeded from COMMUNITY_MODERATORS, and granted by an
   * existing moderator after that.
   */
  role: UserRole;
  /** Self-declared trade, e.g. "Plumber". Empty when they have not said. */
  trade: string;
  /** Whether they say they do that trade for a living. Nobody checks. */
  worksInTrade: boolean;
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
  role: UserRole;
  trade: string;
  worksInTrade: boolean;
  /** Whether a real person was confirmed behind this account. Never the details. */
  identityVerified: boolean;
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

/**
 * A meetup lives on a thread rather than in its own table — it *is* the post.
 *
 * There is deliberately no location field. A meetup's address is the most
 * dangerous thing this platform could publish: hosts write their own homes into
 * it, and a public page keeps that forever. So Commons stores no address at
 * all. The host tells each guest where to come, in the private channel that
 * opens when that guest says they are coming.
 */
export interface MeetupDetails {
  /** Epoch ms. */
  startsAt: number;
  /** 0 means no limit. */
  capacity: number;
  /** User ids, in RSVP order. Past `capacity` they are the waitlist. */
  rsvps: string[];
}

/**
 * One message between a meetup's host and one person coming to it.
 *
 * This is the only private channel in Commons, and it is deliberately not a
 * general direct-message system: a channel exists only for a (meetup, guest)
 * pair, only while that guest is coming, and only ever has two people in it.
 * Every read is authorised against both of those facts on the server.
 */
export interface MeetupMessage {
  id: string;
  /** The meetup thread this belongs to. */
  threadId: string;
  /** The meetup's host — one half of the channel. */
  hostId: string;
  /** The person coming — the other half. */
  guestId: string;
  /** Which of the two wrote it. Always hostId or guestId. */
  authorId: string;
  body: string;
  createdAt: number;
  readAt: number | null;
  reportedBy: string[];
  hidden: boolean;
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

/**
 * What one member says about another.
 *
 * Two kinds, and the difference between them is the whole point:
 *
 *  - `helped` is anchored to something that happened here — the person being
 *    reviewed answered a question the reviewer asked, or hosted a get-together
 *    the reviewer went to. The server checks that before accepting it.
 *  - `hired` is about paid work done off Commons. Nothing about it can be
 *    verified: not that the job happened, not that these two ever met. It is
 *    accepted anyway because people want it, and it is labelled everywhere it
 *    appears so a reader can weigh it accordingly.
 *
 * Reviews are always signed. There is no anonymous review, because an
 * unverifiable claim about somebody's livelihood should at least come with a
 * name attached to it.
 */
export type ReviewKind = 'helped' | 'hired';

export interface Review {
  id: string;
  /** The member being reviewed. */
  subjectId: string;
  authorId: string;
  kind: ReviewKind;
  /** 1..5. */
  rating: number;
  body: string;
  /** The thread that proves a `helped` review. Always null for `hired`. */
  threadId: string | null;
  createdAt: number;
  reportedBy: string[];
  hidden: boolean;
}

/** Everything a member can report. */
export type ReportTarget = 'thread' | 'reply' | 'message' | 'review';

export type ModerationDecision = 'kept' | 'removed';

export interface Report {
  reporterId: string;
  reason: string;
  createdAt: number;
}

/**
 * One piece of reported content, and what happened to it.
 *
 * Reports used to be a bare count on the content itself, and the reason a
 * person typed was thrown away — which made a queue impossible to work, since
 * a moderator could see that three people objected but not what to.
 *
 * A case also makes a ruling stick. Once a moderator has kept something,
 * reports no longer hide it automatically, so three people cannot simply
 * re-report their way to the same outcome.
 */
export interface ModerationCase {
  /** `${kind}:${targetId}` — one case per piece of content. */
  id: string;
  kind: ReportTarget;
  targetId: string;
  /** Who the content belongs to, kept here so the queue needs no lookups. */
  authorId: string;
  reports: Report[];
  /** The author's one note back. Null until they write it. */
  appeal: string | null;
  appealAt: number | null;
  decision: ModerationDecision | null;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionReason: string;
}

/**
 * One member deciding another may not reach them.
 *
 * A block governs **contact, not speech**. It closes the waves, the private
 * meetup channel, the ability to say you are coming to the other's
 * get-together, and the ability to write a new review of them. It does not
 * touch a single thread or reply: the rooms stay public, and both people go on
 * seeing what the other says in them.
 *
 * That line is deliberate and it cuts both ways. Hiding posts would let
 * somebody block a checked electrician and quietly erase their answers from a
 * trade room, and — worse — would hand anyone a way to talk about a person who
 * cannot see it being done. What a member needs protecting from is being
 * contacted, followed to their door, and rated; not from reading.
 *
 * Blocks are enforced in **both directions** from one record. If they only ran
 * one way, blocking somebody would still leave them free to wave at you, which
 * is the entire thing being asked for.
 */
export interface Block {
  blockerId: string;
  blockedId: string;
  createdAt: number;
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
  blocks: Block[];
  meetupMessages: MeetupMessage[];
  reviews: Review[];
  moderation: ModerationCase[];
  identityRequests: IdentityRequest[];
  codes: VerificationCode[];
}

/** Server-sent event payloads. One union so the client can switch exhaustively. */
export type CommunityEvent =
  | { type: 'thread.created'; channelId: string; threadId: string }
  | { type: 'thread.updated'; channelId: string; threadId: string }
  | { type: 'reply.created'; channelId: string; threadId: string; replyId: string }
  | { type: 'presence.changed'; userId: string; openToChat: boolean }
  | { type: 'wave.sent'; toUserId: string }
  | { type: 'meetup.message'; threadId: string; toUserId: string };
