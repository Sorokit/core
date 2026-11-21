import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateNetworkPassphrase,
  validateAmountPrecision,
  STELLAR_MAINNET_PASSPHRASE,
  STELLAR_TESTNET_PASSPHRASE,
} from "./validation";
import { SorokitErrorCode } from "./response";
import type { ResolvedNetworkConfig } from "./types";
import { buildPaymentTransaction } from "../transaction/buildTransaction";
import { buildContractDeploy } from "../soroban/deployContract";
import { getSacBalance, buildSacTransfer, buildSacApprove } from "../soroban/sacHelpers";
import { prepareContractCall } from "../soroban/prepareCall";
import { readContract } from "../soroban/readContract";

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("validateNetworkPassphrase", () => {
  it("accepts the mainnet passphrase", () => {
    const result = validateNetworkPassphrase(STELLAR_MAINNET_PASSPHRASE);
    expect(result.status).toBe("ok");
    expect(result.data).toBeUndefined();
  });

  it("accepts the testnet passphrase", () => {
    const result = validateNetworkPassphrase(STELLAR_TESTNET_PASSPHRASE);
    expect(result.status).toBe("ok");
    expect(result.data).toBeUndefined();
  });

  it("rejects an empty string with INVALID_NETWORK", () => {
    const result = validateNetworkPassphrase("");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("rejects a garbage string with INVALID_NETWORK", () => {
    const result = validateNetworkPassphrase("not a passphrase");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("rejects a close-but-wrong passphrase with INVALID_NETWORK", () => {
    const result = validateNetworkPassphrase(
      "Public Global Stellar Network ; September 2016",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });
});

// ─── Integration-path tests ───────────────────────────────────────────────────
//
// Each test passes a syntactically valid but wrong passphrase to an integration
// site and asserts that INVALID_NETWORK surfaces as the error code — confirming
// the validator fires before any network call and that the code is not re-wrapped
// under a domain-specific code.

const BAD_PASSPHRASE = "Wrong Network ; September 2015";
const sourceKey = Keypair.random().publicKey();
const destKey = Keypair.random().publicKey();

function badNetworkConfig(): ResolvedNetworkConfig {
  return {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: BAD_PASSPHRASE,
  };
}

describe("validateNetworkPassphrase — integration paths", () => {
  it("buildPaymentTransaction returns INVALID_NETWORK before any network call", async () => {
    const result = await buildPaymentTransaction(
      "https://horizon-testnet.stellar.org",
      badNetworkConfig(),
      sourceKey,
      {
        destination: destKey,
        amount: "10",
        // sequenceNumber provided → offline mode; still rejected before resolveSourceAccount
        sequenceNumber: "0",
      },
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("buildContractDeploy returns INVALID_NETWORK before any network call", async () => {
    // A minimal valid WASM magic header (4 bytes)
    const validWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const result = await buildContractDeploy(
      validWasm,
      sourceKey,
      {
        rpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkConfig: badNetworkConfig(),
      },
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("getSacBalance returns INVALID_NETWORK before any network call", async () => {
    // A syntactically valid contract ID (C + 55 uppercase base32 chars)
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = await getSacBalance(
      "https://soroban-testnet.stellar.org",
      "https://horizon-testnet.stellar.org",
      badNetworkConfig(),
      contractId,
      sourceKey,
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("buildSacTransfer returns INVALID_NETWORK before any network call", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = await buildSacTransfer(
      "https://soroban-testnet.stellar.org",
      badNetworkConfig(),
      "https://horizon-testnet.stellar.org",
      contractId,
      sourceKey,
      destKey,
      "1.0",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("buildSacApprove returns INVALID_NETWORK before any network call", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = await buildSacApprove(
      "https://soroban-testnet.stellar.org",
      badNetworkConfig(),
      "https://horizon-testnet.stellar.org",
      contractId,
      sourceKey,
      destKey,
      "1.0",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("prepareContractCall returns INVALID_NETWORK before any network call", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = await prepareContractCall(
      "https://soroban-testnet.stellar.org",
      badNetworkConfig(),
      "https://horizon-testnet.stellar.org",
      {
        contractId,
        method: "transfer",
        args: [],
        publicKey: sourceKey,
      },
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("readContract returns INVALID_NETWORK before any network call", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = await readContract(
      "https://soroban-testnet.stellar.org",
      "https://horizon-testnet.stellar.org",
      badNetworkConfig(),
      {
        contractId,
        publicKey: sourceKey,
        method: "balance",
        args: [],
      },
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });
});

// ─── validateAmountPrecision ──────────────────────────────────────────────────

describe("validateAmountPrecision", () => {
  it("accepts a valid 7dp amount", () => {
    const result = validateAmountPrecision("1.1234567");
    expect(result.status).toBe("ok");
  });

  it("accepts a valid fewer-decimal amount", () => {
    const result = validateAmountPrecision("1.123");
    expect(result.status).toBe("ok");
  });

  it("accepts an integer amount with no decimal point", () => {
    const result = validateAmountPrecision("100");
    expect(result.status).toBe("ok");
  });

  it("accepts the smallest valid 7dp amount", () => {
    const result = validateAmountPrecision("0.0000001");
    expect(result.status).toBe("ok");
  });

  it("accepts an amount with trailing zeros within the limit", () => {
    const result = validateAmountPrecision("1.1000000");
    expect(result.status).toBe("ok");
  });

  it("rejects an 8dp amount with VALIDATION", () => {
    const result = validateAmountPrecision("1.12345678");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.VALIDATION);
  });

  it("rejects an amount with custom 2dp limit when it has 3dp", () => {
    const result = validateAmountPrecision("1.123", 2);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.VALIDATION);
  });

  it("accepts an amount with custom 2dp limit when it has exactly 2dp", () => {
    const result = validateAmountPrecision("1.12", 2);
    expect(result.status).toBe("ok");
  });

  it("accepts a negative amount within the precision limit", () => {
    const result = validateAmountPrecision("-1.123");
    expect(result.status).toBe("ok");
  });

  it("rejects a non-numeric string with VALIDATION", () => {
    const result = validateAmountPrecision("abc");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.VALIDATION);
  });

  it("rejects a double-decimal string with VALIDATION", () => {
    const result = validateAmountPrecision("1.2.3");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.VALIDATION);
  });

  it("rejects an empty string with VALIDATION", () => {
    const result = validateAmountPrecision("");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.VALIDATION);
  });
});
