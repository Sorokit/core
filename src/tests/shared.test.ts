import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatAddress,
  isBrowser,
  isValidPublicKey,
  isValidContractId,
  toMessage,
  isNotFoundError,
  isUserRejection,
  deduplicateRequest,
  _inflightRequests,
} from "../shared";

describe("shared/utils", () => {
  describe("formatAddress", () => {
    const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    it("shortens a full public key", () => {
      const formatted = formatAddress(key);
      expect(formatted).toContain("...");
      expect(formatted.length).toBeLessThan(key.length);
    });

    it("returns the key unchanged if already short", () => {
      expect(formatAddress("GABCD")).toBe("GABCD");
    });

    it("respects custom char count", () => {
      const formatted = formatAddress(key, 6);
      const [prefix, suffix] = formatted.split("...");
      expect(prefix?.length).toBe(7);
      expect(suffix?.length).toBe(6);
    });
  });

  describe("isBrowser", () => {
    it("returns false in Node environment", () => {
      expect(isBrowser()).toBe(false);
    });
  });

  describe("isValidPublicKey", () => {
    it("accepts a valid 56-char Stellar public key", () => {
      expect(
        isValidPublicKey(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(true);
    });

    it("rejects a key not starting with G", () => {
      expect(
        isValidPublicKey(
          "SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    it("rejects a key that is too short", () => {
      expect(isValidPublicKey("GABCD")).toBe(false);
    });
  });

  describe("isValidContractId", () => {
    it("accepts a valid 56-char contract ID", () => {
      expect(
        isValidContractId(
          "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(true);
    });

    it("rejects an ID not starting with C", () => {
      expect(
        isValidContractId(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });
  });
});

describe("shared/errors", () => {
  describe("toMessage", () => {
    it("extracts message from Error", () => {
      expect(toMessage(new Error("boom"))).toBe("boom");
    });

    it("returns string as-is", () => {
      expect(toMessage("raw string")).toBe("raw string");
    });

    it("stringifies objects", () => {
      expect(toMessage({ code: 42 })).toBe('{"code":42}');
    });
  });

  describe("isNotFoundError", () => {
    it("detects 404 in error message", () => {
      expect(isNotFoundError(new Error("Request failed with status 404"))).toBe(
        true,
      );
    });

    it('detects "not found" in error message', () => {
      expect(isNotFoundError(new Error("account not found"))).toBe(true);
    });

    it("returns false for non-404 errors", () => {
      expect(isNotFoundError(new Error("network timeout"))).toBe(false);
    });

    it("detects 404 via response.status object", () => {
      expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    });
  });

  describe("isUserRejection", () => {
    it('detects "reject"', () => {
      expect(isUserRejection(new Error("User rejected the request"))).toBe(
        true,
      );
    });

    it('detects "cancel"', () => {
      expect(isUserRejection(new Error("Transaction cancelled"))).toBe(true);
    });

    it('detects "denied"', () => {
      expect(isUserRejection(new Error("Access denied"))).toBe(true);
    });

    it("returns false for non-rejection errors", () => {
      expect(isUserRejection(new Error("Network error"))).toBe(false);
    });
  });
});

// ── deduplicateRequest tests (#24) ────────────────────────────────────────────

describe("deduplicateRequest (#24)", () => {
  beforeEach(() => {
    _inflightRequests.clear();
  });

  it("calls fn once for a single request and returns the result", async () => {
    const fn = vi.fn().mockResolvedValue("result-a");

    const result = await deduplicateRequest("getAccount", { key: "GABC" }, fn);

    expect(result).toBe("result-a");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent identical requests — fn called only once", async () => {
    let resolve!: (v: string) => void;
    const pending = new Promise<string>((r) => { resolve = r; });
    const fn = vi.fn().mockReturnValue(pending);

    const p1 = deduplicateRequest("getAccount", { key: "GABC" }, fn);
    const p2 = deduplicateRequest("getAccount", { key: "GABC" }, fn);

    resolve("shared-result");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("shared-result");
    expect(r2).toBe("shared-result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does not deduplicate requests with different params", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce("result-a")
      .mockResolvedValueOnce("result-b");

    const r1 = await deduplicateRequest("getAccount", { key: "GABC" }, fn);
    const r2 = await deduplicateRequest("getAccount", { key: "GXYZ" }, fn);

    expect(r1).toBe("result-a");
    expect(r2).toBe("result-b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate requests with different function names", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce("from-getAccount")
      .mockResolvedValueOnce("from-getBalances");

    const r1 = await deduplicateRequest("getAccount", { key: "GABC" }, fn);
    const r2 = await deduplicateRequest("getBalances", { key: "GABC" }, fn);

    expect(r1).toBe("from-getAccount");
    expect(r2).toBe("from-getBalances");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("removes completed request from registry, allowing a fresh call next time", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    const r1 = await deduplicateRequest("getAccount", { key: "GABC" }, fn);
    // First call settled — registry should be empty
    expect(_inflightRequests.size).toBe(0);

    const r2 = await deduplicateRequest("getAccount", { key: "GABC" }, fn);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("removes rejected request from registry so next call retries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce("recovered");

    await expect(
      deduplicateRequest("getAccount", { key: "GABC" }, fn),
    ).rejects.toThrow("network error");

    // After rejection, registry cleared — next call should succeed
    expect(_inflightRequests.size).toBe(0);
    const r2 = await deduplicateRequest("getAccount", { key: "GABC" }, fn);
    expect(r2).toBe("recovered");
  });

  it("handles non-serialisable params gracefully", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await deduplicateRequest("test", circular, fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });
});
