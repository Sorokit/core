import { Account, Federation, Keypair, StellarToml, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFederationAddressCache,
  resolveFederatedAddress,
} from "../integration/federationResolver";
import {
  getSep6TransactionStatus,
  authenticateSep10,
  initiateSep24Interactive,
  initiateSep6Transfer,
} from "../integration/anchors";
import {
  deriveKey,
  rotateSecretKey,
  validateSecretKey,
} from "../shared/keyManagement";
import { loadIntegration, loadKeyManagement, loadSoroban } from "../lazy";

const VALID_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PASSPHRASE = "Test SDF Network ; September 2015";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearFederationAddressCache();
});

describe("federation resolution", () => {
  it("parses both supported federation address forms and caches successful lookups", async () => {
    const key = Keypair.random().publicKey();
    const resolveAddress = vi.fn().mockResolvedValue({ account_id: key, memo: "7", memo_type: "id" });
    vi.spyOn(Federation.Server, "createForDomain").mockResolvedValue({ resolveAddress } as never);

    const first = await resolveFederatedAddress("alice@example.com");
    const second = await resolveFederatedAddress("alice*example.com");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(resolveAddress).toHaveBeenCalledTimes(1);
    if (first.status === "ok") expect(first.data).toEqual({
      publicKey: key,
      stellarAddress: "alice*example.com",
      memo: "7",
      memoType: "id",
    });
  });

  it("rejects malformed addresses before making a network request", async () => {
    const create = vi.spyOn(Federation.Server, "createForDomain");
    const result = await resolveFederatedAddress("alice@example.com/path");
    expect(result.status).toBe("error");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("anchor transfers", () => {
  it("validates and signs the SEP-10 challenge before requesting a JWT", async () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const challengeXdr = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      "anchor.example",
      undefined,
      TEST_PASSPHRASE,
      "anchor.example",
    );
    vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      WEB_AUTH_ENDPOINT: "https://anchor.example/auth",
      SIGNING_KEY: server.publicKey(),
      NETWORK_PASSPHRASE: TEST_PASSPHRASE,
    } as never);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: challengeXdr }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "signed-jwt" }), { status: 200 }));

    const result = await authenticateSep10("https://anchor.example", {
      accountId: client.publicKey(),
      fetch: fetcher,
      signChallenge: async (xdr) => {
        const transaction = TransactionBuilder.fromXDR(xdr, TEST_PASSPHRASE);
        transaction.sign(client);
        return transaction.toXDR();
      },
    });

    expect(result).toEqual({ status: "ok", data: "signed-jwt", error: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");
  });

  it("automatically authenticates and retries a protected SEP-6 request", async () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const challengeXdr = WebAuth.buildChallengeTx(
      server, client.publicKey(), "anchor.example", undefined, TEST_PASSPHRASE, "anchor.example",
    );
    vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example/sep6",
      WEB_AUTH_ENDPOINT: "https://anchor.example/auth",
      SIGNING_KEY: server.publicKey(),
      NETWORK_PASSPHRASE: TEST_PASSPHRASE,
    } as never);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "authentication_required" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ transaction: challengeXdr }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anchor-jwt" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "interactive_customer_info_needed", id: "tx-auth" }), { status: 200 }));

    const result = await initiateSep6Transfer("https://anchor.example", { code: "USDC" }, {
      accountId: client.publicKey(),
      fetch: fetcher,
      signChallenge: async (xdr) => {
        const transaction = TransactionBuilder.fromXDR(xdr, TEST_PASSPHRASE);
        transaction.sign(client);
        return transaction.toXDR();
      },
    });

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new Headers(fetcher.mock.calls[3]?.[1]?.headers).get("authorization")).toBe("Bearer anchor-jwt");
  });

  it("starts SEP-6 deposits and includes asset/account parameters", async () => {
    vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example/sep6",
    } as never);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: "interactive_customer_info_needed", id: "tx-1" }), { status: 200 }));

    const result = await initiateSep6Transfer("https://anchor.example", { code: "USDC", issuer: Keypair.random().publicKey() }, {
      accountId: Keypair.random().publicKey(),
      amount: "12.5",
      fetch: fetcher,
    });

    expect(result.status).toBe("ok");
    const requested = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe("/sep6/deposit");
    expect(requested.searchParams.get("asset_code")).toBe("USDC");
    expect(requested.searchParams.get("amount")).toBe("12.5");
  });

  it("starts SEP-24 interactive transfers with a bearer token", async () => {
    vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER_SEP0024: "https://anchor.example/sep24",
    } as never);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "https://anchor.example/kyc/1", id: "tx-2" }), { status: 200 }));

    const result = await initiateSep24Interactive("https://anchor.example", { code: "USDC" }, {
      accountId: Keypair.random().publicKey(),
      authToken: "jwt-token",
      fetch: fetcher,
    });

    expect(result).toEqual({ status: "ok", data: { url: "https://anchor.example/kyc/1", id: "tx-2" }, error: null });
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer jwt-token");
  });

  it("looks up SEP-6 transaction status by ID", async () => {
    vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({ TRANSFER_SERVER: "https://anchor.example" } as never);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transaction: { id: "tx-3", status: "pending_user_transfer_start" } }), { status: 200 }));

    const result = await getSep6TransactionStatus("https://anchor.example", "tx-3", { fetch: fetcher });

    expect(result.status).toBe("ok");
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("id")).toBe("tx-3");
  });
});

describe("key management", () => {
  it("derives a deterministic SEP-5 path and validates the resulting seed", async () => {
    const first = await deriveKey(VALID_MNEMONIC, "m/44'/148'/0'");
    const second = await deriveKey(VALID_MNEMONIC, "m/44'/148'/0'");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(first.data.publicKey).toBe(second.data.publicKey);
      expect(first.data.secretKey).toBe(second.data.secretKey);
      // SEP-5 Test 5 vector from stellar/stellar-protocol.
      expect(first.data.publicKey).toBe("GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX");
      expect(first.data.secretKey).toBe("SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ");
      expect(validateSecretKey(first.data.secretKey)).toEqual({ status: "ok", data: { publicKey: first.data.publicKey }, error: null });
    }

    const secondAccount = await deriveKey(VALID_MNEMONIC, "m/44'/148'/1'");
    expect(secondAccount.status).toBe("ok");
    if (secondAccount.status === "ok") {
      expect(secondAccount.data.publicKey).toBe("GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV");
    }
  });

  it("rejects non-hardened paths and invalid secret keys", async () => {
    expect((await deriveKey(VALID_MNEMONIC, "m/44/148/0")).status).toBe("error");
    expect(validateSecretKey("not-a-secret").status).toBe("error");
  });

  it("builds a signer replacement transaction without signing it", () => {
    const oldSigner = Keypair.random().publicKey();
    const newSigner = Keypair.random().publicKey();
    const account = new Account(Keypair.random().publicKey(), "1");
    const result = rotateSecretKey({
      account,
      oldPublicKey: oldSigner,
      newPublicKey: newSigner,
      networkPassphrase: TEST_PASSPHRASE,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.operations).toHaveLength(2);
  });
});

describe("on-demand module loading", () => {
  it("loads Soroban, integration, and key management only when requested", async () => {
    const [soroban, integration, keyManagement] = await Promise.all([
      loadSoroban(), loadIntegration(), loadKeyManagement(),
    ]);
    expect(typeof soroban.readContract).toBe("function");
    expect(typeof integration.resolveFederatedAddress).toBe("function");
    expect(typeof keyManagement.deriveKey).toBe("function");

    const core = await import("../core");
    const clientResult = await core.createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status === "ok") {
      expect(typeof clientResult.data.integration.initiateSep24Interactive).toBe("function");
      expect(typeof clientResult.data.shared.deriveKey).toBe("function");
    }
  });
});
