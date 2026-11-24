import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    threads: false,
    // Crypto/property suites can exceed Vitest's 5s default on shared CI runners.
    testTimeout: 15_000,
    // packages/* are self-contained sub-projects with their own test
    // runners (see packages/cli's `npm test`, which uses node:test) — they
    // are not part of this package's vitest suite or coverage gate.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**", "packages/**"],
    coverage: {
      // #570: Coverage enforcement — thresholds prevent silent regression.
      // #1012: Raised to 90% lines / 85% branches to reduce bugs.
      enabled: true,
      provider: "v8",
      // Measure coverage only over production source files.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/tests/**",
        "src/testing/**",
      ],
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 85,
        statements: 90,
      },
      reporter: ["text", "lcov", "json-summary"],
    },
  },
});