import { describe, expect, it, vi } from "vitest";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildCreateClaimableBalance, buildClaimClaimableBalance,
  validateClaimableAmount, validateClaimableBalanceId, validateClaimantAddress,
  validateClaimPredicate,
} from "../transaction/claimableBalance";
import { checkMainnetSafety } from "../shared/mainnetSafety";
import type { ClaimPredicateInput } from "../transaction/types";

const source = Keypair.random().publicKey();
const claimant = Keypair.random().publicKey();
const network = { network: "mainnet" as const, networkPassphrase: Networks.PUBLIC, horizonUrl: "https://horizon.invalid", rpcUrl: "https://rpc.invalid" };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("claimable balance builders and Mainnet safety", () => {
  it.each<ClaimPredicateInput>([
    { type: "unconditional" },
    { type: "beforeAbsoluteTime", timestamp: "2000000000" },
    { type: "afterAbsoluteTime", timestamp: "2000000000" },
    { type: "beforeRelativeTime", seconds: "100" },
    { type: "afterRelativeTime", seconds: "100" },
    { type: "and", predicates: [{ type: "afterRelativeTime", seconds: "100" }, { type: "beforeRelativeTime", seconds: "200" }] },
    { type: "or", predicates: [{ type: "unconditional" }, { type: "beforeRelativeTime", seconds: "200" }] },
    { type: "not", predicate: { type: "beforeRelativeTime", seconds: "100" } },
  ])("preserves the predicate and guards an offline native balance: $type", async predicate => {
    const result = await buildCreateClaimableBalance(network.horizonUrl, network, source, {
      amount: "1000.0000001", claimant, predicate, sequenceNumber: "1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(result.error.message);
    const tx = TransactionBuilder.fromXDR(result.data, Networks.PUBLIC);
    expect("operations" in tx && tx.operations[0]?.type).toBe("createClaimableBalance");
    expect(checkMainnetSafety(result.data, Networks.PUBLIC, { logger }).status).toBe("error");
    expect(checkMainnetSafety(result.data, Networks.PUBLIC, { logger, bypassMainnetSafety: true }).status).toBe("ok");
  });

  it("requires confirmation when claiming an amount held in ledger state", async () => {
    const balanceId = "00000000" + "12".repeat(32);
    const result = await buildClaimClaimableBalance(network.horizonUrl, network, claimant, {
      balanceId, sequenceNumber: "1",
    });
    expect(validateClaimableBalanceId(balanceId).status).toBe("ok");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(result.error.message);
    expect(checkMainnetSafety(result.data, Networks.PUBLIC, { logger }).status).toBe("error");
    expect(checkMainnetSafety(result.data, Networks.PUBLIC, { logger, bypassMainnetSafety: true }).status).toBe("ok");
  });

  it("rejects invalid amounts, identities and inverted claim windows before building", async () => {
    for (const amount of ["0", "-1", "1.00000001", "NaN"]) expect(validateClaimableAmount(amount).status).toBe("error");
    expect(validateClaimantAddress(claimant).status).toBe("ok");
    expect(validateClaimantAddress("invalid").status).toBe("error");
    expect(validateClaimableBalanceId("invalid").status).toBe("error");
    expect(validateClaimPredicate({ type: "and", predicates: [
      { type: "afterRelativeTime", seconds: "200" }, { type: "beforeRelativeTime", seconds: "100" },
    ] }).status).toBe("error");
    expect((await buildCreateClaimableBalance(network.horizonUrl, network, source, {
      amount: "-1", claimant, predicate: { type: "unconditional" }, sequenceNumber: "1",
    })).status).toBe("error");
  });
});
