/**
 * Account health score and risk assessment (#590).
 *
 * Evaluates the on-chain security configuration of a Stellar account — the
 * master key weight, the operation thresholds, and the diversity / weight
 * distribution of the signer set — and produces a deterministic health score
 * between 0 (critically unsafe) and 100 (well configured), together with a
 * per-dimension breakdown and a list of identified risks.
 *
 * The assessment is read-only: it inspects configuration and reports risks. It
 * never mutates the account and performs no remediation — executing fixes is
 * explicitly out of scope for this module (#590).
 *
 * @example
 * ```ts
 * const health = await client.account.getAccountHealthScore(publicKey);
 * if (health.status === "ok") {
 *   console.log(health.data.score, health.data.risks);
 * }
 * ```
 */

import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { getSigners, getThresholds } from "./signers";
import type { AccountSigner, AccountThresholds } from "./signers";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Severity of an individual account health risk. */
export type AccountHealthRiskSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

/** A single risk identified while assessing an account. */
export interface AccountHealthRisk {
  /** Stable identifier for the risk, e.g. `"master.enabled"`. */
  id: string;
  /** How severe the risk is. */
  severity: AccountHealthRiskSeverity;
  /** Human-readable description of what was observed. */
  summary: string;
}

/**
 * Per-dimension sub-scores.
 *
 * Each component is on a `0`–`10` scale where **10 is safest**. The overall
 * {@link AccountHealthReport.score} is the weighted average of the three,
 * scaled to `0`–`100`.
 */
export interface AccountHealthComponents {
  /** Master key weight assessment (`0` — disabled — is the safest). */
  masterWeight: number;
  /** Threshold configuration assessment (ordering and reachability). */
  thresholds: number;
  /** Signer diversity and weight-distribution assessment. */
  diversity: number;
}

/** Qualitative band derived from the overall {@link AccountHealthReport.score}. */
export type AccountHealthLevel = "low" | "moderate" | "elevated" | "high";

/** The full assessment returned by {@link assessAccountHealth}. */
export interface AccountHealthReport {
  /** Overall health score, `0`–`100`. Higher is safer. */
  score: number;
  /** Risk band derived from `score` (`"low"` risk is the healthiest). */
  riskLevel: AccountHealthLevel;
  /** Per-dimension sub-scores, each `0`–`10`. */
  components: AccountHealthComponents;
  /** Human-readable risk summaries. Empty when no risks were identified. */
  risks: string[];
  /** Structured form of {@link AccountHealthReport.risks}, with severity. */
  riskDetails: AccountHealthRisk[];
  /** Total signing weight available across all signers. */
  totalWeight: number;
  /** Number of distinct signer keys carrying a non-zero weight. */
  activeSigners: number;
  /** Master key weight that was assessed. */
  masterWeight: number;
  /** Thresholds that were assessed. */
  thresholds: AccountThresholds;
  /** ISO-8601 timestamp of the assessment. */
  assessedAt: string;
}

/** The account configuration to assess. */
export interface AccountHealthInput {
  /** Public key of the account (used to label the synthesised master signer). */
  publicKey?: string;
  /** Master key weight. `0` means the master key is disabled (safest). */
  masterWeight: number;
  /** Operation thresholds applied to the account. */
  thresholds: AccountThresholds;
  /**
   * Signers on the account. May include a `master` entry (as returned by
   * {@link getSigners}); when absent, one is synthesised from `masterWeight`
   * so the assessment never loses the master key from the signer set.
   */
  signers?: AccountSigner[];
}

/** Options for {@link assessAccountHealth}. */
export interface AssessAccountHealthOptions {
  /** Epoch milliseconds treated as "now" — makes the assessment deterministic. */
  now?: number;
}

// ─── Scoring constants ───────────────────────────────────────────────────────
//
// Fixed weights and penalties keep the score reproducible: the same account
// configuration always produces the same score.

const COMPONENT_MAX = 10;

/** Relative weight of each component in the overall score (sums to 1). */
const COMPONENT_WEIGHTS = {
  masterWeight: 0.4,
  thresholds: 0.3,
  diversity: 0.3,
} as const;

/** Maximum weight a single signer or threshold can carry on Stellar. */
const MAX_SIGNER_WEIGHT = 255;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 0;
  return Math.max(0, Math.min(MAX_SIGNER_WEIGHT, Math.trunc(weight)));
}

function clampComponent(score: number): number {
  return Math.max(0, Math.min(COMPONENT_MAX, Math.round(score)));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function toRiskLevel(score: number): AccountHealthLevel {
  if (score >= 85) return "low";
  if (score >= 65) return "moderate";
  if (score >= 40) return "elevated";
  return "high";
}

/**
 * Build the full signer list, ensuring the master key is represented exactly
 * once. Existing `master` entries (as produced by {@link getSigners}) win so we
 * never double-count the master weight.
 */
function buildSignerList(
  input: AccountHealthInput,
  masterWeight: number,
): AccountSigner[] {
  const provided = input.signers ?? [];
  const hasMaster = provided.some((signer) => signer.type === "master");
  if (hasMaster) return [...provided];
  return [
    {
      key: input.publicKey ?? "master",
      type: "master",
      weight: masterWeight,
    },
    ...provided,
  ];
}

/**
 * Deduplicate signers by key (summing weights for repeated keys) and drop
 * zero-weight entries. Horizon should not return duplicates, but the assessment
 * must stay correct for hand-built inputs.
 */
function normaliseSigners(signers: AccountSigner[]): {
  active: AccountSigner[];
  duplicatedKeys: string[];
} {
  const byKey = new Map<string, AccountSigner>();
  const duplicatedKeys: string[] = [];

  for (const signer of signers) {
    const weight = clampWeight(signer.weight);
    if (weight <= 0) continue;

    const existing = byKey.get(signer.key);
    if (existing) {
      existing.weight += weight;
      if (!duplicatedKeys.includes(signer.key)) duplicatedKeys.push(signer.key);
    } else {
      byKey.set(signer.key, { key: signer.key, type: signer.type, weight });
    }
  }

  return { active: [...byKey.values()], duplicatedKeys };
}

// ─── Component assessments ───────────────────────────────────────────────────

function assessMasterWeight(
  masterWeight: number,
  thresholds: AccountThresholds,
  active: AccountSigner[],
  risks: AccountHealthRisk[],
): number {
  // A disabled master key (weight 0) cannot sign — the safest configuration.
  if (masterWeight <= 0) return COMPONENT_MAX;

  const otherSigners = active.filter((signer) => signer.type !== "master");
  let score = COMPONENT_MAX - 2; // 8: enabled but below the low threshold

  risks.push({
    id: "master.enabled",
    severity: "low",
    summary: `Master key is enabled with weight ${masterWeight}; a leaked master secret can authorize operations.`,
  });

  if (otherSigners.length === 0) {
    score = 3;
    risks.push({
      id: "master.sole-signer",
      severity: "high",
      summary:
        "Master key is the only signer carrying weight — the account has a single point of failure.",
    });
  }

  if (thresholds.high > 0 && masterWeight >= thresholds.high) {
    score = Math.min(score, 1);
    risks.push({
      id: "master.meets-high",
      severity: "critical",
      summary: `Master key weight ${masterWeight} alone meets the high threshold (${thresholds.high}); it can single-handedly authorize the most sensitive operations.`,
    });
  } else if (thresholds.medium > 0 && masterWeight >= thresholds.medium) {
    score = Math.min(score, 3);
    risks.push({
      id: "master.meets-medium",
      severity: "high",
      summary: `Master key weight ${masterWeight} alone meets the medium threshold (${thresholds.medium}).`,
    });
  } else if (thresholds.low > 0 && masterWeight >= thresholds.low) {
    score = Math.min(score, 5);
    risks.push({
      id: "master.meets-low",
      severity: "medium",
      summary: `Master key weight ${masterWeight} alone meets the low threshold (${thresholds.low}).`,
    });
  }

  return clampComponent(score);
}

function assessThresholds(
  thresholds: AccountThresholds,
  totalWeight: number,
  risks: AccountHealthRisk[],
): number {
  const { low, medium, high } = thresholds;
  let score = COMPONENT_MAX;

  // Ordering is a hard Stellar invariant: low <= medium <= high.
  if (low > medium || medium > high) {
    score -= 5;
    risks.push({
      id: "thresholds.unordered",
      severity: "high",
      summary: `Thresholds are not ordered (low ${low}, medium ${medium}, high ${high}); Stellar requires low ≤ medium ≤ high.`,
    });
  }

  // A zero threshold means the corresponding operations require no signature.
  if (high <= 0) {
    score -= 4;
    risks.push({
      id: "thresholds.high-zero",
      severity: "high",
      summary:
        "High threshold is 0 — the most sensitive operations require no signature.",
    });
  }
  if (medium <= 0) {
    score -= 1;
    risks.push({
      id: "thresholds.medium-zero",
      severity: "medium",
      summary: "Medium threshold is 0 — medium-risk operations require no signature.",
    });
  }
  if (low <= 0) {
    score -= 1;
    risks.push({
      id: "thresholds.low-zero",
      severity: "low",
      summary: "Low threshold is 0 — low-risk operations require no signature.",
    });
  }

  // Reachability: each threshold must be satisfiable by the total signing
  // weight, otherwise the account risks locking itself out.
  const levels: ReadonlyArray<{ name: "low" | "medium" | "high"; value: number }> = [
    { name: "low", value: low },
    { name: "medium", value: medium },
    { name: "high", value: high },
  ];
  for (const level of levels) {
    if (level.value > 0 && level.value > totalWeight) {
      score -= 4;
      risks.push({
        id: `thresholds.${level.name}-unreachable`,
        severity: level.name === "high" ? "critical" : "high",
        summary: `The ${level.name} threshold (${level.value}) exceeds the total signer weight (${totalWeight}); the account risks locking itself out of ${level.name}-risk operations.`,
      });
      break;
    }
  }

  // An extreme but reachable high threshold leaves no margin for error.
  if (high >= MAX_SIGNER_WEIGHT && high <= totalWeight) {
    score -= 1;
    risks.push({
      id: "thresholds.high-max",
      severity: "low",
      summary: `High threshold is at the maximum (${MAX_SIGNER_WEIGHT}); operation signing has no tolerance for a single lost signer.`,
    });
  }

  return clampComponent(score);
}

function assessDiversity(
  active: AccountSigner[],
  duplicatedKeys: string[],
  thresholds: AccountThresholds,
  risks: AccountHealthRisk[],
): number {
  let score: number;

  if (active.length === 0) {
    score = 0;
    risks.push({
      id: "diversity.no-signers",
      severity: "critical",
      summary:
        "No signer carries weight — the account cannot authorize any operation.",
    });
    return clampComponent(score);
  }

  if (active.length === 1) {
    score = 3;
    risks.push({
      id: "diversity.single-signer",
      severity: "high",
      summary:
        "A single signer controls the account — losing or leaking one key compromises it.",
    });
  } else if (active.length === 2) {
    score = 7;
    risks.push({
      id: "diversity.two-signers",
      severity: "low",
      summary:
        "Only two signers are configured — diversity is minimal (consider three or more).",
    });
  } else if (active.length === 3) {
    score = 9;
  } else {
    score = COMPONENT_MAX;
  }

  if (duplicatedKeys.length > 0) {
    score -= 3;
    risks.push({
      id: "diversity.duplicate-signers",
      severity: "medium",
      summary: `${duplicatedKeys.length} duplicate signer key(s) found (${duplicatedKeys.join(", ")}); each key should appear at most once.`,
    });
  }

  // Weight concentration: any single signer able to meet the high threshold
  // alone makes the multisig cosmetic.
  const heaviest = active.reduce((max, signer) =>
    signer.weight > max.weight ? signer : max,
  );
  if (thresholds.high > 0 && active.length > 1 && heaviest.weight >= thresholds.high) {
    score = Math.min(score, 4);
    risks.push({
      id: "diversity.dominant-signer",
      severity: "high",
      summary: `Signer ${heaviest.key} carries weight ${heaviest.weight}, which alone meets the high threshold (${thresholds.high}) — one signer is too powerful.`,
    });
  }

  return clampComponent(score);
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Assess the health of an account's security configuration.
 *
 * This function is pure and deterministic — it performs no network access and
 * does not throw. Feed it the values returned by {@link getSigners} and
 * {@link getThresholds}, or any equivalent configuration.
 *
 * @param input   - Master weight, thresholds, and signers to assess.
 * @param options - Optional `now` for deterministic `assessedAt` timestamps.
 * @returns A report with a `0`–`100` score, per-dimension components, and risks.
 *
 * @example
 * ```ts
 * const report = assessAccountHealth({
 *   masterWeight: 0,
 *   thresholds: { low: 1, medium: 2, high: 3 },
 *   signers: [
 *     { key: "GAAA…", type: "ed25519_public_key", weight: 1 },
 *     { key: "GBBB…", type: "ed25519_public_key", weight: 2 },
 *   ],
 * });
 * console.log(report.score, report.risks);
 * ```
 */
export function assessAccountHealth(
  input: AccountHealthInput,
  options: AssessAccountHealthOptions = {},
): AccountHealthReport {
  const masterWeight = clampWeight(input.masterWeight);
  const thresholds: AccountThresholds = {
    low: clampWeight(input.thresholds.low),
    medium: clampWeight(input.thresholds.medium),
    high: clampWeight(input.thresholds.high),
  };

  const { active, duplicatedKeys } = normaliseSigners(
    buildSignerList(input, masterWeight),
  );
  const totalWeight = active.reduce((sum, signer) => sum + signer.weight, 0);

  const riskDetails: AccountHealthRisk[] = [];

  const masterWeightScore = assessMasterWeight(
    masterWeight,
    thresholds,
    active,
    riskDetails,
  );
  const thresholdsScore = assessThresholds(thresholds, totalWeight, riskDetails);
  const diversityScore = assessDiversity(
    active,
    duplicatedKeys,
    thresholds,
    riskDetails,
  );

  const weighted =
    masterWeightScore * COMPONENT_WEIGHTS.masterWeight +
    thresholdsScore * COMPONENT_WEIGHTS.thresholds +
    diversityScore * COMPONENT_WEIGHTS.diversity;

  const score = clampScore(weighted * COMPONENT_MAX);

  return {
    score,
    riskLevel: toRiskLevel(score),
    components: {
      masterWeight: masterWeightScore,
      thresholds: thresholdsScore,
      diversity: diversityScore,
    },
    risks: riskDetails.map((risk) => risk.summary),
    riskDetails,
    totalWeight,
    activeSigners: active.length,
    masterWeight,
    thresholds,
    assessedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

/**
 * Fetch an account from Horizon and assess its security configuration.
 *
 * Builds on the existing {@link getSigners} and {@link getThresholds} helpers,
 * so it inherits their error mapping (`ACCOUNT_NOT_FOUND`,
 * `ACCOUNT_FETCH_FAILED`) and never throws.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param publicKey  - Stellar G-address of the account to assess.
 * @returns `ok(AccountHealthReport)` on success, or the propagated
 *          `SorokitResult` error from the underlying fetch.
 *
 * @example
 * ```ts
 * const result = await getAccountHealthScore(horizonUrl, publicKey);
 * if (result.status === "ok") {
 *   console.log(result.data.score, result.data.risks);
 * }
 * ```
 */
export async function getAccountHealthScore(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<AccountHealthReport>> {
  const [signersResult, thresholdsResult] = await Promise.all([
    getSigners(horizonUrl, publicKey),
    getThresholds(horizonUrl, publicKey),
  ]);

  if (signersResult.status === "error") return signersResult;
  if (thresholdsResult.status === "error") return thresholdsResult;

  return ok(
    assessAccountHealth({
      publicKey,
      masterWeight: signersResult.data.masterWeight,
      thresholds: thresholdsResult.data,
      signers: signersResult.data.signers,
    }),
  );
}
