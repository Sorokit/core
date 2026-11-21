/**
 * Tests for recoverAccountKeys (#401) and fee surge logic (#735).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Networks, TransactionBuilder, Operation } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { AccountInfo } from "../account/types";
import type { ResolvedNetworkConfig } from "../shared/types";

const mockGetAccount = vi.hoisted(() => vi.fn());
const mockFetchCongestionFeeEstimate = vi.hoisted(() => vi.fn());

vi.mock("../account/getAccount", () => ({
  getAccount: mockGetAccount,
}));

vi.mock("../transaction/estimateFee", () => ({
  fetchCongestionFeeEstimate: mockFetchCongestionFeeEstimate,
}));

import { recoverAccountKeys, rotateAccountKey, setAccountRecovery } from "../account/keyRotation";

const NETWORK_CONFIG: ResolvedNetworkConfig = {
  network: "mainnet",
  horizonUrl: "https://horizon.stellar.org",
  rpcUrl: "https://soroban.stellar.org",
  networkPassphrase: Networks.PUBLIC,
};

function fakeAccount(publicKey: string, sequence = "100"): AccountInfo {
  return {
    publicKey,
    displayAddress: `${publicKey.slice(0, 5)}...${publicKey.slice(-4)}`,
    sequence,
    subentryCount: 0,
    balances: [],
  };
}

describe("keyRotation fee surge logic (#735)", () => {
  let account: string;
  let oldKey: string;
  let newKey: string;
  let recoveryKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    account = Keypair.random().publicKey();
    oldKey = Keypair.random().publicKey();
    newKey = Keypair.random().publicKey();
    recoveryKey = Keypair.random().publicKey();
    mockGetAccount.mockResolvedValue(ok(fakeAccount(account)));
    mockFetchCongestionFeeEstimate.mockResolvedValue({ recommendedFee: "2500" });
  });

  it("rotateAccountKey uses an explicit fee override", async () => {
    const result = await rotateAccountKey("https://horizon.stellar.org", NETWORK_CONFIG, {
      account,
      oldKey,
      newKey,
      fee: "5000",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
      // 5000 base fee * 2 operations (add key, remove key) = 10000 total max fee
      expect(tx.fee).toBe("10000");
    }
    expect(mockFetchCongestionFeeEstimate).not.toHaveBeenCalled();
  });

  it("rotateAccountKey fetches congestion fee when no fee is supplied", async () => {
    const result = await rotateAccountKey("https://horizon.stellar.org", NETWORK_CONFIG, {
      account,
      oldKey,
      newKey,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
      // 2500 estimated fee * 2 operations (add key, remove key) = 5000 total max fee
      expect(tx.fee).toBe("5000");
    }
    expect(mockFetchCongestionFeeEstimate).toHaveBeenCalledTimes(1);
  });

  it("setAccountRecovery fetches congestion fee when no fee is supplied", async () => {
    const result = await setAccountRecovery("https://horizon.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
      // 2500 estimated fee * 1 operation = 2500 total max fee
      expect(tx.fee).toBe("2500");
    }
    expect(mockFetchCongestionFeeEstimate).toHaveBeenCalledTimes(1);
  });

  it("recoverAccountKeys fetches congestion fee when no fee is supplied", async () => {
    const result = await recoverAccountKeys("https://horizon.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 1 }],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
      // 2500 estimated fee * 1 operation = 2500 total max fee
      expect(tx.fee).toBe("2500");
    }
    expect(mockFetchCongestionFeeEstimate).toHaveBeenCalledTimes(1);
  });
});

describe("recoverAccountKeys (#401)", () => {
  let account: string;
  let recoveryKey: string;
  let compromisedKey: string;
  let newKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    account = Keypair.random().publicKey();
    recoveryKey = Keypair.random().publicKey();
    compromisedKey = Keypair.random().publicKey();
    newKey = Keypair.random().publicKey();
    mockGetAccount.mockResolvedValue(ok(fakeAccount(account)));
    mockFetchCongestionFeeEstimate.mockResolvedValue({ recommendedFee: "100" });
  });

  it("rejects an invalid account address", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account: "not-a-valid-key",
      recoveryKey,
      newKeys: [{ key: newKey, weight: 1 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    }
  });

  it("rejects an invalid recovery key address", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey: "bad-key",
      newKeys: [{ key: newKey, weight: 1 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    }
  });

  it("rejects an invalid compromised key address", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      compromisedKeys: ["invalid"],
      newKeys: [{ key: newKey, weight: 1 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    }
  });

  it("rejects when newKeys is empty", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toMatch(/at least one replacement key/i);
    }
  });

  it("rejects an invalid new-signer weight", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 0 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/invalid weight/i);
    }
  });

  it("rejects a weight above 255", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 256 }],
    });
    expect(result.status).toBe("error");
  });

  it("rejects duplicate keys within newKeys", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [
        { key: newKey, weight: 1 },
        { key: newKey, weight: 2 },
      ],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/duplicate replacement key/i);
    }
  });

  it("rejects a key appearing in both compromisedKeys and newKeys", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      compromisedKeys: [newKey],
      newKeys: [{ key: newKey, weight: 1 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/cannot appear in both/i);
    }
  });

  it("rejects an out-of-range threshold", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 1 }],
      medThreshold: 256,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/thresholds must be integers/i);
    }
  });

  it("rejects a threshold that exceeds the installed signer weight with no masterWeight override", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 1 }],
      medThreshold: 5,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/could lock the account out/i);
    }
  });

  it("allows a high threshold when masterWeight compensates", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 1 }],
      medThreshold: 5,
      masterWeight: 10,
    });
    expect(result.status).toBe("ok");
  });

  it("propagates a getAccount failure", async () => {
    mockGetAccount.mockResolvedValueOnce(
      err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "Account not found"),
    );
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 1 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });

  it("builds a single-signer recovery transaction: adds new key, removes compromised key", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      compromisedKeys: [compromisedKey],
      newKeys: [{ key: newKey, weight: 1 }],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
    const ops = "operations" in tx ? tx.operations : [];
    expect(ops).toHaveLength(2);

    const [addOp, removeOp] = ops as Operation.SetOptions[];
    expect(addOp.type).toBe("setOptions");
    expect(addOp.signer?.ed25519PublicKey).toBe(newKey);
    expect(addOp.signer?.weight).toBe(1);

    expect(removeOp.type).toBe("setOptions");
    expect(removeOp.signer?.ed25519PublicKey).toBe(compromisedKey);
    expect(removeOp.signer?.weight).toBe(0);
  });

  it("builds a multi-signature recovery transaction installing multiple new signers and thresholds", async () => {
    const secondKey = Keypair.random().publicKey();
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      compromisedKeys: [compromisedKey],
      newKeys: [
        { key: newKey, weight: 1 },
        { key: secondKey, weight: 1 },
      ],
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 2,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
    const ops = ("operations" in tx ? tx.operations : []) as Operation.SetOptions[];
    expect(ops).toHaveLength(4);
    expect(ops[0]?.signer?.ed25519PublicKey).toBe(newKey);
    expect(ops[1]?.signer?.ed25519PublicKey).toBe(secondKey);
    expect(ops[2]?.lowThreshold).toBe(1);
    expect(ops[2]?.medThreshold).toBe(2);
    expect(ops[2]?.highThreshold).toBe(2);
    expect(ops[3]?.signer?.ed25519PublicKey).toBe(compromisedKey);
    expect(ops[3]?.signer?.weight).toBe(0);
  });

  it("supports recovery with no compromised keys (adding signers only)", async () => {
    const result = await recoverAccountKeys("https://horizon-testnet.stellar.org", NETWORK_CONFIG, {
      account,
      recoveryKey,
      newKeys: [{ key: newKey, weight: 2 }],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
    const ops = ("operations" in tx ? tx.operations : []) as Operation.SetOptions[];
    expect(ops).toHaveLength(1);
    expect(ops[0]?.signer?.weight).toBe(2);
  });
});
