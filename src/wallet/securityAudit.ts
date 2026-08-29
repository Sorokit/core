import { getWalletCapabilities, WALLET_CAPABILITY_IDS } from "./capabilities";
import type { WalletAdapter, WalletCapabilities, WalletCapabilityId, WalletType } from "./types";

// ─── Types ───

/** Severity of a single risk factor. */
export type RiskSeverity = "info" | "low" | "medium" | "high" | "critical";

/** Confidence in the evidence behind a factor. */
export type RiskConfidence = "confirmed" | "reported" | "unknown";

/**
 * One contributing element of an assessment.
 *
 * `scoreDelta` is the penalty this factor applied to the score. A factor with a
 * delta of 0 is informational and did not affect the score.
 */
export interface RiskFactor {
  id: string;
  severity: RiskSeverity;
  confidence: RiskConfidence;
  /** What was observed. */
  summary: string;
  /** Penalty applied to the base score. Always <= 0. */
  scoreDelta: number;
}

/** A known vulnerability affecting a wallet, supplied by the caller. */
export interface WalletVulnerability {
  id: string;
  walletType: WalletType;
  severity: RiskSeverity;
  summary: string;
  /** Adapter versions affected. When omitted, all versions are treated as affected. */
  affectedVersions?: readonly string[];
}

/**
 * A source of vulnerability information.
 *
 * `knownWallets` declares which wallets the source has actually been checked
 * against. A wallet absent from that list is reported as unknown rather than
 * clean — see {@link auditWalletSecurity}.
 */
export interface VulnerabilitySource {
  name: string;
  vulnerabilities: readonly WalletVulnerability[];
  knownWallets?: readonly WalletType[];
  /** Epoch milliseconds the source data was produced. */
  updatedAt?: number;
}

/** Details of the live connection being assessed. */
export interface WalletConnectionContext {
  connected?: boolean;
  publicKey?: string | null;
  /** Page origin the connection was established from, when observable. */
  origin?: string;
  /** Adapter version string, when the adapter reports one. */
  adapterVersion?: string;
}

export interface WalletSecurityAuditOptions {
  connection?: WalletConnectionContext;
  vulnerabilitySource?: VulnerabilitySource;
  /** Epoch milliseconds treated as now, for staleness checks. */
  now?: number;
  /** Age beyond which a vulnerability source is considered stale. Defaults to 30 days. */
  maxSourceAgeMs?: number;
}

export type RiskLevel = "low" | "moderate" | "elevated" | "high";

export interface WalletSecurityReport {
  walletType: WalletType;
  /**
   * Deterministic 0–100 rating derived from the factors below.
   *
   * This score summarizes only what was observable at audit time. It is not a
   * guarantee of safety — read {@link WalletSecurityReport.factors}.
   */
  score: number;
  riskLevel: RiskLevel;
  /** Every factor considered, including those that applied no penalty. */
  factors: readonly RiskFactor[];
  /** Human-readable warnings for factors needing attention. */
  warnings: readonly string[];
  /** Capabilities the adapter reported, as assessed. */
  capabilities: readonly { id: WalletCapabilityId; supported: boolean }[];
  /** True when vulnerability data for this wallet could not be established. */
  vulnerabilityDataAvailable: boolean;
  /** Vulnerabilities matched against this wallet. */
  matchedVulnerabilities: readonly WalletVulnerability[];
}

// ─── Scoring constants ───
//
// Penalties are fixed so that the same inputs always produce the same score.

const BASE_SCORE = 100;

const SEVERITY_PENALTY: Record<RiskSeverity, number> = {
  info: 0,
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
};

const DEFAULT_MAX_SOURCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Capabilities whose absence weakens the security posture. */
const SECURITY_RELEVANT_CAPABILITIES: readonly {
  id: WalletCapabilityId;
  severity: RiskSeverity;
  label: string;
}[] = [
  { id: WALLET_CAPABILITY_IDS.transactionSign, severity: "critical", label: "transaction signing" },
  {
    id: WALLET_CAPABILITY_IDS.transactionSignMultisig,
    severity: "low",
    label: "multi-signature signing",
  },
  {
    id: WALLET_CAPABILITY_IDS.transactionSignSoroban,
    severity: "low",
    label: "Soroban transaction signing",
  },
];

// ─── Origin evaluation ───

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Assess the connection origin.
 *
 * Returns `undefined` when no origin was supplied — an unobservable origin is
 * reported separately rather than silently passing.
 */
function evaluateOrigin(origin: string | undefined): RiskFactor | undefined {
  if (origin === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {
      id: "origin.unparseable",
      severity: "medium",
      confidence: "confirmed",
      summary: `Connection origin "${origin}" is not a valid URL and could not be evaluated.`,
      scoreDelta: -SEVERITY_PENALTY.medium,
    };
  }

  if (parsed.protocol === "https:") {
    return {
      id: "origin.secure",
      severity: "info",
      confidence: "confirmed",
      summary: `Connection origin ${parsed.origin} uses HTTPS.`,
      scoreDelta: 0,
    };
  }

  if (parsed.protocol === "http:" && isLocalHost(parsed.hostname)) {
    return {
      id: "origin.localhost",
      severity: "low",
      confidence: "confirmed",
      summary: `Connection origin ${parsed.origin} is plain HTTP on localhost — acceptable for development, not production.`,
      scoreDelta: -SEVERITY_PENALTY.low,
    };
  }

  return {
    id: "origin.insecure",
    severity: "high",
    confidence: "confirmed",
    summary: `Connection origin ${parsed.origin} does not use HTTPS — traffic can be intercepted or modified.`,
    scoreDelta: -SEVERITY_PENALTY.high,
  };
}

// ─── Vulnerability matching ───

function versionAffected(
  vulnerability: WalletVulnerability,
  adapterVersion: string | undefined,
): boolean {
  if (!vulnerability.affectedVersions || vulnerability.affectedVersions.length === 0) return true;
  if (adapterVersion === undefined) return true;
  return vulnerability.affectedVersions.includes(adapterVersion);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function toRiskLevel(score: number): RiskLevel {
  if (score >= 85) return "low";
  if (score >= 65) return "moderate";
  if (score >= 40) return "elevated";
  return "high";
}

// ─── Audit ───

/**
 * Produce a structured security assessment of a wallet adapter and connection.
 *
 * The report exposes every factor that produced the score so callers can act on
 * the underlying evidence rather than the number alone.
 *
 * Important limits — the score is not a safety guarantee:
 * - It reflects only what was observable at audit time: declared adapter
 *   capabilities, the supplied connection context, and whatever vulnerability
 *   data the caller passed in.
 * - Capabilities are self-declared by the adapter and are not verified here.
 * - With no `vulnerabilitySource`, or one that has not been checked against this
 *   wallet, vulnerability status is *unknown*. Unknown status is penalized, never
 *   treated as clean, and `vulnerabilityDataAvailable` is false.
 *
 * @param adapter - The wallet adapter to assess.
 * @param options - Connection context and vulnerability source.
 * @returns A structured report. This function does not throw.
 */
export function auditWalletSecurity(
  adapter: WalletAdapter,
  options: WalletSecurityAuditOptions = {},
): WalletSecurityReport {
  const factors: RiskFactor[] = [];
  const now = options.now ?? Date.now();

  let capabilities: WalletCapabilities;
  try {
    capabilities = getWalletCapabilities(adapter);
  } catch {
    capabilities = {
      walletType: adapter.walletType,
      capabilities: [],
      supports: () => false,
    };
    factors.push({
      id: "capabilities.unreadable",
      severity: "medium",
      confidence: "unknown",
      summary: "Adapter capabilities could not be read; assessment proceeded without them.",
      scoreDelta: -SEVERITY_PENALTY.medium,
    });
  }

  // ─── Availability ───
  let available: boolean;
  try {
    available = adapter.isAvailable();
  } catch {
    available = false;
  }
  if (!available) {
    factors.push({
      id: "adapter.unavailable",
      severity: "medium",
      confidence: "confirmed",
      summary: "Wallet adapter reports it is not available in this environment.",
      scoreDelta: -SEVERITY_PENALTY.medium,
    });
  }

  // ─── Capabilities ───
  for (const expected of SECURITY_RELEVANT_CAPABILITIES) {
    const supported = capabilities.capabilities.some(
      (capability) => capability.id === expected.id && capability.supported,
    );
    if (supported) {
      factors.push({
        id: `capability.${expected.id}.supported`,
        severity: "info",
        confidence: "confirmed",
        summary: `Adapter declares support for ${expected.label}.`,
        scoreDelta: 0,
      });
    } else {
      factors.push({
        id: `capability.${expected.id}.missing`,
        severity: expected.severity,
        confidence: "confirmed",
        summary: `Adapter does not declare support for ${expected.label}.`,
        scoreDelta: -SEVERITY_PENALTY[expected.severity],
      });
    }
  }

  // A capability answered from the fallback table was inferred, not reported.
  const inferred = capabilities.capabilities.filter(
    (capability) => capability.source === "fallback",
  );
  if (inferred.length > 0) {
    factors.push({
      id: "capabilities.inferred",
      severity: "info",
      confidence: "reported",
      summary: `${inferred.length} capability value(s) were inferred from a static table rather than reported by the adapter.`,
      scoreDelta: 0,
    });
  }

  // ─── Connection state ───
  const connection = options.connection;
  if (connection?.connected === true && !connection.publicKey) {
    factors.push({
      id: "connection.unauthenticated",
      severity: "high",
      confidence: "confirmed",
      summary: "Connection reports as connected but exposes no public key — authentication state is inconsistent.",
      scoreDelta: -SEVERITY_PENALTY.high,
    });
  }

  // ─── Origin ───
  const originFactor = evaluateOrigin(connection?.origin);
  if (originFactor) {
    factors.push(originFactor);
  } else {
    factors.push({
      id: "origin.unavailable",
      severity: "info",
      confidence: "unknown",
      summary: "No connection origin was supplied, so origin could not be evaluated.",
      scoreDelta: 0,
    });
  }

  // ─── Vulnerabilities ───
  const source = options.vulnerabilitySource;
  const matched: WalletVulnerability[] = [];
  let vulnerabilityDataAvailable = false;

  if (!source) {
    factors.push({
      id: "vulnerability.source.absent",
      severity: "medium",
      confidence: "unknown",
      summary:
        "No vulnerability source was configured. Vulnerability status is unknown and is not treated as clean.",
      scoreDelta: -SEVERITY_PENALTY.medium,
    });
  } else {
    const covered =
      source.knownWallets === undefined || source.knownWallets.includes(adapter.walletType);

    if (!covered) {
      factors.push({
        id: "vulnerability.wallet.uncovered",
        severity: "medium",
        confidence: "unknown",
        summary: `Vulnerability source "${source.name}" has not been checked against ${adapter.walletType}; its status is unknown.`,
        scoreDelta: -SEVERITY_PENALTY.medium,
      });
    } else {
      vulnerabilityDataAvailable = true;

      for (const vulnerability of source.vulnerabilities) {
        if (vulnerability.walletType !== adapter.walletType) continue;
        if (!versionAffected(vulnerability, connection?.adapterVersion)) continue;
        matched.push(vulnerability);
        factors.push({
          id: `vulnerability.${vulnerability.id}`,
          severity: vulnerability.severity,
          confidence: "reported",
          summary: `Known vulnerability ${vulnerability.id}: ${vulnerability.summary}`,
          scoreDelta: -SEVERITY_PENALTY[vulnerability.severity],
        });
      }

      if (matched.length === 0) {
        factors.push({
          id: "vulnerability.none.known",
          severity: "info",
          confidence: "reported",
          summary: `No known vulnerabilities for ${adapter.walletType} in source "${source.name}". Absence of a report is not proof of safety.`,
          scoreDelta: 0,
        });
      }

      // An unversioned adapter cannot be excluded from version-scoped advisories.
      if (connection?.adapterVersion === undefined && source.vulnerabilities.length > 0) {
        factors.push({
          id: "vulnerability.version.unknown",
          severity: "low",
          confidence: "unknown",
          summary:
            "Adapter version is unknown, so version-scoped advisories were treated as applicable.",
          scoreDelta: -SEVERITY_PENALTY.low,
        });
      }
    }

    const age = source.updatedAt === undefined ? undefined : now - source.updatedAt;
    const maxAge = options.maxSourceAgeMs ?? DEFAULT_MAX_SOURCE_AGE_MS;
    if (source.updatedAt === undefined) {
      factors.push({
        id: "vulnerability.source.undated",
        severity: "low",
        confidence: "unknown",
        summary: `Vulnerability source "${source.name}" carries no update timestamp; its freshness is unknown.`,
        scoreDelta: -SEVERITY_PENALTY.low,
      });
    } else if (age !== undefined && age > maxAge) {
      factors.push({
        id: "vulnerability.source.stale",
        severity: "low",
        confidence: "confirmed",
        summary: `Vulnerability source "${source.name}" is stale — last updated ${Math.floor(age / 86_400_000)} day(s) ago.`,
        scoreDelta: -SEVERITY_PENALTY.low,
      });
    }
  }

  const score = clampScore(
    factors.reduce((total, factor) => total + factor.scoreDelta, BASE_SCORE),
  );

  const warnings = factors
    .filter((factor) => factor.severity !== "info")
    .map((factor) => factor.summary);

  return {
    walletType: adapter.walletType,
    score,
    riskLevel: toRiskLevel(score),
    factors,
    warnings,
    capabilities: capabilities.capabilities.map((capability) => ({
      id: capability.id,
      supported: capability.supported,
    })),
    vulnerabilityDataAvailable,
    matchedVulnerabilities: matched,
  };
}

/**
 * Whether a report should block or warn a user before proceeding.
 *
 * True when the score falls into the elevated or high band, or any factor is
 * high or critical severity.
 */
export function isHighRiskConnection(report: WalletSecurityReport): boolean {
  return (
    report.riskLevel === "elevated" ||
    report.riskLevel === "high" ||
    report.factors.some((factor) => factor.severity === "high" || factor.severity === "critical")
  );
}
