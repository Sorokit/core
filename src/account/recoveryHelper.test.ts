import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRecoverySigner, getRecoveryPlan, removeOldSigner, rotateKeys } from "./recoveryHelper";
import { getAccount } from "./getAccount";
import { getSigners, getThresholds } from "./signers";
import { ok } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

vi.mock("./getAccount", () => ({ getAccount: vi.fn() }));
vi.mock("./signers", () => ({ getSigners: vi.fn(), getThresholds: vi.fn() }));

const mockGetAccount = vi.mocked(getAccount);
const mockGetSigners = vi.mocked(getSigners);
const mockGetThresholds = vi.mocked(getThresholds);
const account = Keypair.random().publicKey();
const recovery = Keypair.random().publicKey();
const oldSigner = Keypair.random().publicKey();
const horizonUrl = "https://horizon-testnet.stellar.org";
const network = { networkPassphrase: Networks.TESTNET } as ResolvedNetworkConfig;

function configure(signers = [
  { key: account, type: "master", weight: 1 },
  { key: recovery, type: "ed25519_public_key", weight: 2 },
  { key: oldSigner, type: "ed25519_public_key", weight: 1 },
]) {
  mockGetAccount.mockResolvedValue(ok({
    publicKey: account,
    displayAddress: account,
    sequence: "100",
    subentryCount: 2,
    balances: [],
  }));
  mockGetSigners.mockResolvedValue(ok({
    masterWeight: signers.find((signer) => signer.type === "master")?.weight ?? 0,
    signers,
  }));
  mockGetThresholds.mockResolvedValue(ok({ low: 1, medium: 2, high: 3 }));
}

describe("recovery helper", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a lower-weight recovery signer", async () => {
    configure([{ key: account, type: "master", weight: 1 }, { key: oldSigner, type: "ed25519_public_key", weight: 2 }]);

    const result = await addRecoverySigner(horizonUrl, network, account, recovery, 1);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, Networks.TESTNET);
      expect(tx.operations).toHaveLength(1);
    }
  });

  it("rejects a signer weight that reaches the high threshold", async () => {
    configure();

    const result = await addRecoverySigner(horizonUrl, network, account, Keypair.random().publicKey(), 3);

    expect(result.status).toBe("error");
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("rotates master weight only when the remaining signer set is safe", async () => {
    configure();

    const result = await rotateKeys(horizonUrl, network, account, Keypair.random().publicKey(), 1);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, Networks.TESTNET);
      expect(tx.operations[0].type).toBe("setOptions");
    }
  });

  it("blocks signer removal before the 48-hour delay", async () => {
    configure();
    const now = 1_700_000_000_000;

    const result = await removeOldSigner(horizonUrl, network, account, oldSigner, now, { now: now + 1 });

    expect(result.status).toBe("error");
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("removes an old signer after the waiting period when thresholds remain reachable", async () => {
    configure();
    const rotatedAt = 1_700_000_000_000;

    const result = await removeOldSigner(
      horizonUrl,
      network,
      account,
      oldSigner,
      rotatedAt,
      { now: rotatedAt + 48 * 60 * 60 * 1000 },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const tx = TransactionBuilder.fromXDR(result.data, Networks.TESTNET);
      expect(tx.operations).toHaveLength(1);
    }
  });

  it("returns a recovery plan and identifies existing backup signers", async () => {
    configure();

    const result = await getRecoveryPlan(horizonUrl, account);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.hasRecoverySigner).toBe(true);
      expect(result.data.steps.map((step) => step.action)).toEqual([
        "add_recovery_signer", "disable_master_key", "wait", "remove_old_signer",
      ]);
      expect(result.data.steps[2].waitMs).toBe(48 * 60 * 60 * 1000);
    }
  });
});