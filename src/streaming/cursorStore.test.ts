import { afterEach, describe, expect, it } from "vitest";
import {
  LocalStorageCursorStore,
  MemoryCursorStore,
  PersistentEventDeduplicationStore,
  createCursorStore,
} from "./cursorStore";

/** Minimal in-memory Storage implementation for the working-path tests. */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.has(key) ? (this.entries.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.entries.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

type Restore = () => void;

/**
 * Deletes a global property entirely. Passing `undefined` is not enough: the
 * constructor's default parameter would re-engage and the test would prove nothing.
 */
function removeGlobal(name: string): Restore {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  delete (globalThis as unknown as Record<string, unknown>)[name];
  return () => {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  };
}

describe("LocalStorageCursorStore", () => {
  let restore: Restore | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("throws a descriptive error when constructed without arguments and localStorage is absent", () => {
    restore = removeGlobal("localStorage");
    expect(() => new LocalStorageCursorStore()).toThrow(/localStorage is unavailable/);
  });

  it("throws a descriptive error when constructed with an explicit undefined and localStorage is absent", () => {
    restore = removeGlobal("localStorage");
    expect(() => new LocalStorageCursorStore(undefined)).toThrow(/localStorage is unavailable/);
  });

  it("throws when the injected object does not expose the Storage methods", () => {
    expect(() => new LocalStorageCursorStore({} as Storage)).toThrow(/requires a Storage implementation/);
  });

  it("round-trips save/load/clear against a valid storage implementation", async () => {
    const store = new LocalStorageCursorStore(new MemoryStorage());
    expect(await store.load("k")).toBeUndefined();
    await store.save("k", "v");
    expect(await store.load("k")).toBe("v");
    await store.clear("k");
    expect(await store.load("k")).toBeUndefined();
  });

  it("clears only cursor entries when clear() is called without a key", async () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageCursorStore(storage);
    await store.save("a", "1");
    await store.save("b", "2");
    storage.setItem("unrelated", "keep");
    await store.clear();
    expect(await store.load("a")).toBeUndefined();
    expect(await store.load("b")).toBeUndefined();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});

describe("createCursorStore", () => {
  let restore: Restore | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("returns a working MemoryCursorStore when localStorage is absent", async () => {
    restore = removeGlobal("localStorage");
    const store = createCursorStore();
    expect(store).toBeInstanceOf(MemoryCursorStore);
    await store.save("k", "v");
    expect(await store.load("k")).toBe("v");
  });

  it("returns a MemoryCursorStore when passed an explicit undefined and localStorage is absent", () => {
    restore = removeGlobal("localStorage");
    expect(createCursorStore(undefined)).toBeInstanceOf(MemoryCursorStore);
  });

  it("returns a working LocalStorageCursorStore when given a valid storage", async () => {
    const store = createCursorStore(new MemoryStorage());
    expect(store).toBeInstanceOf(LocalStorageCursorStore);
    await store.save("k", "v");
    expect(await store.load("k")).toBe("v");
  });

  it("returns a LocalStorageCursorStore backed by the global when localStorage is present", async () => {
    const storage = new MemoryStorage();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: storage, writable: true, configurable: true });
    restore = () => {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)["localStorage"];
    };
    const store = createCursorStore();
    expect(store).toBeInstanceOf(LocalStorageCursorStore);
    await store.save("k", "v");
    expect(storage.getItem("sorokit:cursor:k")).toBe("v");
  });

  it("falls back to MemoryCursorStore when reading localStorage throws", () => {
    restore = removeGlobal("localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: access to localStorage is denied");
      },
    });
    expect(createCursorStore()).toBeInstanceOf(MemoryCursorStore);
  });
});

describe("unaffected stores", () => {
  it("MemoryCursorStore keeps its behaviour", async () => {
    const store = new MemoryCursorStore();
    expect(await store.load("k")).toBeUndefined();
    await store.save("k", "v");
    expect(await store.load("k")).toBe("v");
    await store.clear();
    expect(await store.load("k")).toBeUndefined();
  });

  it("PersistentEventDeduplicationStore keeps its behaviour", async () => {
    const store = new PersistentEventDeduplicationStore();
    expect(await store.has("e1")).toBe(false);
    await store.add("e1");
    expect(await store.has("e1")).toBe(true);
    await store.clear();
    expect(await store.has("e1")).toBe(false);
  });
});

interface StorageStub {
  storage: Storage;
  entries: Map<string, string>;
}

/**
 * Duck-typed Storage stub. Unlike MemoryStorage, `length` is a mutable data
 * property updated by setItem/removeItem rather than a getter, and the object
 * deliberately exposes no clear() — this class never calls it.
 */
function createStorageStub(overrides: Record<string, unknown> = {}): StorageStub {
  const entries = new Map<string, string>();
  const stub: Record<string, unknown> = {
    length: 0,
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value);
      stub["length"] = entries.size;
    },
    removeItem: (key: string): void => {
      entries.delete(key);
      stub["length"] = entries.size;
    },
    key: (index: number): string | null => Array.from(entries.keys())[index] ?? null,
  };
  Object.assign(stub, overrides);
  return { storage: stub as unknown as Storage, entries };
}

/** Runs `fn` and hands back the Error it threw, failing the test if it threw none. */
function captureThrow(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the constructor to throw, but it did not.");
}

describe("LocalStorageCursorStore storage validation", () => {
  it("throws naming key when the object exposes the other methods and a numeric length but no key()", () => {
    const { storage } = createStorageStub({ key: undefined });
    const error = captureThrow(() => new LocalStorageCursorStore(storage));
    expect(error.message).toMatch(/requires a Storage implementation exposing key\(\)/);
    expect(error.message).toMatch(/received/);
  });

  it("rejects a length supplied as the string \"3\"", () => {
    const { storage } = createStorageStub({ length: "3" });
    const error = captureThrow(() => new LocalStorageCursorStore(storage));
    expect(error.message).toMatch(/finite, non-negative number/);
    expect(error.message).toMatch(/received string 3/);
  });

  it("rejects a negative length of -1", () => {
    const { storage } = createStorageStub({ length: -1 });
    expect(() => new LocalStorageCursorStore(storage)).toThrow(/finite, non-negative number/);
  });

  it("rejects a length of NaN", () => {
    const { storage } = createStorageStub({ length: Number.NaN });
    const error = captureThrow(() => new LocalStorageCursorStore(storage));
    expect(error.message).toMatch(/finite, non-negative number/);
    expect(error.message).toMatch(/received number NaN/);
  });

  it("constructs a complete stub and clears only prefixed entries when clear() is called without a key", async () => {
    const { storage, entries } = createStorageStub();
    const store = new LocalStorageCursorStore(storage);
    await store.save("a", "1");
    await store.save("b", "2");
    storage.setItem("unrelated", "keep");
    expect(storage.length).toBe(3);

    await store.clear();

    expect(await store.load("a")).toBeUndefined();
    expect(await store.load("b")).toBeUndefined();
    expect(storage.getItem("unrelated")).toBe("keep");
    expect(storage.length).toBe(1);
    expect(Array.from(entries.keys())).toStrictEqual(["unrelated"]);
  });
});
