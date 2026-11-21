export interface CursorStore {
  save(key: string, cursor: string): Promise<void>;
  load(key: string): Promise<string | undefined>;
  clear(key?: string): Promise<void>;
}

/** In-memory implementation for SSR, tests, and applications without storage. */
export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, string>();
  async save(key: string, cursor: string): Promise<void> { this.cursors.set(key, cursor); }
  async load(key: string): Promise<string | undefined> { return this.cursors.get(key); }
  async clear(key?: string): Promise<void> { key === undefined ? this.cursors.clear() : this.cursors.delete(key); }
}

/**
 * localStorage-backed cursor store.
 *
 * It fails fast when storage is unavailable: constructing it without a usable
 * Storage implementation throws a descriptive Error instead of silently holding
 * an `undefined` reference that makes every later call reject with a TypeError.
 */
export class LocalStorageCursorStore implements CursorStore {
  private readonly storage: Storage;

  constructor(storage: Storage | null | undefined = globalThis.localStorage, private readonly prefix = "sorokit:cursor:") {
    if (storage === null || storage === undefined) {
      throw new Error("LocalStorageCursorStore requires a Storage implementation: localStorage is unavailable in this environment. Pass a Storage instance explicitly, or use createCursorStore() / MemoryCursorStore instead.");
    }
    for (const method of ["getItem", "setItem", "removeItem", "key"] as const) {
      const candidate: unknown = storage[method];
      if (typeof candidate !== "function") {
        throw new Error(`LocalStorageCursorStore requires a Storage implementation exposing ${method}(); received ${typeof candidate}.`);
      }
    }
    const length: unknown = storage.length;
    if (typeof length !== "number" || !Number.isFinite(length) || length < 0) {
      throw new Error(`LocalStorageCursorStore requires a Storage implementation whose length is a finite, non-negative number; received ${typeof length} ${String(length)}.`);
    }
    this.storage = storage;
  }
  async save(key: string, cursor: string): Promise<void> { this.storage.setItem(this.prefix + key, cursor); }
  async load(key: string): Promise<string | undefined> { return this.storage.getItem(this.prefix + key) ?? undefined; }
  async clear(key?: string): Promise<void> {
    if (key !== undefined) { this.storage.removeItem(this.prefix + key); return; }
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) { const item = this.storage.key(i); if (item?.startsWith(this.prefix)) keys.push(item); }
    keys.forEach((item) => this.storage.removeItem(item));
  }
}

/** Creates localStorage persistence in browsers and memory persistence elsewhere. */
export function createCursorStore(storage?: Storage): CursorStore {
  if (storage) return new LocalStorageCursorStore(storage);
  try {
    if (typeof globalThis.localStorage !== "undefined") return new LocalStorageCursorStore(globalThis.localStorage);
  } catch {
    // Reading localStorage can itself throw (a privacy-mode getter raising
    // SecurityError, for example). Fall through to the in-memory store.
  }
  return new MemoryCursorStore();
}

export interface EventDeduplicationStore {
  has(id: string): Promise<boolean>;
  add(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Persistent bounded event IDs prevent duplicate delivery after reconnects. */
export class PersistentEventDeduplicationStore implements EventDeduplicationStore {
  private readonly ids = new Map<string, number>();
  constructor(private readonly maxSize = 10_000, private readonly ttlMs = 60 * 60 * 1000, private readonly now = Date.now) {}
  async has(id: string): Promise<boolean> { this.evict(); return this.ids.has(id); }
  async add(id: string): Promise<void> { this.evict(); this.ids.set(id, this.now()); this.evict(); }
  async clear(): Promise<void> { this.ids.clear(); }
  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, timestamp] of this.ids) if (timestamp < cutoff) this.ids.delete(id);
    while (this.ids.size > this.maxSize) this.ids.delete(this.ids.keys().next().value as string);
  }
}

export default CursorStore;
