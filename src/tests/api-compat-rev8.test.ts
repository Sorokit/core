/**
 * REV8 API-compatibility regression coverage.
 * Guards the pre-#808 public contracts that must survive the #808 merge.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../transaction/submitTransaction");

import { submitTransaction } from "../transaction/submitTransaction";
import { submitBatch } from "../transaction/batchSubmitter";
import {
  buildTimeLockTransaction,
  getTimeLockedTransactionStatus,
  getTimeLockStatus,
  isTimeBoundsValid,
  validateTimeBounds,
} from "../transaction/timeLocks";
import { decodeContractEvent, decodeContractEventWithAbi } from "../soroban/decodeContractEvent";
import { EventIndex, hashEvent, hashString } from "../soroban/eventIndex";

const CFG = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

describe("submitBatch planning mode", () => {
  it("never reports an on-ledger success when nothing was sent", () => {
    const result = submitBatch(["XDR_A", "XDR_B"], { atomic: true, rollbackOnFailure: true });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.mode).toBe("planning");
    expect(result.data.status).toBe("planned");
    expect(result.data.submitted).toBe(0);
    expect(result.data.succeeded).toBe(0);
    expect(result.data.failed).toBe(0);
    expect(vi.mocked(submitTransaction)).not.toHaveBeenCalled();
  });
});

describe("submitBatch submission mode", () => {
  it("calls the mocked submitTransaction per XDR and reports hashes", async () => {
    vi.mocked(submitTransaction).mockResolvedValue({
      status: "ok",
      data: { hash: "hash_1", ledger: 1 },
    } as never);
    const result = await submitBatch(["XDR_A"], CFG);
    expect(vi.mocked(submitTransaction)).toHaveBeenCalledWith(CFG.horizonUrl, CFG.networkPassphrase, "XDR_A", undefined);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.mode).toBe("submission");
    expect(result.data.transactions[0]?.hash).toBe("hash_1");
  });

  it("surfaces the Horizon error message on failure", async () => {
    vi.mocked(submitTransaction).mockResolvedValue({
      status: "error",
      error: { code: "TX_FAILED", message: "boom" },
    } as never);
    const result = await submitBatch(["XDR_A"], CFG);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.summary).toBe("all_failed");
    expect(result.data.transactions[0]?.error).toBe("boom");
  });
});

describe("timeLocks public contracts", () => {
  it("keeps the pre-#808 result contracts and the new named helpers", () => {
    expect(validateTimeBounds({ minTime: 1, maxTime: 2 }).status).toBe("ok");
    expect(validateTimeBounds({ minTime: 3, maxTime: 2 }).status).toBe("error");
    expect(getTimeLockedTransactionStatus({ minTime: 1, maxTime: 2 }).status).toBe("ok");
    expect(isTimeBoundsValid({ minTime: 0, maxTime: 0 })).toBe(true);
    expect(isTimeBoundsValid({ minTime: 3, maxTime: 2 })).toBe(false);
    expect(getTimeLockStatus({ minTime: 0, maxTime: 0 })).toBe("executable");
  });

  it("fails closed on invalid bounds before touching Horizon", async () => {
    const bad = await buildTimeLockTransaction(
      "https://horizon-testnet.stellar.org",
      CFG,
      "GSRC",
      { timeBounds: { minTime: 5, maxTime: 1 } },
    );
    expect(bad.status).toBe("error");
  });
});

describe("decodeContractEvent API split", () => {
  const pairEvent = { contractId: "CF", name: "pair_created", value: ["TOKEN_A", "TOKEN_B", "PAIR"] };

  it("legacy name returns the decoded object (or null)", () => {
    expect(decodeContractEvent(pairEvent as never)?.type).toBe("factory.pair_created");
    expect(decodeContractEvent({ name: "unknown" } as never)).toBeNull();
  });

  it("ABI API always returns a result and never the legacy shape", () => {
    const result = decodeContractEventWithAbi(pairEvent as never);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.type).toBe("unknown");
    expect(decodeContractEventWithAbi(null).status).toBe("error");
  });
});

describe("EventIndex public contracts", () => {
  it("add() reports duplicates, size is a getter, hashes are deterministic", () => {
    const index = new EventIndex(2);
    const a = { id: "1", contractId: "C", ledger: 1, topics: ["t"], value: "v" };
    expect(index.add(a as never)).toBe(false);
    expect(index.add({ ...a } as never)).toBe(true);
    expect(index.size).toBe(1);
    expect(typeof hashString("abc")).toBe("number");
    expect(hashEvent(a as never)).toBe(hashEvent({ ...a } as never));
  });

  it("treats same-metadata events with different payloads as distinct", () => {
    const index = new EventIndex();
    const p1 = { contractId: "C", ledger: 5, topics: ["x"], value: "1" };
    const p2 = { contractId: "C", ledger: 5, topics: ["x"], value: "2" };
    index.add(p1 as never);
    index.add(p2 as never);
    expect(index.size).toBe(2);
    expect(hashEvent(p1 as never)).not.toBe(hashEvent(p2 as never));
  });

  it("caps the default index at 10,000 entries and evicts oldest first", () => {
    const index = new EventIndex(2);
    const a = { id: "a", contractId: "C", ledger: 1 };
    index.add(a as never);
    index.add({ id: "b", contractId: "C", ledger: 2 } as never);
    index.add({ id: "c", contractId: "C", ledger: 3 } as never);
    expect(index.has(a as never)).toBe(false);
    expect(index.size).toBe(2);

    const big = new EventIndex();
    for (let i = 0; i < 10_050; i += 1) {
      big.add({ id: `e${i}`, contractId: "C", ledger: i } as never);
    }
    expect(big.size).toBe(10_000);
  });
});
