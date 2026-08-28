import { describe, expect, it } from "vitest";
import { auditWalletSecurity, isHighRiskConnection } from "../wallet/securityAudit";
import type { VulnerabilitySource, WalletSecurityAuditOptions } from "../wallet/securityAudit";
import { WalletType } from "../wallet/types";
import type { WalletAdapter, WalletCapabilities, WalletCapabilityId } from "../wallet/types";
import { ok } from "../shared/response";

const NOW = Date.UTC(2026, 4, 15);
const DAY = 24 * 60 * 60 * 1000;

function capabilities(
  walletType: WalletType,
  supported: readonly WalletCapabilityId[],
): WalletCapabilities {
  const ids: WalletCapabilityId[] = [
    "account.read",
    "transaction.sign",
    "transaction.sign_multisig",
    "transaction.sign_soroban",
  ];
  const list = ids.map((id) => ({
    id,
    supported: supported.includes(id),
    source: "adapter" as const,
  }));
  return {
    walletType,
    capabilities: list,
    supports: (capability: string) =>
      list.some((entry) => entry.id === capability && entry.supported),
  };
}

interface AdapterOverrides {
  walletType?: WalletType;
  available?: boolean;
  supported?: readonly WalletCapabilityId[];
  getCapabilities?: () => WalletCapabilities;
}

function makeAdapter(overrides: AdapterOverrides = {}): WalletAdapter {
  const walletType = overrides.walletType ?? WalletType.FREIGHTER;
  const supported = overrides.supported ?? [
    "account.read",
    "transaction.sign",
    "transaction.sign_multisig",
    "transaction.sign_soroban",
  ];
  return {
    walletType,
    isAvailable: () => overrides.available ?? true,
    connect: async () => ok("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"),
    disconnect: async () => ok(undefined),
    signTransaction: async () => ok("signed"),
    getCapabilities: overrides.getCapabilities ?? (() => capabilities(walletType, supported)),
  };
}

const CLEAN_SOURCE: VulnerabilitySource = {
  name: "test-advisories",
  vulnerabilities: [],
  knownWallets: [WalletType.FREIGHTER, WalletType.XBULL],
  updatedAt: NOW,
};

/** A fully healthy configuration: HTTPS, full capabilities, fresh clean source. */
function secureOptions(): WalletSecurityAuditOptions {
  return {
    now: NOW,
    connection: {
      connected: true,
      publicKey: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
      origin: "https://app.example.com",
      adapterVersion: "1.2.3",
    },
    vulnerabilitySource: CLEAN_SOURCE,
  };
}

function factorIds(report: ReturnType<typeof auditWalletSecurity>): string[] {
  return report.factors.map((factor) => factor.id);
}

describe("secure configuration", () => {
  it("scores at the top of the range with no penalties", () => {
    const report = auditWalletSecurity(makeAdapter(), secureOptions());

    expect(report.score).toBe(100);
    expect(report.riskLevel).toBe("low");
    expect(report.warnings).toEqual([]);
  });

  it("reports the wallet type and assessed capabilities", () => {
    const report = auditWalletSecurity(makeAdapter(), secureOptions());

    expect(report.walletType).toBe(WalletType.FREIGHTER);
    expect(report.capabilities).toContainEqual({ id: "transaction.sign", supported: true });
  });

  it("records a secure origin as an informational factor", () => {
    const report = auditWalletSecurity(makeAdapter(), secureOptions());

    expect(factorIds(report)).toContain("origin.secure");
  });

  it("marks vulnerability data as available", () => {
    const report = auditWalletSecurity(makeAdapter(), secureOptions());

    expect(report.vulnerabilityDataAvailable).toBe(true);
    expect(report.matchedVulnerabilities).toEqual([]);
  });

  it("does not claim a clean source proves safety", () => {
    const report = auditWalletSecurity(makeAdapter(), secureOptions());
    const factor = report.factors.find((entry) => entry.id === "vulnerability.none.known");

    expect(factor?.summary).toContain("not proof of safety");
  });

  it("is not flagged as high risk", () => {
    expect(isHighRiskConnection(auditWalletSecurity(makeAdapter(), secureOptions()))).toBe(false);
  });
});

describe("degraded configuration", () => {
  it("penalizes a missing signing capability as critical", () => {
    const adapter = makeAdapter({ supported: ["account.read"] });
    const report = auditWalletSecurity(adapter, secureOptions());

    expect(factorIds(report)).toContain("capability.transaction.sign.missing");
    expect(report.score).toBeLessThan(50);
    expect(isHighRiskConnection(report)).toBe(true);
  });

  it("applies a smaller penalty for a missing optional capability", () => {
    const adapter = makeAdapter({
      supported: ["account.read", "transaction.sign", "transaction.sign_soroban"],
    });
    const report = auditWalletSecurity(adapter, secureOptions());

    expect(report.score).toBe(95);
    expect(report.riskLevel).toBe("low");
  });

  it("penalizes an unavailable adapter", () => {
    const report = auditWalletSecurity(makeAdapter({ available: false }), secureOptions());

    expect(factorIds(report)).toContain("adapter.unavailable");
    expect(report.score).toBe(85);
  });

  it("treats an adapter whose availability check throws as unavailable", () => {
    const adapter = makeAdapter();
    const throwing: WalletAdapter = {
      ...adapter,
      isAvailable: () => {
        throw new Error("boom");
      },
    };

    expect(factorIds(auditWalletSecurity(throwing, secureOptions()))).toContain(
      "adapter.unavailable",
    );
  });

  it("penalizes a plain HTTP origin as high severity", () => {
    const options = secureOptions();
    const report = auditWalletSecurity(makeAdapter(), {
      ...options,
      connection: { ...options.connection, origin: "http://app.example.com" },
    });

    expect(factorIds(report)).toContain("origin.insecure");
    expect(report.score).toBe(70);
    expect(isHighRiskConnection(report)).toBe(true);
  });

  it("treats HTTP on localhost as a development-only low risk", () => {
    const options = secureOptions();
    const report = auditWalletSecurity(makeAdapter(), {
      ...options,
      connection: { ...options.connection, origin: "http://localhost:3000" },
    });

    expect(factorIds(report)).toContain("origin.localhost");
    expect(report.score).toBe(95);
  });

  it("penalizes an unparseable origin", () => {
    const options = secureOptions();
    const report = auditWalletSecurity(makeAdapter(), {
      ...options,
      connection: { ...options.connection, origin: "not a url" },
    });

    expect(factorIds(report)).toContain("origin.unparseable");
  });

  it("flags a connection that reports connected with no public key", () => {
    const options = secureOptions();
    const report = auditWalletSecurity(makeAdapter(), {
      ...options,
      connection: { ...options.connection, connected: true, publicKey: null },
    });

    expect(factorIds(report)).toContain("connection.unauthenticated");
    expect(isHighRiskConnection(report)).toBe(true);
  });

  it("continues the assessment when capabilities cannot be read", () => {
    const adapter = makeAdapter({
      getCapabilities: () => {
        throw new Error("adapter exploded");
      },
    });
    const report = auditWalletSecurity(adapter, secureOptions());

    expect(factorIds(report)).toContain("capabilities.unreadable");
    expect(report.capabilities).toEqual([]);
  });

  it("notes when capability values were inferred rather than reported", () => {
    // No getCapabilities — the shared helper falls back to its static table.
    const adapter = makeAdapter();
    const withoutCapabilities: WalletAdapter = { ...adapter };
    delete (withoutCapabilities as { getCapabilities?: unknown }).getCapabilities;

    const report = auditWalletSecurity(withoutCapabilities, secureOptions());
    expect(factorIds(report)).toContain("capabilities.inferred");
  });
});

describe("vulnerable configuration", () => {
  const vulnerableSource: VulnerabilitySource = {
    name: "test-advisories",
    knownWallets: [WalletType.FREIGHTER],
    updatedAt: NOW,
    vulnerabilities: [
      {
        id: "CVE-2026-0001",
        walletType: WalletType.FREIGHTER,
        severity: "critical",
        summary: "Signature request origin is not validated.",
        affectedVersions: ["1.2.3"],
      },
    ],
  };

  it("matches a vulnerability affecting the connected version", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: vulnerableSource,
    });

    expect(report.matchedVulnerabilities.map((v) => v.id)).toEqual(["CVE-2026-0001"]);
    expect(report.score).toBe(50);
    expect(isHighRiskConnection(report)).toBe(true);
  });

  it("surfaces the vulnerability as a warning", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: vulnerableSource,
    });

    expect(report.warnings.some((w) => w.includes("CVE-2026-0001"))).toBe(true);
  });

  it("does not match a version outside the affected range", () => {
    const options = secureOptions();
    const report = auditWalletSecurity(makeAdapter(), {
      ...options,
      connection: { ...options.connection, adapterVersion: "9.9.9" },
      vulnerabilitySource: vulnerableSource,
    });

    expect(report.matchedVulnerabilities).toEqual([]);
    expect(report.score).toBe(100);
  });

  it("does not match a vulnerability for a different wallet", () => {
    const report = auditWalletSecurity(makeAdapter({ walletType: WalletType.XBULL }), {
      ...secureOptions(),
      vulnerabilitySource: {
        ...vulnerableSource,
        knownWallets: [WalletType.FREIGHTER, WalletType.XBULL],
      },
    });

    expect(report.matchedVulnerabilities).toEqual([]);
  });

  it("treats an advisory with no version constraint as applying to all versions", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: {
        ...vulnerableSource,
        vulnerabilities: [
          {
            id: "CVE-2026-0002",
            walletType: WalletType.FREIGHTER,
            severity: "high",
            summary: "Affects every released version.",
          },
        ],
      },
    });

    expect(report.matchedVulnerabilities.map((v) => v.id)).toEqual(["CVE-2026-0002"]);
  });

  it("accumulates penalties across multiple vulnerabilities", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: {
        ...vulnerableSource,
        vulnerabilities: [
          {
            id: "A",
            walletType: WalletType.FREIGHTER,
            severity: "high",
            summary: "First issue.",
          },
          {
            id: "B",
            walletType: WalletType.FREIGHTER,
            severity: "medium",
            summary: "Second issue.",
          },
        ],
      },
    });

    expect(report.matchedVulnerabilities).toHaveLength(2);
    expect(report.score).toBe(55);
  });

  it("never scores below zero", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: `CVE-${index}`,
      walletType: WalletType.FREIGHTER,
      severity: "critical" as const,
      summary: "Severe issue.",
    }));
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: { ...vulnerableSource, vulnerabilities: many },
    });

    expect(report.score).toBe(0);
    expect(report.riskLevel).toBe("high");
  });
});

describe("unknown configuration", () => {
  it("does not treat a missing vulnerability source as safe", () => {
    const options = secureOptions();
    delete options.vulnerabilitySource;
    const report = auditWalletSecurity(makeAdapter(), options);

    expect(report.vulnerabilityDataAvailable).toBe(false);
    expect(factorIds(report)).toContain("vulnerability.source.absent");
    expect(report.score).toBeLessThan(100);
  });

  it("marks a wallet the source has not been checked against as unknown", () => {
    const report = auditWalletSecurity(makeAdapter({ walletType: WalletType.RABET }), {
      ...secureOptions(),
      vulnerabilitySource: CLEAN_SOURCE,
    });

    expect(report.vulnerabilityDataAvailable).toBe(false);
    expect(factorIds(report)).toContain("vulnerability.wallet.uncovered");
  });

  it("penalizes an unknown adapter version against version-scoped advisories", () => {
    const options = secureOptions();
    const report = auditWalletSecurity(makeAdapter(), {
      ...options,
      connection: { ...options.connection, adapterVersion: undefined },
      vulnerabilitySource: {
        ...CLEAN_SOURCE,
        vulnerabilities: [
          {
            id: "CVE-2026-0003",
            walletType: WalletType.XBULL,
            severity: "high",
            summary: "Other wallet issue.",
            affectedVersions: ["0.1.0"],
          },
        ],
      },
    });

    expect(factorIds(report)).toContain("vulnerability.version.unknown");
  });

  it("penalizes a source with no update timestamp", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: { name: "undated", vulnerabilities: [], knownWallets: [WalletType.FREIGHTER] },
    });

    expect(factorIds(report)).toContain("vulnerability.source.undated");
  });

  it("penalizes a stale source", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: { ...CLEAN_SOURCE, updatedAt: NOW - 40 * DAY },
    });

    expect(factorIds(report)).toContain("vulnerability.source.stale");
  });

  it("respects a custom staleness window", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      ...secureOptions(),
      vulnerabilitySource: { ...CLEAN_SOURCE, updatedAt: NOW - 2 * DAY },
      maxSourceAgeMs: DAY,
    });

    expect(factorIds(report)).toContain("vulnerability.source.stale");
  });

  it("records that origin could not be evaluated when none is supplied", () => {
    const report = auditWalletSecurity(makeAdapter(), {
      now: NOW,
      vulnerabilitySource: CLEAN_SOURCE,
    });

    expect(factorIds(report)).toContain("origin.unavailable");
  });
});

describe("report structure", () => {
  it("is deterministic across repeated audits of identical input", () => {
    const first = auditWalletSecurity(makeAdapter(), secureOptions());
    const second = auditWalletSecurity(makeAdapter(), secureOptions());

    expect(first.score).toBe(second.score);
    expect(factorIds(first)).toEqual(factorIds(second));
  });

  it("keeps the score within 0 and 100", () => {
    const report = auditWalletSecurity(makeAdapter({ supported: [] }), {
      now: NOW,
      connection: { connected: true, publicKey: null, origin: "http://evil.example.com" },
    });

    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("exposes the individual factors that produced the score", () => {
    const report = auditWalletSecurity(makeAdapter({ supported: ["account.read"] }), secureOptions());
    const penalties = report.factors.filter((factor) => factor.scoreDelta < 0);

    expect(penalties.length).toBeGreaterThan(0);
    expect(report.score).toBe(
      100 + report.factors.reduce((total, factor) => total + factor.scoreDelta, 0),
    );
  });

  it("excludes informational factors from warnings", () => {
    const report = auditWalletSecurity(makeAdapter(), secureOptions());

    expect(report.factors.some((factor) => factor.severity === "info")).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("marks every score delta as a non-positive penalty", () => {
    const report = auditWalletSecurity(makeAdapter({ supported: [] }), secureOptions());

    expect(report.factors.every((factor) => factor.scoreDelta <= 0)).toBe(true);
  });

  it("maps scores onto risk bands", () => {
    const high = auditWalletSecurity(makeAdapter({ supported: [] }), {
      now: NOW,
      connection: { connected: true, publicKey: null, origin: "http://evil.example.com" },
    });

    expect(high.riskLevel).toBe("high");
    expect(auditWalletSecurity(makeAdapter(), secureOptions()).riskLevel).toBe("low");
  });
});
