/**
 * Event emitter with per-listener backpressure.
 *
 * A listener may return a promise. The emitter does not invoke that listener
 * with its next event until the promise settles, so slow consumers naturally
 * apply backpressure instead of accumulating concurrent handler work.
 */

export type StreamEventMap = Record<string, unknown>;
export type StreamEventListener<Payload> = (payload: Payload) => void | Promise<void>;
export type StreamEventUnsubscribe = () => void;

type ListenerState<Payload> = {
  listener: StreamEventListener<Payload>;
  tail: Promise<void>;
};

export class StreamEventEmitter<Events extends StreamEventMap> {
  private readonly listeners = new Map<keyof Events, Set<ListenerState<Events[keyof Events]>>>();

  on<Event extends keyof Events>(
    event: Event,
    listener: StreamEventListener<Events[Event]>,
  ): StreamEventUnsubscribe {
    const state: ListenerState<Events[Event]> = { listener, tail: Promise.resolve() };
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(state as ListenerState<Events[keyof Events]>);
    return () => {
      listeners?.delete(state as ListenerState<Events[keyof Events]>);
    };
  }

  off<Event extends keyof Events>(event: Event, listener: StreamEventListener<Events[Event]>): void {
    for (const state of this.listeners.get(event) ?? []) {
      if (state.listener === listener) this.listeners.get(event)?.delete(state);
    }
  }

  /** Queue an event and resolve when all current listeners have consumed it. */
  async emit<Event extends keyof Events>(event: Event, payload: Events[Event]): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const state of [...(this.listeners.get(event) ?? [])]) {
      const next = state.tail.then(async () => {
        await state.listener(payload as Events[keyof Events]);
      });
      state.tail = next.catch(() => undefined);
      pending.push(next);
    }
    await Promise.allSettled(pending);
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  listenerCount(event?: keyof Events): number {
    return event === undefined
      ? [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
      : this.listeners.get(event)?.size ?? 0;
  }
}
