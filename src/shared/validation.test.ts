import { describe, it, expect } from "vitest";
import {
  validateNetworkPassphrase,
  STELLAR_MAINNET_PASSPHRASE,
  STELLAR_TESTNET_PASSPHRASE,
} from "./validation";
import { SorokitErrorCode } from "./response";

describe("validateNetworkPassphrase", () => {
  it("accepts the mainnet passphrase", () => {
    const result = validateNetworkPassphrase(STELLAR_MAINNET_PASSPHRASE);
    expect(result.status).toBe("ok");
    expect(result.data).toBeUndefined();
  });

  it("accepts the testnet passphrase", () => {
    const result = validateNetworkPassphrase(STELLAR_TESTNET_PASSPHRASE);
    expect(result.status).toBe("ok");
    expect(result.data).toBeUndefined();
  });

  it("rejects an empty string with INVALID_NETWORK", () => {
    const result = validateNetworkPassphrase("");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("rejects a garbage string with INVALID_NETWORK", () => {
    const result = validateNetworkPassphrase("not a passphrase");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });

  it("rejects a close-but-wrong passphrase with INVALID_NETWORK", () => {
    const result = validateNetworkPassphrase(
      "Public Global Stellar Network ; September 2016",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_NETWORK);
  });
});
