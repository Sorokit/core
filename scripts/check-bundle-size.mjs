import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const budgets = [
  { name: "full SDK", file: "dist/index.mjs", budget: 150 * 1024 },
  { name: "wallet", file: "dist/wallet/index.mjs", budget: 50 * 1024 },
  { name: "account", file: "dist/account/index.mjs", budget: 40 * 1024 },
  // #682: the lazy loader entry only holds the registry + import() stubs.
  { name: "lazy loader", file: "dist/lazy/index.mjs", budget: 5 * 1024 },
];
let failed = false;
for (const item of budgets) {
  if (!existsSync(item.file)) {
    console.error(`Bundle size check: missing ${item.file}`);
    failed = true;
    continue;
  }
  const gzipBytes = gzipSync(readFileSync(item.file), { level: 9 }).length;
  const status = gzipBytes <= item.budget ? "PASS" : "FAIL";
  console.log(`${status} ${item.name}: ${(gzipBytes / 1024).toFixed(1)} KiB gzip (budget ${(item.budget / 1024).toFixed(0)} KiB)`);
  if (gzipBytes > item.budget) failed = true;
}

// Ensure standalone entry points do not accidentally import the full root barrel.
for (const file of ["dist/wallet/index.mjs", "dist/account/index.mjs", "dist/lazy/index.mjs"]) {
  if (existsSync(file) && readFileSync(file, "utf8").includes("dist/index")) {
    console.error(`FAIL tree-shaking: ${file} references the full SDK bundle`);
    failed = true;
  }
}
if (failed) process.exit(1);
