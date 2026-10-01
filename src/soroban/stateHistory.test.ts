import { describe, expect, it } from "vitest";
import { ContractStateHistory } from "./contractStateHistory";
import {
  getContractState,
  getContractStateAt,
  getStateChanges,
  watchContractState,
} from "./stateHistory.js";

describe("contract state history API", () => {
  it("captures current state and resolves exact captured ledgers", async () => {
    const history = new ContractStateHistory();
    const state = await getContractState("C123", async () => ({ ledger: 10, state: { count: 1 } }), history);

    expect(state.status).toBe("ok");
    expect(getContractStateAt("C123", 10, history)).toMatchObject({
      status: "ok",
      data: { ledger: 10, state: { count: 1 } },
    });
    expect(getContractStateAt("C123", 11, history).status).toBe("error");
  });

  it("computes changes between captured ledgers", async () => {
    const history = new ContractStateHistory();
    await getContractState("C123", async () => ({ ledger: 10, state: { count: 1, old: true } }), history);
    await getContractState("C123", async () => ({ ledger: 12, state: { count: 2, added: true } }), history);

    const changes = getStateChanges("C123", 10, 12, history);
    expect(changes.status).toBe("ok");
    if (changes.status === "ok") {
      expect(changes.data.changes).toEqual([
        { key: "added", kind: "added", to: true },
        { key: "count", kind: "changed", from: 1, to: 2 },
        { key: "old", kind: "removed", from: true },
      ]);
    }
  });

  it("watches state until aborted and returns read failures as results", async () => {
    const controller = new AbortController();
    const history = new ContractStateHistory();
    const watch = watchContractState(
      "C123",
      async () => ({ ledger: 20, state: { active: true } }),
      { intervalMs: 10_000, signal: controller.signal },
      history,
    );
    const first = await watch.next();
    expect(first.value?.status).toBe("ok");
    controller.abort();
    expect((await watch.next()).done).toBe(true);

    const failure = await getContractState("C123", async () => { throw new Error("offline"); }, history);
    expect(failure.status).toBe("error");
  });
});