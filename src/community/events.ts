import type { CommunityEvent } from './types.ts';

type Listener = (event: CommunityEvent) => void;

/**
 * In-process fan-out for server-sent events.
 *
 * Not an EventEmitter: this needs a bounded, explicit subscriber set that the
 * SSE route can drain on disconnect, and a single-process design means there is
 * nothing to gain from a broker. Multi-process deployment would swap this for
 * Redis pub/sub behind the same two methods.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: CommunityEvent): void {
    for (const listener of this.listeners) {
      // One bad subscriber must not stop delivery to the others.
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
