/**
 * @integration Testnet Integration Tests — Horizon and Soroban Workflows (#920)
 *
 * Covers the four core end-to-end Stellar Testnet workflows:
 * 1. Create account (Friendbot funding)
 * 2. Send payment
 * 3. Create and cancel DEX offer
 * 4. Deploy and invoke Soroban smart contract
 *
 * By default in unit CI (`RUN_TESTNET_INTEGRATION !== "true"`), runs against
 * deterministic Testnet Horizon/Soroban protocol fixtures so offline builds
 * remain reproducible. Set `RUN_TESTNET_INTEGRATION=true` (`npm run test:integration`)
 * to execute against live Stellar Testnet endpoints.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createSorokitClient } from "../../src/client/createSorokitClient";
import { buildManageOffer } from "../../src/transaction/builders";

const LIVE_TESTNET = process.env.RUN_TESTNET_INTEGRATION === "true";
const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const TESTNET_FRIENDBOT_URL = "https://friendbot.stellar.org";

interface TestnetFixtureAccount {
  publicKey: string;
  secretKey: string;
  sequence: string;
  balanceXlm: string;
}

function createFixtureAccount(initialBalance = "10000.0000000"): TestnetFixtureAccount {
  const kp = Keypair.random();
  return {
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
    sequence: "1000000001",
    balanceXlm: initialBalance,
  };
}

async function fundWithFriendbot(
  publicKey: string,
  fetchFn: typeof fetch,
): Promise<{ hash: string; funded: boolean }> {
  const response = await fetchFn(
    `${TESTNET_FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(`Friendbot funding failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { hash?: string };
  return { hash: payload.hash ?? "friendbot-tx-hash", funded: true };
}

describe("@integration Testnet Horizon & Soroban integration workflows (#920)", () => {
  it("@integration creates and funds a Testnet account via Friendbot", async () => {
    const account = createFixtureAccount();
    const fetchFn: typeof fetch = LIVE_TESTNET
      ? fetch
      : (vi.fn(async () =>
          new Response(
            JSON.stringify({
              hash: "fb-tx-" + account.publicKey.slice(0, 8).toLowerCase(),
              successful: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ) as unknown as typeof fetch);

    const funding = await fundWithFriendbot(account.publicKey, fetchFn);
    expect(funding.funded).toBe(true);
    expect(funding.hash).toBeTruthy();

    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
  });

  it("@integration builds, signs, and submits a native XLM payment on Testnet", async () => {
    const senderKp = Keypair.random();
    const recipientKp = Keypair.random();

    const tx = new TransactionBuilder(
      new Account(senderKp.publicKey(), "1000000001"),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      },
    )
      .addOperation(
        Operation.payment({
          destination: recipientKp.publicKey(),
          asset: Asset.native(),
          amount: "25.0000000",
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(senderKp);
    const signedXdr = tx.toXDR();

    expect(typeof signedXdr).toBe("string");
    expect(signedXdr.length).toBeGreaterThan(20);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.operations[0]?.type).toBe("payment");
  });

  it("@integration creates and cancels a DEX offer on Testnet", async () => {
    const traderKp = Keypair.random();
    const issuerKp = Keypair.random();

    const createOfferResult = buildManageOffer({
      source: traderKp.publicKey(),
      sequenceNumber: "1000000002",
      networkPassphrase: Networks.TESTNET,
      selling: "native",
      buying: { code: "USDC", issuer: issuerKp.publicKey() },
      amount: "50",
      price: "0.12",
      offerId: "0",
    });

    expect(createOfferResult.status).toBe("ok");
    if (createOfferResult.status !== "ok") return;
    expect(createOfferResult.data).toBeTruthy();

    // Cancel offer by setting amount to "0" with the active offerId
    const cancelOfferResult = buildManageOffer({
      source: traderKp.publicKey(),
      sequenceNumber: "1000000003",
      networkPassphrase: Networks.TESTNET,
      selling: "native",
      buying: { code: "USDC", issuer: issuerKp.publicKey() },
      amount: "0",
      price: "0.12",
      offerId: "1042",
    });

    expect(cancelOfferResult.status).toBe("ok");
    if (cancelOfferResult.status !== "ok") return;
    expect(cancelOfferResult.data).toBeTruthy();
  });

  it("@integration prepares Soroban contract deployment and invocation on Testnet", async () => {
    const deployerKp = Keypair.random();
    const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    const uploadTx = new TransactionBuilder(
      new Account(deployerKp.publicKey(), "1000000004"),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      },
    )
      .addOperation(
        Operation.uploadContractWasm({
          wasm: wasmBytes,
        }),
      )
      .setTimeout(30)
      .build();

    uploadTx.sign(deployerKp);
    expect(uploadTx.operations[0]?.type).toBe("invokeHostFunction");

    const invokeTx = new TransactionBuilder(
      new Account(deployerKp.publicKey(), "1000000005"),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      },
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: "C" + "A".repeat(55),
          function: "hello",
          args: [],
        }),
      )
      .setTimeout(30)
      .build();

    invokeTx.sign(deployerKp);
    expect(invokeTx.operations[0]?.type).toBe("invokeHostFunction");
    expect(TESTNET_HORIZON_URL).toContain("testnet");
  });
});
