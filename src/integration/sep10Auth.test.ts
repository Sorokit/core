import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSep10Auth,
  initiateSep10Auth,
  validateSep10Token,
  pruneExpiredChallenges,
  getPendingChallengesCount,
  clearPendingChallenges,
  CHALLENGE_TTL_MS,
  MAX_PENDING_CHALLENGES,
} from "./sep10Auth";
import { fetchStellarToml } from "./sep1Toml";
import { ok } from "../shared/response";

vi.mock("./sep1Toml", () => ({ fetchStellarToml: vi.fn() }));

const fetchToml = vi.mocked(fetchStellarToml);
const serverKey = Keypair.random();
const clientKey = Keypair.random();
const homeDomain = "example.com";
const endpoint = "https://example.com/auth";
const networkPassphrase = Networks.TESTNET;

function jwt(expiration: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ exp: expiration, sub: clientKey.publicKey() })}.signature`;
}

function setup(fetcher: typeof fetch) {
  fetchToml.mockResolvedValue(ok({
    WEB_AUTH_ENDPOINT: endpoint,
    SIGNING_KEY: serverKey.publicKey(),
    NETWORK_PASSPHRASE: networkPassphrase,
  }));
  return fetcher;
}

describe("SEP-10 auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPendingChallenges();
    vi.useRealTimers();
  });

  afterEach(() => {
    clearPendingChallenges();
    vi.useRealTimers();
  });

  it("requests, verifies, signs, and exchanges a challenge", async () => {
    const challenge = WebAuth.buildChallengeTx(
      serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
    );
    const fetcher = setup(vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: challenge })))
      .mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ token: jwt(Math.floor(Date.now() / 1000) + 3600) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch);

    const requested = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
    expect(requested.status).toBe("ok");
    if (requested.status !== "ok") return;

    const signed = TransactionBuilder.fromXDR(requested.data, networkPassphrase);
    signed.sign(clientKey);
    const result = await completeSep10Auth(requested.data, signed.toXDR(), { now: Date.now() });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.claims.sub).toBe(clientKey.publicKey());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a challenge without the wallet signature", async () => {
    const challenge = WebAuth.buildChallengeTx(
      serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
    );
    const fetcher = setup(vi.fn().mockResolvedValue(new Response(JSON.stringify({ transaction: challenge }))) as typeof fetch);
    const requested = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
    if (requested.status !== "ok") throw new Error("Expected valid challenge");

    const result = await completeSep10Auth(requested.data, requested.data);

    expect(result.status).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects expired tokens", () => {
    const result = validateSep10Token(jwt(1), 2_000);

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("INVALID_AUTH");
  });

  it("rejects malformed tokens", () => {
    expect(validateSep10Token("not-a-jwt").status).toBe("error");
  });

  describe("automatic TTL eviction (#763)", () => {
    it("proactively removes expired challenges in idle deployments via background timer", async () => {
      vi.useFakeTimers();
      const baseTime = 1_700_000_000_000;
      vi.setSystemTime(baseTime);

      const challenge = WebAuth.buildChallengeTx(
        serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
      );
      const fetcher = setup(vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ transaction: challenge })),
      ) as typeof fetch);

      const requested = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
      expect(requested.status).toBe("ok");
      expect(getPendingChallengesCount()).toBe(1);

      // Advance clock past CHALLENGE_TTL_MS (5 min) while deployment is completely idle
      vi.advanceTimersByTime(CHALLENGE_TTL_MS + 100);

      // Map should now be empty without calling any other function
      expect(getPendingChallengesCount()).toBe(0);
    });

    it("fails with clear expired error when completeSep10Auth is called with an expired-but-not-evicted challenge", async () => {
      const challenge = WebAuth.buildChallengeTx(
        serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
      );
      const fetcher = setup(vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ transaction: challenge })),
      ) as typeof fetch);

      const requested = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
      expect(requested.status).toBe("ok");
      if (requested.status !== "ok") return;

      const signed = TransactionBuilder.fromXDR(requested.data, networkPassphrase);
      signed.sign(clientKey);

      // Simulate a timestamp past the 5-minute TTL
      const expiredNow = Date.now() + CHALLENGE_TTL_MS + 5_000;
      const result = await completeSep10Auth(requested.data, signed.toXDR(), { now: expiredNow });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("INVALID_AUTH");
        expect(result.error.message).toBe("SEP-10 challenge has expired.");
      }
      expect(getPendingChallengesCount()).toBe(0);
    });

    it("fails with unknown/already-used error if the challenge was already evicted", async () => {
      vi.useFakeTimers();
      const baseTime = 1_700_000_000_000;
      vi.setSystemTime(baseTime);

      const challenge = WebAuth.buildChallengeTx(
        serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
      );
      const fetcher = setup(vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ transaction: challenge })),
      ) as typeof fetch);

      const requested = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
      expect(requested.status).toBe("ok");
      if (requested.status !== "ok") return;

      const signed = TransactionBuilder.fromXDR(requested.data, networkPassphrase);
      signed.sign(clientKey);

      // Allow background timer to proactively evict the challenge
      vi.advanceTimersByTime(CHALLENGE_TTL_MS + 100);
      expect(getPendingChallengesCount()).toBe(0);

      const result = await completeSep10Auth(requested.data, signed.toXDR());
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("INVALID_AUTH");
        expect(result.error.message).toBe("SEP-10 challenge is unknown or has already been used.");
      }
    });

    it("preserves MAX_PENDING_CHALLENGES and FIFO eviction semantics", async () => {
      const challenges: string[] = [];
      const fetcher = setup(vi.fn().mockImplementation(async (reqUrl: URL | string) => {
        const url = new URL(reqUrl.toString());
        const account = url.searchParams.get("account")!;
        const ch = WebAuth.buildChallengeTx(
          serverKey, account, homeDomain, 300, networkPassphrase, homeDomain,
        );
        challenges.push(ch);
        return new Response(JSON.stringify({ transaction: ch }));
      }) as typeof fetch);

      // Fill up to MAX_PENDING_CHALLENGES (128)
      for (let i = 0; i < MAX_PENDING_CHALLENGES; i++) {
        const client = Keypair.random();
        const res = await initiateSep10Auth(homeDomain, client.publicKey(), { fetch: fetcher });
        expect(res.status).toBe("ok");
      }
      expect(getPendingChallengesCount()).toBe(MAX_PENDING_CHALLENGES);

      const firstChallenge = challenges[0]!;

      // Adding the 129th challenge should evict the first challenge
      const client129 = Keypair.random();
      const res129 = await initiateSep10Auth(homeDomain, client129.publicKey(), { fetch: fetcher });
      expect(res129.status).toBe("ok");
      expect(getPendingChallengesCount()).toBe(MAX_PENDING_CHALLENGES);

      // The first challenge should have been evicted FIFO
      const completeRes = await completeSep10Auth(firstChallenge, firstChallenge);
      expect(completeRes.status).toBe("error");
      if (completeRes.status === "error") {
        expect(completeRes.error.message).toBe("SEP-10 challenge is unknown or has already been used.");
      }
    });

    it("staggers background evictions across multiple challenges with different creation times", async () => {
      vi.useFakeTimers();
      const baseTime = 1_700_000_000_000;
      vi.setSystemTime(baseTime);

      const fetcher = setup(vi.fn().mockImplementation(async (reqUrl: URL | string) => {
        const url = new URL(reqUrl.toString());
        const account = url.searchParams.get("account")!;
        const ch = WebAuth.buildChallengeTx(
          serverKey, account, homeDomain, 300, networkPassphrase, homeDomain,
        );
        return new Response(JSON.stringify({ transaction: ch }));
      }) as typeof fetch);

      // Challenge A at t = 0
      const resA = await initiateSep10Auth(homeDomain, Keypair.random().publicKey(), { fetch: fetcher });
      expect(resA.status).toBe("ok");
      expect(getPendingChallengesCount()).toBe(1);

      // Advance by 60 seconds
      vi.advanceTimersByTime(60_000);
      expect(getPendingChallengesCount()).toBe(1);

      // Challenge B at t = 60s
      const resB = await initiateSep10Auth(homeDomain, Keypair.random().publicKey(), { fetch: fetcher });
      expect(resB.status).toBe("ok");
      expect(getPendingChallengesCount()).toBe(2);

      // Advance by 240s + 1ms (total 300,001 ms -> Challenge A expires at 300,000 ms)
      vi.advanceTimersByTime(240_001);
      // Challenge A is evicted; Challenge B (expires at 360,000 ms) remains
      expect(getPendingChallengesCount()).toBe(1);

      // Advance by remaining 60,000 ms (total 360,001 ms -> Challenge B expires)
      vi.advanceTimersByTime(60_000);
      // Both challenges evicted, timer stopped
      expect(getPendingChallengesCount()).toBe(0);
    });

    it("keeps expiry order when the same challenge XDR is registered again", async () => {
      vi.useFakeTimers();
      const baseTime = 1_700_000_000_000;
      vi.setSystemTime(baseTime);

      const otherClient = Keypair.random();
      const refreshedChallenge = WebAuth.buildChallengeTx(
        serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
      );
      const middleChallenge = WebAuth.buildChallengeTx(
        serverKey, otherClient.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
      );
      const fetcher = setup(vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: refreshedChallenge })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: middleChallenge })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: refreshedChallenge }))) as typeof fetch);

      const first = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
      expect(first.status).toBe("ok");

      vi.advanceTimersByTime(60_000);
      const middle = await initiateSep10Auth(homeDomain, otherClient.publicKey(), { fetch: fetcher });
      expect(middle.status).toBe("ok");

      vi.advanceTimersByTime(60_000);
      const refreshed = await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
      expect(refreshed.status).toBe("ok");
      expect(getPendingChallengesCount()).toBe(2);

      // The middle challenge expires before the refreshed challenge, even
      // though its XDR was first inserted before that refresh.
      vi.advanceTimersByTime(240_001);
      expect(getPendingChallengesCount()).toBe(1);

      vi.advanceTimersByTime(60_000);
      expect(getPendingChallengesCount()).toBe(0);
    });

    it("pruneExpiredChallenges manually prunes and returns count", async () => {
      const challenge = WebAuth.buildChallengeTx(
        serverKey, clientKey.publicKey(), homeDomain, 300, networkPassphrase, homeDomain,
      );
      const fetcher = setup(vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ transaction: challenge })),
      ) as typeof fetch);

      await initiateSep10Auth(homeDomain, clientKey.publicKey(), { fetch: fetcher });
      expect(getPendingChallengesCount()).toBe(1);

      // Calling prune with past timestamp should prune nothing
      expect(pruneExpiredChallenges(Date.now() - 1000)).toBe(0);
      expect(getPendingChallengesCount()).toBe(1);

      // Calling prune with future timestamp should prune the challenge
      expect(pruneExpiredChallenges(Date.now() + CHALLENGE_TTL_MS + 1000)).toBe(1);
      expect(getPendingChallengesCount()).toBe(0);
    });
  });
});
