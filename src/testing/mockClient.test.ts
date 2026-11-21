import { describe, expect, it, vi } from "vitest";
import { createMockClient, MOCK_ACCOUNT_INFO } from "./mockClient";
import { err, ok, SorokitErrorCode } from "../shared/response";

describe("createMockClient", () => {
  it("returns happy-path defaults for every namespace when no overrides are given", async () => {
    const client = createMockClient();

    await expect(client.account.get()).resolves.toEqual(ok(MOCK_ACCOUNT_INFO));
    expect(client.network.getId()).toBe("testnet");
  });

  it("allows overriding a single method on a single namespace without touching its siblings", async () => {
    const client = createMockClient({
      overrides: {
        account: {
          get: vi.fn().mockResolvedValue(err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "nope")),
        },
      },
    });

    const result = await client.account.get();
    expect(result).toEqual(err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "nope"));

    // Sibling methods on the same namespace keep their defaults.
    await expect(client.account.getBalances()).resolves.toEqual(
      ok(MOCK_ACCOUNT_INFO.balances),
    );

    // Other namespaces are entirely untouched.
    expect(client.wallet.emptyState()).toBeDefined();
  });

  it("allows overriding methods on multiple namespaces independently", async () => {
    const client = createMockClient({
      overrides: {
        account: {
          get: vi.fn().mockResolvedValue(err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "nope")),
        },
        network: {
          getId: vi.fn().mockReturnValue("mainnet"),
        },
      },
    });

    await expect(client.account.get()).resolves.toEqual(
      err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "nope"),
    );
    expect(client.network.getId()).toBe("mainnet");
    // network.getConfig was not overridden, so it keeps its default stub.
    expect(client.network.getConfig()).toBeDefined();
  });

  it("still supports whole-config overrides (walletState, networkConfig, accountInfo)", async () => {
    const customAccountInfo = { ...MOCK_ACCOUNT_INFO, publicKey: "GCUSTOM" };
    const client = createMockClient({ accountInfo: customAccountInfo });

    await expect(client.account.get()).resolves.toEqual(ok(customAccountInfo));
  });
});
