import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAndFundAccount } from "./fundingHelper";
import { getAccount } from "./getAccount";
import { ok } from "../shared/response";

vi.mock("./getAccount", () => ({ getAccount: vi.fn() }));
const key = Keypair.random().publicKey();
const info = (balance: string) =>
  ok({ publicKey: key, displayAddress: key, sequence: "1", subentryCount: 0,
    balances: [{ assetType: "native" as const, assetCode: "XLM", assetIssuer: null, balance }] });

describe("createAndFundAccount", () => {
  beforeEach(() => vi.mocked(getAccount).mockReset());

  it.each(["0", "100", "10000"])("funds via friendbot with minimum %s", async (amount) => {
    vi.mocked(getAccount).mockResolvedValue(info("10000.0000000"));
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await createAndFundAccount("https://h", key, amount, { fetchFn });
    expect(r.status).toBe("ok");
    expect(fetchFn.mock.calls[0][0]).toBe(`https://friendbot.stellar.org?addr=${key}`);
  });

  it("errors when funded balance is below the request", async () => {
    vi.mocked(getAccount).mockResolvedValue(info("10"));
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect((await createAndFundAccount("https://h", key, "50", { fetchFn })).status).toBe("error");
  });

  it("requires a custom endpoint off testnet/futurenet and validates input", async () => {
    expect((await createAndFundAccount("https://h", key, "0", { network: "mainnet" })).status).toBe("error");
    expect((await createAndFundAccount("https://h", "bad")).status).toBe("error");
    expect((await createAndFundAccount("https://h", key, "-1")).status).toBe("error");
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    expect((await createAndFundAccount("https://h", key, "0", { fetchFn })).status).toBe("error");
  });
});
