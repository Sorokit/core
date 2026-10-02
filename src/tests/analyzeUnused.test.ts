import { describe, it, expect } from "vitest";
import path from "path";
import { createRequire } from "module";

const req = createRequire(import.meta.url);
const {
  analyzeUnusedCode,
  extractExports,
  parseArgs,
} = req("../../scripts/analyzeUnused.js");

describe("analyzeUnused script", () => {
  it("parseArgs handles custom threshold flags", () => {
    const args = parseArgs(["--threshold", "10", "--json"]);
    expect(args.thresholdBytes).toBe(10 * 1024);
    expect(args.json).toBe(true);
  });

  it("extractExports correctly extracts function and class exports with line numbers", () => {
    const code = `
export function testFunc() { return 1; }
export class TestClass {}
export const CONSTANT_VAL = 42;
export { helper1, helper2 };
`;
    const exports = extractExports(code, "testFile.ts");
    expect(exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "testFunc", line: 2 }),
        expect.objectContaining({ name: "TestClass", line: 3 }),
        expect.objectContaining({ name: "CONSTANT_VAL", line: 4 }),
        expect.objectContaining({ name: "helper1", line: 5 }),
        expect.objectContaining({ name: "helper2", line: 5 }),
      ])
    );
  });

  it("analyzeUnusedCode runs and returns expected report structure", () => {
    const result = analyzeUnusedCode({
      srcDir: path.resolve(__dirname, "../shared"),
      thresholdBytes: 100 * 1024,
    });

    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("totalUnusedBytes");
    expect(result).toHaveProperty("unusedSymbols");
    expect(Array.isArray(result.unusedSymbols)).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("fails when threshold is set lower than detected unused code", () => {
    const result = analyzeUnusedCode({
      srcDir: path.resolve(__dirname, "../shared"),
      thresholdBytes: 1, // 1 byte threshold will fail
    });

    expect(result.passed).toBe(false);
  });
});
