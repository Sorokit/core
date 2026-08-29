/**
 * Tests for account activity reporting and compliance analysis.
 */

import { describe, it, expect } from "vitest";
import {
  generateComplianceReport,
  exportComplianceReport,
  type ComplianceReport,
  type NormalizedActivity,
} from "./complianceReporting";

describe("complianceReporting", () => {
  const mockAccount = "GACCOUNT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const mockActivities: NormalizedActivity[] = [
    {
      transactionId: "tx001",
      timestamp: Date.now() - 24 * 60 * 60 * 1000,
      category: "transfer",
      from: mockAccount,
      to: "GACCOUNT2...",
      amount: "1000000000",
      asset: "native",
      status: "success",
      dataComplete: true,
    },
    {
      transactionId: "tx002",
      timestamp: Date.now() - 12 * 60 * 60 * 1000,
      category: "swap",
      from: mockAccount,
      to: "CROUTER...",
      amount: "500000000",
      asset: "USDC",
      status: "success",
      dataComplete: true,
    },
  ];

  describe("generateComplianceReport", () => {
    it("should generate report for valid account with aml framework", async () => {
      const result = await generateComplianceReport(mockAccount, "aml", mockActivities);

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.account).toBe(mockAccount);
      expect(report.framework).toBe("aml");
      expect(report.transactionCount).toBeGreaterThan(0);
    });

    it("should generate report for kyc framework", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "kyc",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.framework).toBe("kyc");
    });

    it("should generate report for basic framework", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.framework).toBe("basic");
    });

    it("should generate report for sox framework", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "sox",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.framework).toBe("sox");
    });

    it("should reject invalid account format", async () => {
      const result = await generateComplianceReport(
        "invalid-account",
        "aml",
        mockActivities,
      );

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_ADDRESS");
    });

    it("should handle empty account ID", async () => {
      const result = await generateComplianceReport("", "aml", mockActivities);

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_ADDRESS");
    });

    it("should validate date range", async () => {
      const now = Date.now();
      const result = await generateComplianceReport(
        mockAccount,
        "aml",
        mockActivities,
        {
          periodStartMs: now,
          periodEndMs: now - 1000, // End before start
        },
      );

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_CONFIG");
    });

    it("should include report metadata", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "aml",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.reportId).toBeDefined();
      expect(report.generatedAt).toBeGreaterThan(0);
      expect(report.periodStartMs).toBeGreaterThan(0);
      expect(report.periodEndMs).toBeGreaterThan(report.periodStartMs);
    });

    it("should categorize transactions", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.transactionsByCategory.size).toBeGreaterThan(0);
      expect(report.transactionsByCategory.has("transfer")).toBe(true);
    });

    it("should include compliance summary", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "aml",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.summary).toBeDefined();
      expect(report.summary.complianceScore).toBeGreaterThanOrEqual(0);
      expect(report.summary.complianceScore).toBeLessThanOrEqual(100);
      expect(["compliant", "review-required", "non-compliant"]).toContain(
        report.summary.assessment,
      );
    });

    it("should identify flagged activities", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "aml",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(Array.isArray(report.flaggedActivities)).toBe(true);
      report.flaggedActivities.forEach((flagged) => {
        expect(["low", "medium", "high"]).toContain(flagged.severity);
        expect(["flag", "report", "investigate"]).toContain(
          flagged.recommendedAction.toLowerCase(),
        );
      });
    });

    it("should include key findings in summary", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        mockActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(Array.isArray(report.summary.keyFindings)).toBe(true);
      expect(report.summary.keyFindings.length).toBeGreaterThan(0);
    });

    it("should respect custom date range", async () => {
      const now = Date.now();
      const start = now - 7 * 24 * 60 * 60 * 1000; // 7 days ago
      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        mockActivities,
        {
          periodStartMs: start,
          periodEndMs: now,
        },
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.periodStartMs).toBe(start);
      expect(report.periodEndMs).toBe(now);
    });
  });

  describe("exportComplianceReport", () => {
    let report: ComplianceReport;

    beforeEach(async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "aml",
        mockActivities,
      );
      if (result.status === "ok") {
        report = result.data;
      }
    });

    it("should export report as JSON", () => {
      const result = exportComplianceReport(report, "json");

      expect(result.status).toBe("ok");
      expect(typeof result.data).toBe("string");
      const parsed = JSON.parse(result.data);
      expect(parsed.account).toBe(mockAccount);
      expect(parsed.framework).toBe("aml");
    });

    it("should export report as CSV", () => {
      const result = exportComplianceReport(report, "csv");

      expect(result.status).toBe("ok");
      expect(typeof result.data).toBe("string");
      expect(result.data?.includes("TransactionId")).toBe(true);
      expect(result.data?.includes("Category")).toBe(true);
    });

    it("should reject unsupported export format", () => {
      const result = exportComplianceReport(
        report,
        "pdf" as "json" | "csv",
      );

      expect(result.status).toBe("error");
      expect(result.error.code).toBe("INVALID_CONFIG");
    });

    it("should include all activities in CSV export", () => {
      const result = exportComplianceReport(report, "csv");

      expect(result.status).toBe("ok");
      const lines = result.data?.split("\n") || [];
      expect(lines.length).toBeGreaterThan(1); // Header + data rows
    });

    it("should preserve JSON structure in export", () => {
      const result = exportComplianceReport(report, "json");

      expect(result.status).toBe("ok");
      const exported = JSON.parse(result.data);
      expect(exported.reportId).toBe(report.reportId);
      expect(exported.transactionCount).toBe(report.transactionCount);
      expect(exported.activities).toBeDefined();
    });
  });

  describe("data categorization", () => {
    it("should categorize transfers", async () => {
      const activities: NormalizedActivity[] = [
        {
          transactionId: "tx-transfer",
          timestamp: Date.now(),
          category: "transfer",
          from: mockAccount,
          to: "GOTHER...",
          amount: "1000000",
          status: "success",
          dataComplete: true,
        },
      ];

      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        activities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.transactionsByCategory.get("transfer")).toBeGreaterThan(0);
    });

    it("should categorize swaps", async () => {
      const activities: NormalizedActivity[] = [
        {
          transactionId: "tx-swap",
          timestamp: Date.now(),
          category: "swap",
          from: mockAccount,
          to: "CROUTER...",
          amount: "500000",
          status: "success",
          dataComplete: true,
        },
      ];

      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        activities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.transactionsByCategory.get("swap")).toBeGreaterThan(0);
    });

    it("should handle incomplete data", async () => {
      const activities: NormalizedActivity[] = [
        {
          transactionId: "tx-incomplete",
          timestamp: Date.now(),
          category: "contract-interaction",
          from: mockAccount,
          to: "CCONTRACT...",
          status: "pending",
          dataComplete: false,
          completenessNotes: "Awaiting confirmation",
        },
      ];

      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        activities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      const incompleteActivities = report.activities.filter(
        (a) => !a.dataComplete,
      );
      expect(incompleteActivities.length).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle empty activity list", async () => {
      const result = await generateComplianceReport(mockAccount, "basic", []);

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.transactionCount).toBe(0);
    });

    it("should generate report with null activities", async () => {
      const result = await generateComplianceReport(
        mockAccount,
        "aml",
        null as unknown as NormalizedActivity[],
      );

      expect(result.status).toBe("ok");
    });

    it("should handle large volume calculations", async () => {
      const largeActivities: NormalizedActivity[] = [
        {
          transactionId: "tx-large",
          timestamp: Date.now(),
          category: "transfer",
          from: mockAccount,
          to: "GOTHER...",
          amount: "9999999999999999999",
          status: "success",
          dataComplete: true,
        },
      ];

      const result = await generateComplianceReport(
        mockAccount,
        "basic",
        largeActivities,
      );

      expect(result.status).toBe("ok");
      const report = result.data as ComplianceReport;
      expect(report.summary.totalVolume).toBeDefined();
    });
  });
});
