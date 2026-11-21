import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStellarToml } from "./sep1Toml";
import {
  clearPendingChallenges,
  getAuthChallenge,
  submitSignedChallenge,
  verifyAuthToken,
} from "./sep10Auth";
import { ok } from "../shared/response";
import * as publicApi from "../index";

vi.mock("./sep1Toml", () => ({ fetchStellarToml: vi.fn() }));

const fetchToml = vi.mocked(fetchStellarToml);
const serverKey = Keypair.random();
const clientKey = Keypair.random();
const wrongKey = Keypair.random();
const domain = "auth.example.com";
const endpoint = `https://${domain}/auth`;
const networkPassphrase = Networks.TESTNET;

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.signature`;
}

function token(expirationSeconds: number): string {
  return jwt({
    sub: clientKey.publicKey(),
    iat: Math.floor(Date.now() / 1000),
    exp: expirationSeconds,
  });
}

function setupToml(): void {
  fetchToml.mockResolvedValue(
    ok({
      WEB_AUTH_ENDPOINT: endpoint,
      SIGNING_KEY: serverKey.publicKey(),
      NETWORK_PASSPHRASE: networkPassphrase,
    }),
  );
}

function challengeFetcher(challenge: string, nextToken?: string): typeof fetch {
  return vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: challenge })))
    .mockResolvedValueOnce(
      new Response(JSON.stringify(nextToken ? { token: nextToken } : { error: "denied" }), {
        status: nextToken ? 200 : 400,
      }),
    ) as unknown as typeof fetch;
}

describe("SEP-10 full flow (#901)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPendingChallenges();
    setupToml();
  });

  afterEach(() => {
    clearPendingChallenges();
    vi.useRealTimers();
  });

  it("fetches a challenge, accepts a wallet signature and returns a verified token", async () => {
    const challenge = WebAuth.buildChallengeTx(
      serverKey,
      clientKey.publicKey(),
      domain,
      300,
      networkPassphrase,
      domain,
    );
    const expectedToken = token(Math.floor(Date.now() / 1000) + 3600);
    const fetcher = challengeFetcher(challenge, expectedToken);

    const challengeResult = await getAuthChallenge(domain, clientKey.publicKey(), {
      fetch: fetcher,
    });
    expect(challengeResult.status).toBe("ok");
    if (challengeResult.status !== "ok") return;

    const signed = TransactionBuilder.fromXDR(challengeResult.data, networkPassphrase);
    signed.sign(clientKey);

    const result = await submitSignedChallenge(domain, signed.toXDR());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.token).toBe(expectedToken);
      expect(result.data.claims.sub).toBe(clientKey.publicKey());
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a signature from the wrong account", async () => {
    const challenge = WebAuth.buildChallengeTx(
      serverKey,
      clientKey.publicKey(),
      domain,
      300,
      networkPassphrase,
      domain,
    );
    const fetcher = challengeFetcher(challenge, token(Math.floor(Date.now() / 1000) + 3600));
    const challengeResult = await getAuthChallenge(domain, clientKey.publicKey(), {
      fetch: fetcher,
    });
    if (challengeResult.status !== "ok") throw new Error("challenge request failed");

    const signed = TransactionBuilder.fromXDR(challengeResult.data, networkPassphrase);
    signed.sign(wrongKey);

    const result = await submitSignedChallenge(domain, signed.toXDR());
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("INVALID_AUTH");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed challenge presented to a different domain", async () => {
    const challenge = WebAuth.buildChallengeTx(
      serverKey,
      clientKey.publicKey(),
      domain,
      300,
      networkPassphrase,
      domain,
    );
    const fetcher = challengeFetcher(challenge, token(Math.floor(Date.now() / 1000) + 3600));
    const challengeResult = await getAuthChallenge(domain, clientKey.publicKey(), {
      fetch: fetcher,
    });
    if (challengeResult.status !== "ok") throw new Error("challenge request failed");

    const signed = TransactionBuilder.fromXDR(challengeResult.data, networkPassphrase);
    signed.sign(clientKey);

    const result = await submitSignedChallenge("other.example.com", signed.toXDR());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("No matching SEP-10 challenge");
    }
  });

  it("rejects an expired token returned by the auth server", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const challenge = WebAuth.buildChallengeTx(
      serverKey,
      clientKey.publicKey(),
      domain,
      300,
      networkPassphrase,
      domain,
    );
    const fetcher = challengeFetcher(challenge, token(Math.floor(now / 1000) - 1));
    const challengeResult = await getAuthChallenge(domain, clientKey.publicKey(), {
      fetch: fetcher,
    });
    if (challengeResult.status !== "ok") throw new Error("challenge request failed");

    const signed = TransactionBuilder.fromXDR(challengeResult.data, networkPassphrase);
    signed.sign(clientKey);

    const result = await submitSignedChallenge(domain, signed.toXDR(), { now });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.message).toContain("expired");
  });

  it("validates token claims in verifyAuthToken", () => {
    const validToken = token(Math.floor(Date.now() / 1000) + 3600);
    expect(verifyAuthToken(validToken).status).toBe("ok");
    expect(verifyAuthToken(token(1), { now: 2_000 }).status).toBe("error");

    const badSubject = jwt({ sub: "invalid", exp: Math.floor(Date.now() / 1000) + 3600 });
    const subjectResult = verifyAuthToken(badSubject);
    expect(subjectResult.status).toBe("error");
    if (subjectResult.status === "error") expect(subjectResult.error.message).toContain("sub claim");

    const badIssuedAt = jwt({
      sub: clientKey.publicKey(),
      iat: "yesterday",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const issuedAtResult = verifyAuthToken(badIssuedAt);
    expect(issuedAtResult.status).toBe("error");
    if (issuedAtResult.status === "error") expect(issuedAtResult.error.message).toContain("iat claim");
  });

  it("exposes the flow through the public API", () => {
    expect(typeof publicApi.getAuthChallenge).toBe("function");
    expect(typeof publicApi.submitSignedChallenge).toBe("function");
    expect(typeof publicApi.verifyAuthToken).toBe("function");
  });
});
