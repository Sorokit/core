import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core.ts",
    "src/testing/index.ts",
    "src/wallet/index.ts",
    "src/account/index.ts",
    "src/transaction/index.ts",
    "src/soroban/index.ts",
    "src/network/index.ts",
    "src/shared/index.ts",
    "src/integration/index.ts",
    "src/lazy/index.ts",
    "src/shared/keyManagement.ts",
  ],
  format: ["cjs", "esm"],
  // tsc emits declaration files separately; tsup's multi-entry declaration
  // bundler exceeds the build environment's process limit on this workspace.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  minify: true,
  external: ["@stellar/stellar-sdk", "@walletconnect/sign-client"],
});
