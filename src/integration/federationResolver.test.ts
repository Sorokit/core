import { describe, expect, it } from "vitest";
import { parseFederatedAddress, resolveFederatedAddress } from "./federationResolver";

const publicKey = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV".slice(0, 56);

describe("federation memo resolution", () => {
  it("parses and preserves a Memo-ID address", () => {
    expect(parseFederatedAddress("alice*example.com?memo_id=12345&memo_type=id")).toEqual({
      username: "alice",
      domain: "example.com",
      memo: "12345",
      memoType: "id",
    });
  });

  it("rejects malformed memo values", () => {
    expect(parseFederatedAddress("alice*example.com?memo_id=nope&memo_type=id")).toBeNull();
    expect(parseFederatedAddress("alice*example.com?memo_id=abc&memo_type=hash")).toBeNull();
  });

  it("returns input memo data when the federation response omits it", async () => {
    const result = await resolveFederatedAddress(
      "alice*example.com?memo_id=12345&memo_type=id",
      {
        cacheTtlMs: 0,
        fetchFn: async () => new Response(JSON.stringify({ account_id: publicKey })),
      },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.memo).toBe("12345");
      expect(result.data.memoType).toBe("id");
    }
  });
});
