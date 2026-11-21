#!/usr/bin/env node
/**
 * Bundle Size Analysis & Threshold Enforcement (#921)
 *
 * Measures raw and gzipped bundle sizes for production builds, compares them
 * against per-bundle budgets and baseline metrics, generates a structured
 * report, and fails CI if the bundle exceeds the threshold or grows by > 10%
 * without explicit approval (APPROVE_BUNDLE_GROWTH=true or --approve-growth).
 */

const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const DEFAULT_MAX_TOTAL_GZIP_BYTES = 500 * 1024; // 500 KiB
const DEFAULT_MAX_GROWTH_PERCENT = 10; // 10%

const DEFAULT_BUDGETS = [
  { name: "full SDK", file: "dist/index.mjs", budgetBytes: 150 * 1024 },
  { name: "wallet", file: "dist/wallet/index.mjs", budgetBytes: 50 * 1024 },
  { name: "account", file: "dist/account/index.mjs", budgetBytes: 40 * 1024 },
  { name: "lazy loader", file: "dist/lazy/index.mjs", budgetBytes: 5 * 1024 },
];

function checkBundleSizes(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const budgets = options.budgets || DEFAULT_BUDGETS;
  const maxTotalGzipBytes =
    options.maxTotalGzipBytes ?? DEFAULT_MAX_TOTAL_GZIP_BYTES;
  const maxGrowthPercent =
    options.maxGrowthPercent ?? DEFAULT_MAX_GROWTH_PERCENT;
  const approveGrowth =
    options.approveGrowth ??
    (process.env.APPROVE_BUNDLE_GROWTH === "true" ||
      process.argv.includes("--approve-growth"));
  const baseline = options.baseline || null;

  const entries = [];
  const errors = [];
  const warnings = [];
  let totalRawBytes = 0;
  let totalGzipBytes = 0;

  for (const item of budgets) {
    const fullPath = path.resolve(rootDir, item.file);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing bundle output: ${item.file}`);
      continue;
    }

    const content = fs.readFileSync(fullPath);
    const rawBytes = content.length;
    const gzipBytes = gzipSync(content, { level: 9 }).length;

    totalRawBytes += rawBytes;
    totalGzipBytes += gzipBytes;

    const baselineEntry = baseline?.entries?.find((e) => e.file === item.file);
    let growthPercent = null;
    if (baselineEntry && baselineEntry.gzipBytes > 0) {
      growthPercent =
        ((gzipBytes - baselineEntry.gzipBytes) / baselineEntry.gzipBytes) * 100;
    }

    const overBudget = gzipBytes > item.budgetBytes;
    const overGrowth =
      growthPercent !== null && growthPercent > maxGrowthPercent;

    if (overBudget) {
      errors.push(
        `${item.name} (${item.file}) exceeds budget: ${(gzipBytes / 1024).toFixed(1)} KiB > ${(item.budgetBytes / 1024).toFixed(1)} KiB`,
      );
    }

    if (overGrowth) {
      const msg = `${item.name} (${item.file}) grew by ${growthPercent.toFixed(1)}% (threshold: ${maxGrowthPercent}%)`;
      if (approveGrowth) {
        warnings.push(`${msg} [growth approved]`);
      } else {
        errors.push(msg);
      }
    }

    entries.push({
      name: item.name,
      file: item.file,
      rawBytes,
      gzipBytes,
      budgetBytes: item.budgetBytes,
      growthPercent,
      status: overBudget || (overGrowth && !approveGrowth) ? "FAIL" : "PASS",
    });
  }

  if (totalGzipBytes > maxTotalGzipBytes) {
    errors.push(
      `Total gzipped bundle size ${(totalGzipBytes / 1024).toFixed(1)} KiB exceeds maximum threshold ${(maxTotalGzipBytes / 1024).toFixed(1)} KiB`,
    );
  }

  if (baseline?.totalGzipBytes > 0) {
    const totalGrowth =
      ((totalGzipBytes - baseline.totalGzipBytes) / baseline.totalGzipBytes) *
      100;
    if (totalGrowth > maxGrowthPercent) {
      const msg = `Total gzipped bundle size grew by ${totalGrowth.toFixed(1)}% (threshold: ${maxGrowthPercent}%)`;
      if (approveGrowth) {
        warnings.push(`${msg} [growth approved]`);
      } else {
        errors.push(msg);
      }
    }
  }

  const report = {
    passed: errors.length === 0,
    approveGrowth,
    totalRawBytes,
    totalGzipBytes,
    maxTotalGzipBytes,
    maxGrowthPercent,
    entries,
    warnings,
    errors,
    generatedAt: new Date().toISOString(),
  };

  if (options.reportPath) {
    const outPath = path.resolve(rootDir, options.reportPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  }

  return report;
}

if (require.main === module) {
  const baselinePath = path.resolve(
    process.cwd(),
    ".bundle-size-baseline.json",
  );
  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : null;

  const report = checkBundleSizes({
    baseline,
    reportPath: "dist/bundle-size-report.json",
  });

  for (const entry of report.entries) {
    console.log(
      `${entry.status} ${entry.name}: ${(entry.gzipBytes / 1024).toFixed(1)} KiB gzip (budget ${(entry.budgetBytes / 1024).toFixed(0)} KiB)`,
    );
  }
  for (const warning of report.warnings) {
    console.warn(`WARN: ${warning}`);
  }
  for (const error of report.errors) {
    console.error(`FAIL: ${error}`);
  }

  if (!report.passed) {
    process.exit(1);
  }
}

module.exports = {
  checkBundleSizes,
  DEFAULT_BUDGETS,
  DEFAULT_MAX_TOTAL_GZIP_BYTES,
  DEFAULT_MAX_GROWTH_PERCENT,
};
