import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const mockLoadAccount = vi.fn();

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    loadAccount: mockLoadAccount,
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

const account = Keypair.random().publicKey();
const recoveryKey = Keypair.random().publicKey();
const compromisedKey = Keypair.random().publicKey();
const newKey = Keypair.random().publicKey();
const secondNewKey = Keypair.random().publicKey();

const network = {
  horizonUrl: "https://example.invalid",
  networkPassphrase: Networks.TESTNET,
  sorobanRpcUrl: "https://example.invalid",
};

function mockAccount(opts: {
  signers: { key: string; weight: number }[];
  thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
}) {
  return {
    accountId: () => account,
    sequenceNumber: () => "1",
    sequence: "1",
    signers: opts.signers,
    thresholds: opts.thresholds ?? {
      low_threshold: 1,
      med_threshold: 2,
      high_threshold: 2,
    },
    incrementSequenceNumber: () => {},
  };
}

function firstOperation(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

describe("recoverAccountKeys (#401)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid account address", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account: "not-a-valid-key",
      recoveryKey,
      newKeys: [{ publicKey: newKey }],
    });

    expect(result.status).toBe("error");
  });

  it("rejects an invalid recovery key address", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey: "not-a-valid-key",
      newKeys: [{ publicKey: newKey }],
    });

    expect(result.status).toBe("error");
  });

  it("rejects when no new keys are provided", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [],
    });

    expect(result.status).toBe("error");
  });

  it("rejects an invalid new-key address", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: "invalid" }],
    });

    expect(result.status).toBe("error");
  });

  it("rejects an invalid compromised-key address", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey }],
      compromisedKeys: ["invalid"],
    });

    expect(result.status).toBe("error");
  });

  it("rejects listing the recovery key as compromised", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey }],
      compromisedKeys: [recoveryKey],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("recovery key cannot be listed");
    }
  });

  it("rejects a key listed as both new and compromised", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: compromisedKey }],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("error");
  });

  it("rejects recovery when the recovery key is not currently an active signer", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [{ key: account, weight: 1 }],
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey }],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("not currently an active signer");
    }
  });

  it("rejects recovery of a compromised key that is not currently a signer", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: account, weight: 1 },
          { key: recoveryKey, weight: 1 },
        ],
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey }],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("nothing to recover");
    }
  });

  it("supports single-signer recovery: replaces a compromised key with a new key", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: account, weight: 1 },
          { key: recoveryKey, weight: 1 },
          { key: compromisedKey, weight: 1 },
        ],
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey, weight: 1 }],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = firstOperation(result.data);
      expect(ops).toHaveLength(2);
      expect(ops[0]?.type).toBe("setOptions");
      // New key added before the old one is removed.
      if (ops[0]?.type === "setOptions") {
        expect(ops[0].signer?.ed25519PublicKey).toBe(newKey);
        expect(ops[0].signer?.weight).toBe(1);
      }
      if (ops[1]?.type === "setOptions") {
        expect(ops[1].signer?.ed25519PublicKey).toBe(compromisedKey);
        expect(ops[1].signer?.weight).toBe(0);
      }
    }
  });

  it("supports multi-signature recovery with multiple new keys", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: account, weight: 1 },
          { key: recoveryKey, weight: 2 },
          { key: compromisedKey, weight: 1 },
        ],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [
        { publicKey: newKey, weight: 1 },
        { publicKey: secondNewKey, weight: 1 },
      ],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = firstOperation(result.data);
      // 2 new keys added + 1 compromised key removed.
      expect(ops).toHaveLength(3);
    }
  });

  it("preserves required signer thresholds during recovery by default", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: account, weight: 1 },
          { key: recoveryKey, weight: 1 },
          { key: compromisedKey, weight: 1 },
        ],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey, weight: 1 }],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = firstOperation(result.data);
      // No explicit threshold-update operation since none was requested.
      expect(ops.every((op) => op.type === "setOptions")).toBe(true);
      expect(ops).toHaveLength(2);
    }
  });

  it("applies explicit threshold updates when requested, between adding and removing keys", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: account, weight: 1 },
          { key: recoveryKey, weight: 1 },
          { key: compromisedKey, weight: 1 },
        ],
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey, weight: 3 }],
      compromisedKeys: [compromisedKey],
      lowThreshold: 1,
      medThreshold: 3,
      highThreshold: 3,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = firstOperation(result.data);
      expect(ops).toHaveLength(3);
      // Middle operation is the threshold update.
      if (ops[1]?.type === "setOptions") {
        expect(ops[1].lowThreshold).toBe(1);
        expect(ops[1].medThreshold).toBe(3);
        expect(ops[1].highThreshold).toBe(3);
      }
    }
  });

  it("prevents recovery that would leave total signer weight below the high threshold", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: recoveryKey, weight: 1 },
          { key: compromisedKey, weight: 5 },
        ],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 5 },
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey, weight: 1 }],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("below the account's high threshold");
    }
  });

  it("prevents recovery that would leave the account with zero total signer weight", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    // recoveryKey has weight 0 (a signer entry that carries no authority —
    // e.g. previously demoted), compromisedKey (the only weighted signer)
    // is being removed, and its replacement is added at weight 0 too — so
    // the resulting account would have zero total signer weight, an
    // unrecoverable lockout that must be rejected outright.
    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: recoveryKey, weight: 0 },
          { key: compromisedKey, weight: 1 },
        ],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey, weight: 0 }],
      compromisedKeys: [compromisedKey],
    });

    // The recovery key itself has weight 0, so it's correctly rejected as
    // "not currently an active signer" before the zero-weight check is
    // ever reached — active-signer status requires weight > 0.
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("not currently an active signer");
    }
  });

  it("prevents recovery that would zero out total weight via a self-demoting new-key entry", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    // The recovery key demotes itself to weight 0 (listed in newKeys,
    // which overwrites its resulting weight) while removing the only
    // other signer — the account would end up with zero total weight.
    mockLoadAccount.mockResolvedValue(
      mockAccount({
        signers: [
          { key: recoveryKey, weight: 1 },
          { key: compromisedKey, weight: 1 },
        ],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      }),
    );

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: recoveryKey, weight: 0 }],
      compromisedKeys: [compromisedKey],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("zero total signer weight");
    }
  });

  it("surfaces an account-fetch failure as an error result", async () => {
    const { recoverAccountKeys } = await import("../account/keyRotation");

    mockLoadAccount.mockRejectedValue(new Error("horizon unreachable"));

    const result = await recoverAccountKeys(network.horizonUrl, network, {
      account,
      recoveryKey,
      newKeys: [{ publicKey: newKey }],
    });

    expect(result.status).toBe("error");
  });
});
