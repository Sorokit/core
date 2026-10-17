import { describe, expect, it } from "vitest";
import { deriveFromMnemonic, isStandardStellarDerivationPath } from "./keyManagement";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Stellar derivation path validation", () => {
  it("recognizes legacy and full Stellar BIP-44 paths", () => {
    expect(isStandardStellarDerivationPath("m/44'/148'/0'")).toBe(true);
    expect(isStandardStellarDerivationPath("m/44'/148'/0'/0'/0'")).toBe(true);
    expect(isStandardStellarDerivationPath("m/44'/0'/0'")).toBe(false);
  });

  it("rejects non-standard paths by default and allows explicit overrides", async () => {
    const rejected = await deriveFromMnemonic(mnemonic, "m/44'/0'/0'");
    expect(rejected.status).toBe("error");
    if (rejected.status === "error") {
      expect(rejected.error.message).toContain("Stellar BIP-44");
    }

    const allowed = await deriveFromMnemonic(mnemonic, "m/44'/0'/0'", {
      allowNonStandardPath: true,
    });
    expect(allowed.status).toBe("ok");
  });
});
