/**
 * End-to-end tests against real Stellar testnet (issue #610).
 *
 * Unlike src/tests/integration.test.ts (which needs a human to pre-fund and
 * provide STELLAR_TESTNET_SOURCE_SECRET/STELLAR_TESTNET_DESTINATION), every
 * account this suite needs is created and funded automatically via
 * Friendbot at run time — no secrets to provision or rotate. Accounts are
 * throwaway testnet keypairs; the closest thing to "cleanup" Stellar offers
 * is merging an account away, which the account-merge scenario itself
 * exercises on its own dedicated account.
 *
 * Skipped by default (so `npm test` stays fast/offline and CI-safe for
 * every other change) — run explicitly with `npm run test:e2e`, which sets
 * RUN_E2E=1. The nightly workflow (.github/workflows/e2e.yml) runs the same
 * command on a schedule against live testnet.
 *
 * Scope note: Soroban contract deployment (uploading a new .wasm) needs a
 * compiled contract binary this repo doesn't ship, and building one is
 * outside a JS/TS SDK's test fixtures. The Soroban scenario here instead
 * *invokes* a real, already-deployed contract — the native XLM Stellar
 * Asset Contract, which is deterministic and always present on any Stellar
 * network — exercising the full live simulate/read path end to end.
 * Deployment itself is covered by the existing mocked
 * src/tests/integration/soroban-contract.test.ts.
 */
import { Asset, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { Address } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { createSorokitClient } from "../client/createSorokitClient";
import { buildManageOfferTransaction } from "../transaction/buildTransaction";
import { buildMultiSigEnvelope, collectSignature } from "../transaction/multiSig";
import { ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

const RUN_E2E = Boolean(process.env.RUN_E2E);
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

function sign(xdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  tx.sign(keypair);
  return tx.toXDR();
}

/** Funds a fresh testnet keypair via Friendbot, retrying transient failures (rate limits, hiccups). */
async function createFundedAccount(retries = 3): Promise<Keypair> {
  const keypair = Keypair.random();
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(keypair.publicKey())}`);
      if (res.ok) return keypair;
      lastError = new Error(`Friendbot responded ${res.status} for ${keypair.publicKey()}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe.skipIf(!RUN_E2E)("E2E: Stellar testnet (#610)", () => {
  const clientResult = createSorokitClient({ network: "testnet" });
  if (clientResult.status !== "ok") {
    throw new Error(`Failed to create testnet client: ${clientResult.error.message}`);
  }
  const client = clientResult.data;

  // Shared, pre-funded accounts most scenarios reuse, so the suite doesn't
  // pay a Friendbot round trip per scenario. Scenarios that need an
  // account in a specific *fresh* state (creation, multi-sig threshold
  // changes, merge) create their own instead of reusing these.
  let accountA: Keypair;
  let accountB: Keypair;

  beforeAll(async () => {
    [accountA, accountB] = await Promise.all([createFundedAccount(), createFundedAccount()]);
  }, 60_000);

  it("creates and funds a new account via Friendbot", async () => {
    const fresh = await createFundedAccount();

    const result = await client.account.get(fresh.publicKey());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.publicKey).toBe(fresh.publicKey());
      expect(Number(result.data.balances.find((b) => b.assetType === "native")?.balance ?? 0)).toBeGreaterThan(0);
    }
  }, 30_000);

  it("submits a payment and verifies it on both the transaction and the receiving balance", async () => {
    const before = await client.account.get(accountB.publicKey());
    expect(before.status).toBe("ok");
    const balanceBefore =
      before.status === "ok"
        ? Number(before.data.balances.find((b) => b.assetType === "native")?.balance ?? 0)
        : 0;

    const unsigned = await client.transaction.buildPayment(accountA.publicKey(), {
      destination: accountB.publicKey(),
      amount: "1.5000000",
      memo: "sorokit e2e payment",
    });
    expect(unsigned.status).toBe("ok");
    if (unsigned.status !== "ok") return;

    const submitted = await client.transaction.submit(sign(unsigned.data, accountA));
    expect(submitted.status).toBe("ok");
    if (submitted.status !== "ok") return;

    const status = await client.transaction.getStatus(submitted.data.hash);
    expect(status.status).toBe("ok");
    if (status.status === "ok") {
      expect(status.data.hash).toBe(submitted.data.hash);
      expect(status.data.status).toBe("success");
    }

    const after = await client.account.get(accountB.publicKey());
    expect(after.status).toBe("ok");
    if (after.status === "ok") {
      const balanceAfter = Number(after.data.balances.find((b) => b.assetType === "native")?.balance ?? 0);
      expect(balanceAfter).toBeCloseTo(balanceBefore + 1.5, 5);
    }
  }, 60_000);

  it("collects a multi-sig approval and submits once the threshold is met", async () => {
    const [primary, cosigner] = await Promise.all([createFundedAccount(), createFundedAccount()]);

    // Add cosigner with weight 1, raise the medium threshold to 2 so a
    // payment now needs both primary's own weight-1 key and cosigner's.
    const setOptions = await client.transaction.buildSetOptions(primary.publicKey(), {
      signers: [{ publicKey: cosigner.publicKey(), weight: 1 }],
      medThreshold: 2,
    });
    expect(setOptions.status).toBe("ok");
    if (setOptions.status !== "ok") return;
    const setOptionsSubmit = await client.transaction.submit(sign(setOptions.data, primary));
    expect(setOptionsSubmit.status).toBe("ok");

    const unsignedPayment = await client.transaction.buildPayment(primary.publicKey(), {
      destination: accountB.publicKey(),
      amount: "1.0000000",
      memo: "sorokit e2e multisig",
    });
    expect(unsignedPayment.status).toBe("ok");
    if (unsignedPayment.status !== "ok") return;

    const envelopeResult = buildMultiSigEnvelope(unsignedPayment.data, NETWORK_PASSPHRASE, {
      signers: [
        { publicKey: primary.publicKey(), weight: 1 },
        { publicKey: cosigner.publicKey(), weight: 1 },
      ],
      threshold: 2,
    });
    expect(envelopeResult.status).toBe("ok");
    if (envelopeResult.status !== "ok") return;

    const signFn = async (xdr: string, signerKey: string): Promise<SorokitResult<string>> => {
      const keypair = signerKey === primary.publicKey() ? primary : cosigner;
      return ok(sign(xdr, keypair));
    };

    const afterPrimary = await collectSignature(envelopeResult.data, primary.publicKey(), signFn);
    expect(afterPrimary.status).toBe("ok");
    if (afterPrimary.status !== "ok") return;
    expect(afterPrimary.data.thresholdMet).toBe(false);

    const afterCosigner = await collectSignature(afterPrimary.data, cosigner.publicKey(), signFn);
    expect(afterCosigner.status).toBe("ok");
    if (afterCosigner.status !== "ok") return;
    expect(afterCosigner.data.thresholdMet).toBe(true);

    const submitted = await client.transaction.submit(afterCosigner.data.envelopeXdr);
    expect(submitted.status).toBe("ok");
    if (submitted.status === "ok") {
      const status = await client.transaction.getStatus(submitted.data.hash);
      expect(status.status).toBe("ok");
      if (status.status === "ok") expect(status.data.status).toBe("success");
    }
  }, 60_000);

  it("invokes a real, already-deployed Soroban contract (native XLM SAC balance)", async () => {
    const nativeContractId = Asset.native().contractId(NETWORK_PASSPHRASE);

    const result = await client.soroban.read({
      contractId: nativeContractId,
      method: "balance",
      args: [Address.fromString(accountA.publicKey()).toScVal()],
      publicKey: accountA.publicKey(),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // A funded account's native-asset SAC balance is a positive i128.
      expect(result.data).toBeDefined();
    }
  }, 30_000);

  it("creates and cancels a DEX offer", async () => {
    const networkConfig: ResolvedNetworkConfig = {
      network: "testnet",
      horizonUrl: HORIZON_URL,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: NETWORK_PASSPHRASE,
    };

    // A buy offer requires a trustline to the buying asset first — Horizon
    // rejects manage_sell_offer with op_no_trust otherwise.
    const unsignedTrustline = await client.transaction.buildTrustline(accountA.publicKey(), {
      assetCode: "SOROKITE2E",
      assetIssuer: accountB.publicKey(),
    });
    expect(unsignedTrustline.status).toBe("ok");
    if (unsignedTrustline.status !== "ok") return;
    const trustlineSubmit = await client.transaction.submit(sign(unsignedTrustline.data, accountA));
    expect(trustlineSubmit.status).toBe("ok");

    const unsignedOffer = await buildManageOfferTransaction(HORIZON_URL, networkConfig, accountA.publicKey(), {
      sellingAssetCode: "XLM",
      buyingAssetCode: "SOROKITE2E",
      buyingAssetIssuer: accountB.publicKey(),
      amount: "5.0000000",
      price: "1.0000000",
    });
    expect(unsignedOffer.status).toBe("ok");
    if (unsignedOffer.status !== "ok") return;

    const submittedOffer = await client.transaction.submit(sign(unsignedOffer.data, accountA));
    expect(submittedOffer.status).toBe("ok");
    if (submittedOffer.status !== "ok") return;

    const offerStatus = await client.transaction.getStatus(submittedOffer.data.hash);
    expect(offerStatus.status).toBe("ok");
    if (offerStatus.status === "ok") expect(offerStatus.data.status).toBe("success");

    // Cancel: re-fetch the account's open offers and zero out the amount on
    // the one we just created, so the suite doesn't leave a resting offer
    // on the testnet order book.
    const openOffers = await client.account.getOffers(accountA.publicKey());
    expect(openOffers.status).toBe("ok");
    if (openOffers.status !== "ok") return;
    const ourOffer = openOffers.data.records.find(
      (offer) => offer.buying.code === "SOROKITE2E" && offer.seller === accountA.publicKey(),
    );
    if (!ourOffer) return; // Already filled or not found — nothing to cancel.

    const cancelOffer = await buildManageOfferTransaction(HORIZON_URL, networkConfig, accountA.publicKey(), {
      sellingAssetCode: "XLM",
      buyingAssetCode: "SOROKITE2E",
      buyingAssetIssuer: accountB.publicKey(),
      amount: "0",
      price: "1.0000000",
      offerId: ourOffer.id,
    });
    expect(cancelOffer.status).toBe("ok");
    if (cancelOffer.status !== "ok") return;
    const cancelSubmit = await client.transaction.submit(sign(cancelOffer.data, accountA));
    expect(cancelSubmit.status).toBe("ok");
  }, 60_000);

  it("merges a throwaway account into another and confirms it no longer exists", async () => {
    const throwaway = await createFundedAccount();

    const unsignedMerge = await client.transaction.buildAccountMerge(throwaway.publicKey(), accountB.publicKey());
    expect(unsignedMerge.status).toBe("ok");
    if (unsignedMerge.status !== "ok") return;

    const submitted = await client.transaction.submit(sign(unsignedMerge.data, throwaway));
    expect(submitted.status).toBe("ok");
    if (submitted.status !== "ok") return;

    const status = await client.transaction.getStatus(submitted.data.hash);
    expect(status.status).toBe("ok");
    if (status.status === "ok") expect(status.data.status).toBe("success");

    const afterMerge = await client.account.get(throwaway.publicKey());
    expect(afterMerge.status).toBe("error");
    if (afterMerge.status === "error") {
      expect(afterMerge.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  }, 60_000);

  it("surfaces a real not-found error as a SorokitResult, never throwing (no-throw model, ADR-001)", async () => {
    const neverFunded = Keypair.random();

    const result = await client.account.get(neverFunded.publicKey());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      // classifyError (shared/response.ts) buckets every ACCOUNT_* code under
      // "internal" category, not "network" — even though this one originates
      // from a Horizon 404. Asserting the real value here, not an assumption.
      expect(result.error.category).toBe("internal");
    }
  }, 30_000);
});

if (!RUN_E2E) {
  console.warn("Skipping E2E testnet suite: set RUN_E2E=1 (or run `npm run test:e2e`) to execute it live.");
}
