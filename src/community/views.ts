import type { CommunityStore } from './store.ts';
import { publicUser } from './store.ts';
import type { Channel, PublicUser, Reply, Thread, User } from './types.ts';

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
