import { describe, it, expect, vi } from "vitest";
import {
  connectRabet,
  getRabetAccount,
  signRabetTransaction,
} from "./rabetAdapter";

describe("Rabet Wallet Adapter Helper (#924)", () => {
  const mockPublicKey = "GBB7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const mockProvider = {
    connect: vi.fn().mockResolvedValue({ publicKey: mockPublicKey }),
    sign: vi.fn().mockResolvedValue({ signedTxXdr: "AAAA...signed" }),
  };

  it("connects to Rabet and returns public key", async () => {
    const res = await connectRabet(mockProvider);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.publicKey).toBe(mockPublicKey);
    }
  });

  it("retrieves account public key", async () => {
    const res = await getRabetAccount(mockProvider);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data).toBe(mockPublicKey);
    }
  });

  it("signs transaction XDR", async () => {
    const res = await signRabetTransaction("AAAA...raw", "testnet", mockProvider);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.signedXdr).toBe("AAAA...signed");
    }
  });

  it("handles missing provider error gracefully", async () => {
    const res = await connectRabet(undefined);
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.code).toBe("WALLET_NOT_FOUND");
    }
  });
});
