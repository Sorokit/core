import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    threads: false,
    coverage: {
      enabled: false,
    },
  },
  css: false,
});
