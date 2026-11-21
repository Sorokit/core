import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkBundleSizes } = require("../../scripts/check-bundle-size.js");

describe("Bundle size analysis script (#921)", () => {
  it("measures bundle sizes, checks growth against baseline, and supports growth approval", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokit-bundle-"));
    try {
      const distDir = path.join(tmpDir, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      const sampleFile = path.join(distDir, "index.mjs");
      fs.writeFileSync(sampleFile, "export const x = '" + "a".repeat(2000) + "';");

      const budgets = [
        { name: "full SDK", file: "dist/index.mjs", budgetBytes: 50 * 1024 },
      ];

      const initialReport = checkBundleSizes({
        rootDir: tmpDir,
        budgets,
        reportPath: "dist/bundle-size-report.json",
      });
      expect(initialReport.passed).toBe(true);
      expect(initialReport.entries).toHaveLength(1);
      expect(
        fs.existsSync(path.join(tmpDir, "dist/bundle-size-report.json")),
      ).toBe(true);

      // Simulate > 10% growth over a tiny baseline without approval
      const unapprovedGrowth = checkBundleSizes({
        rootDir: tmpDir,
        budgets,
        baseline: {
          totalGzipBytes: 10,
          entries: [{ file: "dist/index.mjs", gzipBytes: 10 }],
        },
        approveGrowth: false,
      });
      expect(unapprovedGrowth.passed).toBe(false);
      expect(unapprovedGrowth.errors.length).toBeGreaterThan(0);

      // Approve the growth
      const approvedGrowth = checkBundleSizes({
        rootDir: tmpDir,
        budgets,
        baseline: {
          totalGzipBytes: 10,
          entries: [{ file: "dist/index.mjs", gzipBytes: 10 }],
        },
        approveGrowth: true,
      });
      expect(approvedGrowth.passed).toBe(true);
      expect(approvedGrowth.warnings.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
