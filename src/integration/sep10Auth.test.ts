import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeSep10Auth, initiateSep10Auth, validateSep10Token } from "./sep10Auth";
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
  beforeEach(() => vi.clearAllMocks());

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
});