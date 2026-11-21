/**
 * Guards against public functionality becoming unreachable (#791).
 *
 * compliance/, utility/, and infrastructure/logger.ts were fully implemented
 * but never re-exported from the package's main entry point, never given a
 * package.json subpath, and never listed in tsup.config.ts's entry list —
 * so none of it ever shipped in dist/ or could be imported by consumers.
 * This test imports every previously-stranded symbol from the main barrel
 * to make sure that regression can't silently reoccur.
 */
import { describe, expect, it } from "vitest";
import * as sorokitCore from "../index";

describe("main entry point re-exports previously unreachable modules (#791)", () => {
  it("re-exports the compliance audit trail API", () => {
    expect(typeof sorokitCore.createAuditTrail).toBe("function");
    expect(typeof sorokitCore.recordOperation).toBe("function");
    expect(typeof sorokitCore.recordAction).toBe("function");
    expect(typeof sorokitCore.getAuditTrail).toBe("function");
    expect(typeof sorokitCore.queryAuditLog).toBe("function");
    expect(typeof sorokitCore.getAllEntries).toBe("function");
    expect(typeof sorokitCore.clearAuditTrail).toBe("function");
    expect(typeof sorokitCore.generateComplianceReport).toBe("function");
  });

  it("re-exports the utility validation/rate-limiting API under aliased names", () => {
    expect(typeof sorokitCore.validateAddressUtility).toBe("function");
    expect(typeof sorokitCore.isValidAddressUtility).toBe("function");
    expect(typeof sorokitCore.validateAmountUtility).toBe("function");
    expect(typeof sorokitCore.validateAssetCodeUtility).toBe("function");
    expect(typeof sorokitCore.validateUrlUtility).toBe("function");
    expect(typeof sorokitCore.sanitizeInput).toBe("function");
    expect(typeof sorokitCore.deduplicateRequest).toBe("function");
    expect(typeof sorokitCore.createRateLimiter).toBe("function");
    expect(sorokitCore.UTILITY_STELLAR_MAX_DECIMALS).toBe(7);
    expect(sorokitCore.STELLAR_MIN_ASSET_CODE_LEN).toBe(1);
    expect(sorokitCore.STELLAR_MAX_ASSET_CODE_LEN).toBe(12);
  });

  it("re-exports the infrastructure logger API under aliased names", () => {
    expect(typeof sorokitCore.createInfraLogger).toBe("function");
    expect(typeof sorokitCore.createInfraConsoleTransport).toBe("function");
    expect(typeof sorokitCore.createInfraFileTransport).toBe("function");
    expect(typeof sorokitCore.createInfraExternalTransport).toBe("function");

    const logger = sorokitCore.createInfraLogger("test-module");
    expect(logger.name).toBe("test-module");
  });

  it("does not let the infra logger alias collide with the canonical shared logger export", () => {
    // shared/logger.ts exports createTracedLogger (and, internally,
    // createLogger with an options-object signature returning a
    // SorokitLogger); infrastructure/logger.ts's createInfraLogger takes a
    // name string and returns a different Logger shape. The aliasing keeps
    // both independently callable from the main barrel without a name clash.
    expect(typeof sorokitCore.createTracedLogger).toBe("function");
    expect(typeof sorokitCore.createInfraLogger).toBe("function");
    expect(sorokitCore.createTracedLogger).not.toBe(sorokitCore.createInfraLogger);
  });

  it("re-exports the runtime shape validators (#790)", () => {
    expect(typeof sorokitCore.validateAssetBalance).toBe("function");
    expect(typeof sorokitCore.validateAccountInfo).toBe("function");
    expect(typeof sorokitCore.validateResolvedNetworkConfig).toBe("function");
  });
});
