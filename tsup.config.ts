import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/testing/index.ts",
    "src/wallet/index.ts",
    "src/account/index.ts",
    "src/transaction/index.ts",
    "src/soroban/index.ts",
    "src/network/index.ts",
    "src/shared/index.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: true,
  external: ["vitest", "@stellar/stellar-sdk", "@walletconnect/sign-client"],
});
