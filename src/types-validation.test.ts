import { describe, expect, it } from "vitest";
import {
  validateAccountInfo,
  validateAssetBalance,
  validateResolvedNetworkConfig,
} from "./types-validation";

const VALID_BALANCE = {
  assetType: "native" as const,
  assetCode: "XLM",
  assetIssuer: null,
  balance: "100.0000000",
  balanceFloat: 100,
};

const VALID_ACCOUNT_INFO = {
  publicKey: "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR",
  displayAddress: "GAIH3...QJZNSR",
  sequence: "1234567890",
  subentryCount: 0,
  balances: [VALID_BALANCE],
};

const VALID_NETWORK_CONFIG = {
  network: "testnet" as const,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

describe("validateAssetBalance", () => {
  it("accepts a well-formed AssetBalance", () => {
    const result = validateAssetBalance(VALID_BALANCE);
    expect(result.status).toBe("ok");
  });

  it("accepts a credit_alphanum4 balance with a string issuer", () => {
    const result = validateAssetBalance({
      ...VALID_BALANCE,
      assetType: "credit_alphanum4",
      assetCode: "USDC",
      assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA",
    });
    expect(result.status).toBe("ok");
  });

  it("accepts an optional liquidityPoolId", () => {
    const result = validateAssetBalance({
      ...VALID_BALANCE,
      assetType: "liquidity_pool_shares",
      liquidityPoolId: "abc123",
    });
    expect(result.status).toBe("ok");
  });

  it.each([null, undefined, "not-an-object", 42, []])(
    "rejects a non-object value: %j",
    (value) => {
      const result = validateAssetBalance(value);
      expect(result.status).toBe("error");
    },
  );

  it("rejects an invalid assetType", () => {
    const result = validateAssetBalance({ ...VALID_BALANCE, assetType: "bogus" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("assetType");
    }
  });

  it("rejects a non-string assetCode", () => {
    const result = validateAssetBalance({ ...VALID_BALANCE, assetCode: 123 });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("assetCode");
    }
  });

  it("rejects a non-string, non-null assetIssuer", () => {
    const result = validateAssetBalance({ ...VALID_BALANCE, assetIssuer: 42 });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("assetIssuer");
    }
  });

  it("rejects a non-string balance", () => {
    const result = validateAssetBalance({ ...VALID_BALANCE, balance: 100 });
    expect(result.status).toBe("error");
  });

  it("rejects a NaN balanceFloat", () => {
    const result = validateAssetBalance({ ...VALID_BALANCE, balanceFloat: NaN });
    expect(result.status).toBe("error");
  });

  it("reports multiple issues in one pass", () => {
    const result = validateAssetBalance({
      assetType: "bogus",
      assetCode: 123,
      assetIssuer: 42,
      balance: 100,
      balanceFloat: "not-a-number",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("assetType");
      expect(result.error.message).toContain("assetCode");
      expect(result.error.message).toContain("assetIssuer");
      expect(result.error.message).toContain("balance must be a string");
      expect(result.error.message).toContain("balanceFloat");
    }
  });
});

describe("validateAccountInfo", () => {
  it("accepts a well-formed AccountInfo", () => {
    const result = validateAccountInfo(VALID_ACCOUNT_INFO);
    expect(result.status).toBe("ok");
  });

  it("accepts an account with no balances", () => {
    const result = validateAccountInfo({ ...VALID_ACCOUNT_INFO, balances: [] });
    expect(result.status).toBe("ok");
  });

  it("rejects a non-object value", () => {
    const result = validateAccountInfo(null);
    expect(result.status).toBe("error");
  });

  it("rejects an empty publicKey", () => {
    const result = validateAccountInfo({ ...VALID_ACCOUNT_INFO, publicKey: "" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("publicKey");
    }
  });

  it("rejects a non-array balances field", () => {
    const result = validateAccountInfo({ ...VALID_ACCOUNT_INFO, balances: "nope" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("balances must be an array");
    }
  });

  it("surfaces a nested balance validation failure with its index", () => {
    const result = validateAccountInfo({
      ...VALID_ACCOUNT_INFO,
      balances: [VALID_BALANCE, { ...VALID_BALANCE, assetType: "bogus" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("balances[1]");
    }
  });

  it("rejects a non-finite subentryCount", () => {
    const result = validateAccountInfo({ ...VALID_ACCOUNT_INFO, subentryCount: NaN });
    expect(result.status).toBe("error");
  });
});

describe("validateResolvedNetworkConfig", () => {
  it("accepts a well-formed config", () => {
    const result = validateResolvedNetworkConfig(VALID_NETWORK_CONFIG);
    expect(result.status).toBe("ok");
  });

  it("accepts an optional baseFeeMultiplier", () => {
    const result = validateResolvedNetworkConfig({
      ...VALID_NETWORK_CONFIG,
      baseFeeMultiplier: 1.5,
    });
    expect(result.status).toBe("ok");
  });

  it("rejects an unknown network name", () => {
    const result = validateResolvedNetworkConfig({ ...VALID_NETWORK_CONFIG, network: "devnet" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("network");
    }
  });

  it("rejects a malformed horizonUrl", () => {
    const result = validateResolvedNetworkConfig({
      ...VALID_NETWORK_CONFIG,
      horizonUrl: "not-a-url",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("horizonUrl");
    }
  });

  it("rejects a malformed rpcUrl", () => {
    const result = validateResolvedNetworkConfig({
      ...VALID_NETWORK_CONFIG,
      rpcUrl: "not-a-url",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("rpcUrl");
    }
  });

  it("rejects an empty networkPassphrase", () => {
    const result = validateResolvedNetworkConfig({
      ...VALID_NETWORK_CONFIG,
      networkPassphrase: "",
    });
    expect(result.status).toBe("error");
  });

  it("rejects a non-numeric baseFeeMultiplier", () => {
    const result = validateResolvedNetworkConfig({
      ...VALID_NETWORK_CONFIG,
      baseFeeMultiplier: "fast",
    });
    expect(result.status).toBe("error");
  });
});
