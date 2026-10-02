import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryCache } from "../shared/cache";
import { detectContractUpgrade } from "../soroban/upgradeDetection";
import { fetchContractWasm, invalidateContractCache } from "../soroban/contractMetadata";

vi.mock("../soroban/contractMetadata", async () => ({
  ...(await vi.importActual<typeof import("../soroban/contractMetadata")>("../soroban/contractMetadata")),
  fetchContractWasm: vi.fn(),
  invalidateContractCache: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchContractWasm);
const mockedInvalidate = vi.mocked(invalidateContractCache);

describe("detectContractUpgrade", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedInvalidate.mockReset();
  });

  it("records the first hash without reporting an upgrade", async () => {
    const cache = createInMemoryCache();
    mockedFetch.mockResolvedValue({ status: "ok", data: new Uint8Array([1, 2, 3]), error: null });

    const result = await detectContractUpgrade("rpc", "C123", { cache });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.upgraded).toBe(false);
      expect(result.data.previousCodeHash).toBeNull();
    }
  });

  it("invalidates contract caches and emits an event when the hash changes", async () => {
    const cache = createInMemoryCache();
    const onUpgrade = vi.fn();
    cache.set("sorokit:contract-read:C123:r0:cached", "stale");
    mockedFetch
      .mockResolvedValueOnce({ status: "ok", data: new Uint8Array([1]), error: null })
      .mockResolvedValueOnce({ status: "ok", data: new Uint8Array([2]), error: null });

    await detectContractUpgrade("rpc", "C123", { cache });
    const result = await detectContractUpgrade("rpc", "C123", { cache, onUpgrade });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.upgraded).toBe(true);
    expect(mockedInvalidate).toHaveBeenCalledWith("C123", cache);
    expect(cache.get("sorokit:contract-read:C123:r0:cached")).toBeUndefined();
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
