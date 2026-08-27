import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createI18n, translateMessage } from "../shared/i18n";
import { createSorokitClient } from "../client/createSorokitClient";
import { generateDeviceFingerprint, evaluateDeviceTrust } from "../wallet/deviceTrust";
import { calculateAdaptiveFee } from "../transaction/estimateFee";
import { validateEscrow, validateEscrowAction, isEscrowExpired } from "../transaction/escrow";

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();

function escrowParams() {
  const now = Math.floor(Date.now() / 1000);
  return { buyer, seller, amount: "10", releaseAfter: now + 3600, refundAfter: now + 7200 };
}

describe("issues #464, #470, #474, and #475", () => {
  it("selects Spanish and falls back to English/custom messages without changing keys", () => {
    const i18n = createI18n({ locale: "es", translations: { es: { "custom.message": "Personalizado" } } });
    expect(i18n.t("wallet.connect.failed")).toBe("No se puede conectar con la billetera.");
    expect(i18n.t("transaction.invalid")).not.toBe(createI18n().t("transaction.invalid"));
    expect(i18n.t("missing.key")).toBe("missing.key");
    expect(i18n.t("custom.message")).toBe("Personalizado");
    expect(translateMessage("transaction.invalid", "fr")).toBe(createI18n().t("transaction.invalid"));
    const client = createSorokitClient({ network: "testnet", locale: "es" });
    expect(client.status).toBe("ok");
    if (client.status === "ok") expect(client.data.i18n.locale).toBe("es");
  });

  it("fingerprints supported signals without exposing raw values and scores device history", () => {
    const first = generateDeviceFingerprint({ userAgent: "browser-a", platform: "linux", language: "en" });
    const recognized = evaluateDeviceTrust(first, [{ fingerprint: first.id }]);
    const changed = evaluateDeviceTrust(generateDeviceFingerprint({ userAgent: "browser-b", platform: "linux", language: "en" }), [{ fingerprint: first.id }]);
    expect(first.id).not.toContain("browser-a");
    expect(first.available).toBe(true);
    expect(recognized.score).toBe(100);
    expect(changed.securityFlag).toBe(true);
    expect(changed.score).toBeLessThan(recognized.score);
    expect(evaluateDeviceTrust(generateDeviceFingerprint({}), []).reason).toBe("unavailable");
  });

  it("bounds adaptive fees and responds to urgency and fee trends", () => {
    const stable = calculateAdaptiveFee(100, { urgency: "normal", feeHistory: [100, 101, 99] });
    const increasing = calculateAdaptiveFee(100, { urgency: "high", feeHistory: [100, 200], minMultiplier: 0.5, maxMultiplier: 2 });
    const decreasing = calculateAdaptiveFee(100, { urgency: "low", feeHistory: [200, 100], minMultiplier: 0.5, maxMultiplier: 2 });
    expect(stable).toBeGreaterThanOrEqual(100);
    expect(increasing).toBeLessThanOrEqual(200);
    expect(decreasing).toBeGreaterThanOrEqual(100);
    expect(calculateAdaptiveFee(100, { urgency: "urgent", feeHistory: [1, 1000000], maxMultiplier: 3 })).toBe(300);
    expect(calculateAdaptiveFee(100)).toBe(100);
  });

  it("validates escrow participants, timelocks, and explicit state transitions", () => {
    const params = escrowParams();
    expect(validateEscrow(params).status).toBe("ok");
    expect(validateEscrow({ ...params, releaseAfter: Math.floor(Date.now() / 1000) - 1 }).status).toBe("error");
    expect(validateEscrowAction("released", "refund").status).toBe("error");
    expect(validateEscrowAction("pending", "release", Math.floor(Date.now() / 1000), params.releaseAfter).status).toBe("error");
    expect(isEscrowExpired(params, params.refundAfter!)).toBe(true);
  });
});
