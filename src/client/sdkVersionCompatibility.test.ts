import { describe, expect, it, vi } from "vitest";
import {
  checkStellarSdkVersionCompatibility,
  compareStellarSdkVersion,
  parseSemverCore,
  SUPPORTED_STELLAR_SDK_VERSION,
} from "./sdkVersionCompatibility";
import type { SorokitLogger } from "../shared/logger";

describe("parseSemverCore (#865)", () => {
  it("parses a plain major.minor.patch string", () => {
    expect(parseSemverCore("13.3.0")).toEqual({ major: 13, minor: 3, patch: 0 });
  });

  it("ignores a prerelease/build suffix", () => {
    expect(parseSemverCore("13.3.0-beta.1")).toEqual({ major: 13, minor: 3, patch: 0 });
    expect(parseSemverCore("13.3.0+build.5")).toEqual({ major: 13, minor: 3, patch: 0 });
  });

  it("returns null for an unparseable string", () => {
    expect(parseSemverCore("not-a-version")).toBeNull();
    expect(parseSemverCore("")).toBeNull();
    expect(parseSemverCore("v13.3.0")).toBeNull();
  });
});

describe("compareStellarSdkVersion (#865)", () => {
  it("reports compatible for an exact match against the default supported version", () => {
    expect(compareStellarSdkVersion(SUPPORTED_STELLAR_SDK_VERSION)).toEqual({ status: "compatible" });
  });

  it("reports compatible for a matching patch within the same minor", () => {
    expect(compareStellarSdkVersion("13.3.0", "13.3.0")).toEqual({ status: "compatible" });
  });

  it("reports unknown when no installed version is supplied", () => {
    const result = compareStellarSdkVersion(undefined);
    expect(result.status).toBe("unknown");
  });

  it("reports unknown for an unparseable installed version", () => {
    const result = compareStellarSdkVersion("not-a-version");
    expect(result.status).toBe("unknown");
  });

  it("reports incompatible with kind major-mismatch across a major version boundary", () => {
    const result = compareStellarSdkVersion("14.0.0", "13.3.0");
    expect(result).toMatchObject({
      status: "incompatible",
      kind: "major-mismatch",
      installedVersion: "14.0.0",
      supportedVersion: "13.3.0",
    });
  });

  it("reports incompatible with kind major-mismatch for an older major version too", () => {
    const result = compareStellarSdkVersion("12.9.9", "13.3.0");
    expect(result).toMatchObject({ status: "incompatible", kind: "major-mismatch" });
  });

  it("reports incompatible with kind older-than-supported for an older patch in the same major", () => {
    const result = compareStellarSdkVersion("13.3.0", "13.4.0");
    expect(result).toMatchObject({ status: "incompatible", kind: "older-than-supported" });

    const olderMinor = compareStellarSdkVersion("13.2.9", "13.3.0");
    expect(olderMinor).toMatchObject({ status: "incompatible", kind: "older-than-supported" });
  });

  it("reports incompatible with kind newer-minor for a newer minor/patch in the same major", () => {
    const result = compareStellarSdkVersion("13.4.0", "13.3.0");
    expect(result).toMatchObject({ status: "incompatible", kind: "newer-minor" });

    const newerPatch = compareStellarSdkVersion("13.3.1", "13.3.0");
    expect(newerPatch).toMatchObject({ status: "incompatible", kind: "newer-minor" });
  });
});

describe("checkStellarSdkVersionCompatibility (#865)", () => {
  function makeLogger(): SorokitLogger & { warn: ReturnType<typeof vi.fn> } {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("does not log anything for a compatible version", () => {
    const logger = makeLogger();
    const result = checkStellarSdkVersionCompatibility("13.3.0", { logger, supportedVersion: "13.3.0" });
    expect(result.status).toBe("compatible");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a warning with structured context for an incompatible version", () => {
    const logger = makeLogger();
    const result = checkStellarSdkVersionCompatibility("14.0.0", { logger, supportedVersion: "13.3.0" });

    expect(result.status).toBe("incompatible");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.warn.mock.calls[0]!;
    expect(message).toContain("14.0.0");
    expect(message).toContain("13.3.0");
    expect(meta).toMatchObject({
      installedVersion: "14.0.0",
      supportedVersion: "13.3.0",
      kind: "major-mismatch",
    });
  });

  it("does not throw and does not log when no logger is supplied", () => {
    expect(() => checkStellarSdkVersionCompatibility("14.0.0", { supportedVersion: "13.3.0" })).not.toThrow();
  });

  it("does not log anything when no installed version is supplied (opt-in check)", () => {
    const logger = makeLogger();
    const result = checkStellarSdkVersionCompatibility(undefined, { logger });
    expect(result.status).toBe("unknown");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
