import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  AccountMergeBuilder,
  BumpSequenceBuilder,
  ClawbackBuilder,
} from "./builders";
import {
  clearBuildSequenceCache,
  updateSequenceCache,
} from "./buildHelpers";
import * as fromPackageRoot from "../index";
import * as fromTransactionIndex from "./index";

const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const holder = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
};

// Supplying a sequence keeps every build offline: no Horizon call is made.
const options = { sequenceNumber: "100" };

afterEach(() => {
  clearBuildSequenceCache();
});

describe("AccountMergeBuilder (#911)", () => {
  it("sets the merge destination on the built transaction", async () => {
    const result = await new AccountMergeBuilder(source, networkConfig, options)
      .destination(destination)
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data.operations).toHaveLength(1);
    const operation = result.data.operations[0];
    expect(operation.type).toBe("accountMerge");
    if (operation.type === "accountMerge") {
      expect(operation.destination).toBe(destination);
    }
  });

  it("rejects a self merge", async () => {
    const result = await new AccountMergeBuilder(source, networkConfig, options)
      .destination(source)
      .build();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/itself/);
    }
  });

  it.each(["G_NOT_A_KEY", "", "M123", "G123"])(
    "rejects the malformed destination %j",
    async (badDestination) => {
      const result = await new AccountMergeBuilder(
        source,
        networkConfig,
        options,
      )
        .destination(badDestination)
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toMatch(/valid Stellar G-address/);
      }
    },
  );

  it("rejects an omitted destination", async () => {
    const result = await new AccountMergeBuilder(
      source,
      networkConfig,
      options,
    ).build();

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.message).toMatch(
      /valid Stellar G-address/,
    );
  });
});

describe("BumpSequenceBuilder (#910)", () => {
  it("bumps to a sequence greater than the supplied current sequence", async () => {
    const result = await new BumpSequenceBuilder(
      source,
      networkConfig,
      options,
    )
      .bumpTo(101n)
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const operation = result.data.operations[0];
    expect(operation.type).toBe("bumpSequence");
    if (operation.type === "bumpSequence") {
      expect(operation.bumpTo).toBe("101");
    }
  });

  it("accepts string, bigint and safe-integer sequence inputs", async () => {
    for (const value of ["101", 101n, 101]) {
      const result = await new BumpSequenceBuilder(
        source,
        networkConfig,
        options,
      )
        .bumpTo(value)
        .build();
      expect(result.status).toBe("ok");
    }
  });

  it("builds without a current-sequence comparison using the shared cache", async () => {
    // With autoFetchSequence and no explicit sequenceNumber, the source is
    // resolved from the shared cache, so no Horizon call occurs and there is
    // no current sequence to compare against.
    updateSequenceCache(source, "100");
    const result = await new BumpSequenceBuilder(source, networkConfig, {
      autoFetchSequence: true,
    })
      .bumpTo("1")
      .build();

    expect(result.status).toBe("ok");
  });

  it.each([
    ["non-numeric", "abc"],
    ["negative", "-1"],
    ["decimal", "10.5"],
    ["empty", "   "],
    ["uint64 overflow", "18446744073709551616"],
  ])("rejects a %s bump target", async (_label, value) => {
    const result = await new BumpSequenceBuilder(source, networkConfig, options)
      .bumpTo(value)
      .build();

    expect(result.status).toBe("error");
  });

  it("rejects an unsafe integer input", async () => {
    const result = await new BumpSequenceBuilder(source, networkConfig, options)
      .bumpTo(Number.MAX_SAFE_INTEGER + 1)
      .build();

    expect(result.status).toBe("error");
  });

  it.each(["100", "99", "0"])(
    "rejects a bump target of %s when current is 100",
    async (bumpTo) => {
      const result = await new BumpSequenceBuilder(
        source,
        networkConfig,
        options,
      )
        .bumpTo(bumpTo)
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toMatch(/greater than the current sequence/);
      }
    },
  );

  it("rejects an omitted bump target", async () => {
    const result = await new BumpSequenceBuilder(
      source,
      networkConfig,
      options,
    ).build();

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.message).toMatch(
      /bump-to sequence is required/,
    );
  });
});

describe("ClawbackBuilder (#909)", () => {
  it("sets the issued asset, holder and amount from a plain asset input", async () => {
    const result = await new ClawbackBuilder(issuer, networkConfig, options)
      .asset({ assetCode: "USDC", assetIssuer: issuer })
      .from(holder)
      .amount("25.5")
      .build();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const operation = result.data.operations[0];
    expect(operation.type).toBe("clawback");
    if (operation.type === "clawback") {
      expect(operation.asset.getCode()).toBe("USDC");
      expect(operation.asset.getIssuer()).toBe(issuer);
      expect(operation.from).toBe(holder);
      // The SDK normalises amounts to the Stellar 7-decimal representation.
      expect(operation.amount).toBe("25.5000000");
    }
  });

  it("accepts an Asset instance", async () => {
    const result = await new ClawbackBuilder(issuer, networkConfig, options)
      .asset(new Asset("EURC", issuer))
      .from(holder)
      .amount("1")
      .build();

    expect(result.status).toBe("ok");
  });

  it("rejects the native XLM asset", async () => {
    const result = await new ClawbackBuilder(issuer, networkConfig, options)
      .asset(Asset.native())
      .from(holder)
      .amount("1")
      .build();

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.message).toMatch(/native XLM/);
  });

  it.each(["0", "-5", "abc", "1.12345678", ""])(
    "rejects the invalid amount %j",
    async (amount) => {
      const result = await new ClawbackBuilder(issuer, networkConfig, options)
        .asset({ assetCode: "USDC", assetIssuer: issuer })
        .from(holder)
        .amount(amount)
        .build();

      expect(result.status).toBe("error");
    },
  );

  it("rejects an invalid asset issuer", async () => {
    const result = await new ClawbackBuilder(issuer, networkConfig, options)
      .asset({ assetCode: "USDC", assetIssuer: "G_INVALID" })
      .from(holder)
      .amount("1")
      .build();

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.message).toMatch(
      /asset issuer must be a valid/,
    );
  });

  it("rejects an invalid holder address", async () => {
    const result = await new ClawbackBuilder(issuer, networkConfig, options)
      .asset({ assetCode: "USDC", assetIssuer: issuer })
      .from("not-an-address")
      .amount("1")
      .build();

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.message).toMatch(
      /holder must be a valid/,
    );
  });
});

describe("builder exports", () => {
  it.each(["AccountMergeBuilder", "BumpSequenceBuilder", "ClawbackBuilder"])(
    "exports %s from the transaction barrel and the package root",
    (name) => {
      expect(fromTransactionIndex).toHaveProperty(name);
      expect(fromPackageRoot).toHaveProperty(name);
    },
  );
});
