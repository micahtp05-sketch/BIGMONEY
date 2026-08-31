import type { CommunityStore } from './store.ts';
import { publicUser } from './store.ts';
import type { Channel, PublicUser, Reply, Review, Thread, User } from './types.ts';

export interface ThreadView extends Omit<Thread, 'reportedBy' | 'hidden' | 'deletedAt'> {
  author: PublicUser;
  channelSlug: string;
  channelName: string;
  channelKind: Channel['kind'];
  /** Channel topics this author claims on their profile. */
  authorTopics: string[];
  /** True when the viewer has RSVP'd to this thread's meetup. */
  viewerRsvpd: boolean;
  viewerIsAuthor: boolean;
}

export interface ReplyView extends Omit<Reply, 'reportedBy' | 'hidden' | 'deletedAt' | 'helpfulBy'> {
  author: PublicUser;
  helpfulCount: number;
  viewerFoundHelpful: boolean;
  viewerIsAuthor: boolean;
  accepted: boolean;
  authorTopics: string[];
}

/**
 * Which of a channel's topics the author actually claims.
 *
 * This is the entire "expert" mechanism, and it is intentionally thin: it
 * reports a self-declaration next to the answer so readers can weigh it. It
 * verifies nothing, so the UI must never present it as a credential.
 */
export function matchedTopics(channel: Channel | undefined, author: User | undefined): string[] {
  if (!channel || !author) return [];
  const claimed = new Set(author.skills.map((s) => s.toLowerCase()));
  return channel.topics.filter((t) => claimed.has(t.toLowerCase()));
}

/** A placeholder for content whose author is gone — the thread still reads. */
const GHOST: PublicUser = {
  id: 'deleted',
  handle: 'deleted',
  displayName: 'Former member',
  bio: '',
  skills: [],
  neighborhood: '',
  openToChat: false,
  trade: '',
  worksInTrade: false,
  helpfulCount: 0,
  createdAt: 0,
  lastSeenAt: 0,
};

export function threadView(store: CommunityStore, thread: Thread, viewerId: string | null): ThreadView {
  const author = store.users.get(thread.authorId);
  const channel = store.channels.get(thread.channelId);
  const { reportedBy: _r, hidden: _h, deletedAt: _d, ...rest } = thread;
  return {
    ...rest,
    author: author ? publicUser(author) : GHOST,
    channelSlug: channel?.slug ?? 'unknown',
    channelName: channel?.name ?? 'Unknown channel',
    channelKind: channel?.kind ?? 'group',
    authorTopics: matchedTopics(channel, author),
    viewerRsvpd: viewerId !== null && (thread.meetup?.rsvps.includes(viewerId) ?? false),
    viewerIsAuthor: viewerId !== null && thread.authorId === viewerId,
  };
}

export function replyView(
  store: CommunityStore,
  reply: Reply,
  thread: Thread,
  viewerId: string | null,
): ReplyView {
  const author = store.users.get(reply.authorId);
  const channel = store.channels.get(thread.channelId);
  const { reportedBy: _r, hidden: _h, deletedAt: _d, helpfulBy, ...rest } = reply;
  return {
    ...rest,
    author: author ? publicUser(author) : GHOST,
    helpfulCount: helpfulBy.length,
    viewerFoundHelpful: viewerId !== null && helpfulBy.includes(viewerId),
    viewerIsAuthor: viewerId !== null && reply.authorId === viewerId,
    accepted: thread.acceptedReplyId === reply.id,
    authorTopics: matchedTopics(channel, author),
  };
}

export interface ReviewView extends Omit<Review, 'reportedBy' | 'hidden' | 'subjectId' | 'authorId'> {
  author: PublicUser;
  /** True when Commons watched the thing being described happen. */
  verified: boolean;
  viewerIsAuthor: boolean;
}

/** What a set of reviews adds up to. */
export interface ReviewSummary {
  count: number;
  /**
   * Null until there are at least two. One person's opinion is not an average,
   * and printing "5.0" above a single review reads like a track record.
   */
  average: number | null;
  verified: number;
  unverified: number;
  /**
   * What the directory orders by. Never shown to anyone — it is a sort key, not
   * a grade. Null when nobody has reviewed this person.
   */
  score: number | null;
}

/**
 * How much one review counts toward the ranking.
 *
 * A review of help given here was checked by the server; a review of paid work
 * was taken on trust. Ranking decides who gets found, so the checkable kind
 * carries twice the weight — which also halves what a fabricated one buys.
 */
const WEIGHT = { helped: 2, hired: 1 } as const;

/**
 * A prior, so that ranking is not decided by whoever got one glowing review.
 *
 * The score is the weighted mean pulled toward a neutral 3.5 by the equivalent
 * of three middling reviews. One five-star review lands near 3.9; forty
 * four-star reviews land near 4.0 and stay there. Somebody with a real record
 * therefore outranks somebody with a single friend, which is the whole point.
 */
const PRIOR_WEIGHT = 3;
const PRIOR_MEAN = 3.5;

export function reviewView(store: CommunityStore, review: Review, viewerId: string | null): ReviewView {
  const author = store.users.get(review.authorId);
  const { reportedBy: _r, hidden: _h, subjectId: _s, authorId: _a, ...rest } = review;
  return {
    ...rest,
    author: author ? publicUser(author) : GHOST,
    verified: review.kind === 'helped',
    viewerIsAuthor: viewerId !== null && review.authorId === viewerId,
  };
}

export function summarise(reviews: Review[]): ReviewSummary {
  const count = reviews.length;
  const verified = reviews.filter((r) => r.kind === 'helped').length;
  const total = reviews.reduce((sum, r) => sum + r.rating, 0);

  let weight = 0;
  let weighted = 0;
  for (const review of reviews) {
    const w = WEIGHT[review.kind];
    weight += w;
    weighted += w * review.rating;
  }
  const score = count === 0
    ? null
    : (PRIOR_WEIGHT * PRIOR_MEAN + weighted) / (PRIOR_WEIGHT + weight);

  return {
    count,
    average: count >= 2 ? Math.round((total / count) * 10) / 10 : null,
    verified,
    unverified: count - verified,
    score: score === null ? null : Math.round(score * 1000) / 1000,
  };
}
