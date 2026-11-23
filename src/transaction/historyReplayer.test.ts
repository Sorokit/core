import { describe, expect, it, vi } from "vitest";
import { ok } from "../shared/response";

const tx = { hash: "abc", status: "success" as const, ledger: 10, resultXdr: "r" };
vi.mock("./status", () => ({ getTransactionStatus: vi.fn(async () => ok(tx)) }));

import { replayTransaction, verifyTransaction } from "./historyReplayer";

describe("historyReplayer", () => {
  it("replays a transaction as an immutable object", async () => {
    const r = await replayTransaction("http://h", "abc");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(Object.isFrozen(r.data)).toBe(true);
  });
  it("verifies matching fields", () => {
    expect(verifyTransaction(tx, { ledger: 10, status: "success" }).status).toBe("ok");
  });
  it("reports mismatched fields", () => {
    const r = verifyTransaction(tx, { ledger: 11 });
    expect(r.status === "error" && r.error.message).toContain("ledger");
  });
});
