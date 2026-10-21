import { describe, expect, it } from "vitest";
import {
  evaluateBalanceAlerts,
  calculateMinimumReserve,
  calculateMinimumReserveStroops,
  minReserveAlert,
  BASE_RESERVE_XLM,
  BASE_ACCOUNT_RESERVES,
} from "../account/balanceAlerts";
import type { AssetBalance, BalanceAlertRule } from "../account/types";

describe("BalanceAlertRule Minimum Reserve Tracking (#853)", () => {
  const nativeBalance = (amount: number | string): AssetBalance => ({
    assetType: "native",
    assetCode: "XLM",
    assetIssuer: null,
    balance: String(amount),
    balanceFloat: typeof amount === "number" ? amount : parseFloat(amount),
  });

  describe("calculateMinimumReserve", () => {
    it("calculates base reserve for an account with 0 subentries", () => {
      // (2 + 0) * 0.5 XLM = 1.0 XLM
      expect(calculateMinimumReserve()).toBe(1.0);
      expect(calculateMinimumReserve({ subentryCount: 0 })).toBe(1.0);
      expect(calculateMinimumReserveStroops({ subentryCount: 0 })).toBe(10_000_000n);
    });

    it("calculates minimum reserve based on subentryCount", () => {
      // (2 + 3 subentries) * 0.5 XLM = 2.5 XLM = 25,000,000 stroops
      expect(calculateMinimumReserve({ subentryCount: 3 })).toBe(2.5);
      expect(calculateMinimumReserveStroops({ subentryCount: 3 })).toBe(25_000_000n);
    });

    it("calculates reserve from breakdown of trustlines, signers, offers, dataEntries", () => {
      // 2 trustlines + 1 extra signer (2 total - 1 master) + 1 offer = 4 subentries
      // (2 + 4) * 0.5 XLM = 3.0 XLM
      const reserve = calculateMinimumReserve({
        trustlines: ["USDC", "BTC"],
        signers: ["GMASTER", "GSIGNER2"],
        offers: [101],
      });
      expect(reserve).toBe(3.0);
      expect(calculateMinimumReserveStroops({
        trustlines: ["USDC", "BTC"],
        signers: ["GMASTER", "GSIGNER2"],
        offers: [101],
      })).toBe(30_000_000n);
    });
  });

  describe("minReserveAlert helper", () => {
    it("creates a properly formatted BalanceAlertRule with condition min_reserve", () => {
      const rule = minReserveAlert({ bufferXlm: 2 });
      expect(rule.condition).toBe("min_reserve");
      expect(rule.assetCode).toBe("XLM");
      expect(rule.bufferXlm).toBe(2);
      expect(rule.threshold).toBe(2);
    });
  });

  describe("evaluateBalanceAlerts with min_reserve rule", () => {
    it("fires when balance approaches minimum reserve within buffer", () => {
      // Account with 2 subentries -> reserve = (2 + 2) * 0.5 = 2.0 XLM.
      // Rule has buffer = 1.0 XLM -> alerts when balance <= 3.0 XLM.
      const rule: BalanceAlertRule = {
        id: "low-reserve-buffer",
        assetCode: "XLM",
        condition: "min_reserve",
        threshold: 1.0,
      };

      const accountContext = { subentryCount: 2 };

      // Transition from 5 XLM -> 2.8 XLM (approaching reserve + buffer)
      const alerts = evaluateBalanceAlerts(
        [rule],
        [nativeBalance(5.0)],
        [nativeBalance(2.8)],
        accountContext,
      );

      expect(alerts).toHaveLength(1);
      expect(alerts[0].rule.id).toBe("low-reserve-buffer");
      expect(alerts[0].minimumReserve).toBe(2.0);
      expect(alerts[0].minimumReserveStroops).toBe(20_000_000n);
      expect(alerts[0].isSubReserve).toBe(false); // 2.8 > 2.0 (approaching reserve)
    });

    it("fires and marks isSubReserve=true when balance drops strictly below minimum reserve", () => {
      // Account with 4 subentries -> reserve = (2 + 4) * 0.5 = 3.0 XLM.
      const rule: BalanceAlertRule = minReserveAlert({ bufferXlm: 0 });
      const accountContext = { subentryCount: 4 };

      // Transition from 4.0 XLM -> 2.5 XLM (below 3.0 XLM reserve!)
      const alerts = evaluateBalanceAlerts(
        [rule],
        [nativeBalance(4.0)],
        [nativeBalance(2.5)],
        accountContext,
      );

      expect(alerts).toHaveLength(1);
      expect(alerts[0].minimumReserve).toBe(3.0);
      expect(alerts[0].isSubReserve).toBe(true);
      expect(alerts[0].newBalance).toBe("2.5");
      expect(alerts[0].oldBalance).toBe("4");
    });

    it("does not fire when balance stays above the reserve + buffer threshold", () => {
      const rule = minReserveAlert({ bufferXlm: 0.5 });
      const accountContext = { subentryCount: 0 }; // reserve = 1.0 XLM, threshold = 1.5 XLM

      // 10 XLM -> 5 XLM (well above 1.5 XLM)
      const alerts = evaluateBalanceAlerts(
        [rule],
        [nativeBalance(10.0)],
        [nativeBalance(5.0)],
        accountContext,
      );

      expect(alerts).toHaveLength(0);
    });

    it("does not repeatedly fire if balance remains below the threshold without crossing", () => {
      const rule = minReserveAlert();
      const accountContext = { subentryCount: 0 }; // reserve = 1.0 XLM

      // Balance already below reserve: 0.8 XLM -> 0.7 XLM
      const alerts = evaluateBalanceAlerts(
        [rule],
        [nativeBalance(0.8)],
        [nativeBalance(0.7)],
        accountContext,
      );

      expect(alerts).toHaveLength(0);
    });
  });
});
