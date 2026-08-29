import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ───

/** Window over which a cumulative limit accrues. */
export type SpendingLimitPeriod = "per_transaction" | "daily" | "monthly";

/**
 * A single configured limit.
 *
 * `asset` is the canonical asset identifier ("native" or "CODE:ISSUER"). A limit
 * configured for one asset never constrains spending of another.
 */
export interface SpendingLimit {
  asset: string;
  amount: string;
  period: SpendingLimitPeriod;
}

/**
 * A destination restriction applied to every evaluated transaction.
 *
 * When `mode` is "allow", only the listed destinations may receive funds. When
 * "deny", the listed destinations are rejected and all others are permitted.
 */
export interface DestinationRestriction {
  mode: "allow" | "deny";
  destinations: readonly string[];
}

/**
 * Threshold above which a transaction requires explicit approval rather than
 * being rejected outright.
 */
export interface ApprovalThreshold {
  asset: string;
  amount: string;
  /** Number of distinct approvers that must approve. Defaults to 1. */
  requiredApprovers?: number;
  /** Approvers permitted to act. When omitted, any approver identity is accepted. */
  approvers?: readonly string[];
}

export interface SpendingPolicyConfig {
  limits?: readonly SpendingLimit[];
  destinationRestriction?: DestinationRestriction;
  approvalThresholds?: readonly ApprovalThreshold[];
}

/** A transaction presented to the engine for evaluation. */
export interface SpendingRequest {
  id: string;
  asset: string;
  amount: string;
  destination?: string;
  /** Epoch milliseconds the request was made. Defaults to `Date.now()`. */
  timestamp?: number;
}

/**
 * Lifecycle of an evaluated request.
 *
 * Only `authorized`, `pending_approval` and `completed` records consume limit
 * capacity — see {@link SpendingPolicyEngine.getSpendingUsage}. `rejected` and
 * `failed` records release the capacity they had reserved.
 */
export type SpendingRecordStatus =
  | "authorized"
  | "pending_approval"
  | "completed"
  | "failed"
  | "rejected";

export interface SpendingRecord {
  id: string;
  asset: string;
  amount: string;
  destination?: string;
  timestamp: number;
  status: SpendingRecordStatus;
  approvals: readonly string[];
  requiredApprovers: number;
}

export type PolicyViolationCode =
  | "PER_TRANSACTION_LIMIT_EXCEEDED"
  | "DAILY_LIMIT_EXCEEDED"
  | "MONTHLY_LIMIT_EXCEEDED"
  | "DESTINATION_NOT_ALLOWED"
  | "DESTINATION_DENIED";

/** Structured description of a single failed policy rule. */
export interface PolicyViolation {
  code: PolicyViolationCode;
  asset: string;
  /** Configured ceiling for the rule that failed. Absent for destination rules. */
  limit?: string;
  /** Spend already consuming the window at evaluation time. */
  used?: string;
  /** Amount the request asked for. */
  requested?: string;
  message: string;
}

export type SpendingDecision = "allowed" | "requires_approval" | "denied";

export interface SpendingEvaluation {
  decision: SpendingDecision;
  requestId: string;
  violations: readonly PolicyViolation[];
  /** Present when `decision` is "requires_approval". */
  requiredApprovers?: number;
}

export interface SpendingUsage {
  asset: string;
  perTransaction: string;
  daily: string;
  monthly: string;
}

// ─── Amount helpers ───
//
// Amounts are decimal strings. They are compared as scaled BigInts so that
// values beyond IEEE-754 safe range keep full precision.

const SCALE = 7;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

function parseAmount(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) return undefined;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > SCALE) return undefined;
  return BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, "0") || "0");
}

function formatAmount(value: bigint): string {
  const whole = value / SCALE_FACTOR;
  const fraction = (value % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// ─── Window helpers ───

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * Records that consume limit capacity.
 *
 * Pending and authorized requests are counted so that concurrent evaluations
 * cannot each independently fit under a shared ceiling.
 */
function consumesCapacity(status: SpendingRecordStatus): boolean {
  return status === "authorized" || status === "pending_approval" || status === "completed";
}

// ─── Engine ───

/**
 * Evaluates transactions against configured spending limits before signing or
 * submission.
 *
 * The engine is an in-memory ledger of decisions this SDK instance has made. It
 * does not observe on-chain activity: spending performed outside the engine is
 * invisible to it, so limits constrain the application, not the account itself.
 */
export class SpendingPolicyEngine {
  private readonly limits = new Map<string, SpendingLimit>();
  private readonly approvalThresholds = new Map<string, ApprovalThreshold>();
  private readonly records = new Map<string, SpendingRecord>();
  private destinationRestriction: DestinationRestriction | undefined;

  constructor(config?: SpendingPolicyConfig) {
    for (const limit of config?.limits ?? []) {
      this.setSpendingLimit(limit.asset, limit.amount, limit.period);
    }
    for (const threshold of config?.approvalThresholds ?? []) {
      this.setApprovalThreshold(threshold);
    }
    if (config?.destinationRestriction) {
      this.destinationRestriction = config.destinationRestriction;
    }
  }

  /**
   * Configure a limit for an asset over a period.
   *
   * Re-configuring the same (asset, period) pair replaces the previous ceiling.
   * Historical records are retained, so lowering a limit can leave the current
   * window already over capacity.
   */
  setSpendingLimit(
    asset: string,
    amount: string,
    period: SpendingLimitPeriod,
  ): SorokitResult<SpendingLimit> {
    if (!asset.trim()) {
      return err(SorokitErrorCode.INVALID_CONFIG, "setSpendingLimit: asset is required.");
    }
    const parsed = parseAmount(amount);
    if (parsed === undefined) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `setSpendingLimit: amount "${amount}" is not a non-negative decimal with at most ${SCALE} places.`,
      );
    }
    const limit: SpendingLimit = { asset, amount: formatAmount(parsed), period };
    this.limits.set(`${asset}:${period}`, limit);
    return ok(limit);
  }

  /** Remove a previously configured limit. Returns true when one was removed. */
  removeSpendingLimit(asset: string, period: SpendingLimitPeriod): boolean {
    return this.limits.delete(`${asset}:${period}`);
  }

  /** List all configured limits. */
  listSpendingLimits(): SpendingLimit[] {
    return [...this.limits.values()];
  }

  /** Restrict which destinations may receive funds. Pass `undefined` to clear. */
  setDestinationRestriction(restriction: DestinationRestriction | undefined): void {
    this.destinationRestriction = restriction;
  }

  /**
   * Configure the amount above which an asset's transactions require approval.
   */
  setApprovalThreshold(threshold: ApprovalThreshold): SorokitResult<ApprovalThreshold> {
    const parsed = parseAmount(threshold.amount);
    if (parsed === undefined) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `setApprovalThreshold: amount "${threshold.amount}" is not a valid decimal amount.`,
      );
    }
    if (threshold.requiredApprovers !== undefined && threshold.requiredApprovers < 1) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "setApprovalThreshold: requiredApprovers must be >= 1.",
      );
    }
    this.approvalThresholds.set(threshold.asset, threshold);
    return ok(threshold);
  }

  /**
   * Spend currently consuming each window for an asset.
   *
   * `perTransaction` reports the largest single capacity-consuming request, not
   * a sum, because that limit applies to each transaction individually.
   */
  getSpendingUsage(asset: string, now: number = Date.now()): SpendingUsage {
    const dayStart = startOfUtcDay(now);
    const monthStart = startOfUtcMonth(now);
    let daily = 0n;
    let monthly = 0n;
    let largest = 0n;

    for (const record of this.records.values()) {
      if (record.asset !== asset || !consumesCapacity(record.status)) continue;
      const amount = parseAmount(record.amount) ?? 0n;
      if (amount > largest) largest = amount;
      if (record.timestamp >= monthStart) monthly += amount;
      if (record.timestamp >= dayStart) daily += amount;
    }

    return {
      asset,
      perTransaction: formatAmount(largest),
      daily: formatAmount(daily),
      monthly: formatAmount(monthly),
    };
  }

  /**
   * Evaluate a transaction against every configured rule.
   *
   * On an "allowed" or "requires_approval" decision the request is recorded and
   * immediately reserves capacity, so a second concurrent evaluation sees the
   * first one's spend. Release it with {@link SpendingPolicyEngine.rejectRequest}
   * or {@link SpendingPolicyEngine.markFailed} if the transaction never reaches
   * the network.
   *
   * @returns `ok(SpendingEvaluation)`, or an error when the request is malformed.
   */
  evaluate(request: SpendingRequest): SorokitResult<SpendingEvaluation> {
    if (!request.id.trim()) {
      return err(SorokitErrorCode.INVALID_CONFIG, "evaluate: request id is required.");
    }
    if (this.records.has(request.id)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `evaluate: request "${request.id}" has already been evaluated.`,
      );
    }
    const amount = parseAmount(request.amount);
    if (amount === undefined) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `evaluate: amount "${request.amount}" is not a valid decimal amount.`,
      );
    }

    const timestamp = request.timestamp ?? Date.now();
    const violations: PolicyViolation[] = [];

    const destinationViolation = this.checkDestination(request);
    if (destinationViolation) violations.push(destinationViolation);

    violations.push(...this.checkLimits(request.asset, amount, timestamp));

    if (violations.length > 0) {
      this.records.set(request.id, {
        id: request.id,
        asset: request.asset,
        amount: formatAmount(amount),
        ...(request.destination !== undefined ? { destination: request.destination } : {}),
        timestamp,
        status: "rejected",
        approvals: [],
        requiredApprovers: 0,
      });
      return ok({ decision: "denied", requestId: request.id, violations });
    }

    const requiredApprovers = this.requiredApproversFor(request.asset, amount);
    const status: SpendingRecordStatus = requiredApprovers > 0 ? "pending_approval" : "authorized";

    this.records.set(request.id, {
      id: request.id,
      asset: request.asset,
      amount: formatAmount(amount),
      ...(request.destination !== undefined ? { destination: request.destination } : {}),
      timestamp,
      status,
      approvals: [],
      requiredApprovers,
    });

    return ok({
      decision: requiredApprovers > 0 ? "requires_approval" : "allowed",
      requestId: request.id,
      violations: [],
      ...(requiredApprovers > 0 ? { requiredApprovers } : {}),
    });
  }

  private checkDestination(request: SpendingRequest): PolicyViolation | undefined {
    const restriction = this.destinationRestriction;
    if (!restriction || request.destination === undefined) return undefined;
    const listed = restriction.destinations.includes(request.destination);

    if (restriction.mode === "allow" && !listed) {
      return {
        code: "DESTINATION_NOT_ALLOWED",
        asset: request.asset,
        message: `Destination ${request.destination} is not in the allow list.`,
      };
    }
    if (restriction.mode === "deny" && listed) {
      return {
        code: "DESTINATION_DENIED",
        asset: request.asset,
        message: `Destination ${request.destination} is explicitly denied.`,
      };
    }
    return undefined;
  }

  private checkLimits(asset: string, amount: bigint, timestamp: number): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const usage = this.getSpendingUsage(asset, timestamp);

    const perTransaction = this.limits.get(`${asset}:per_transaction`);
    if (perTransaction) {
      const ceiling = parseAmount(perTransaction.amount) ?? 0n;
      if (amount > ceiling) {
        violations.push({
          code: "PER_TRANSACTION_LIMIT_EXCEEDED",
          asset,
          limit: perTransaction.amount,
          used: "0",
          requested: formatAmount(amount),
          message: `Transaction amount ${formatAmount(amount)} exceeds the per-transaction limit of ${perTransaction.amount}.`,
        });
      }
    }

    const daily = this.limits.get(`${asset}:daily`);
    if (daily) {
      const ceiling = parseAmount(daily.amount) ?? 0n;
      const used = parseAmount(usage.daily) ?? 0n;
      if (used + amount > ceiling) {
        violations.push({
          code: "DAILY_LIMIT_EXCEEDED",
          asset,
          limit: daily.amount,
          used: usage.daily,
          requested: formatAmount(amount),
          message: `Daily limit of ${daily.amount} exceeded — ${usage.daily} already authorized, ${formatAmount(amount)} requested.`,
        });
      }
    }

    const monthly = this.limits.get(`${asset}:monthly`);
    if (monthly) {
      const ceiling = parseAmount(monthly.amount) ?? 0n;
      const used = parseAmount(usage.monthly) ?? 0n;
      if (used + amount > ceiling) {
        violations.push({
          code: "MONTHLY_LIMIT_EXCEEDED",
          asset,
          limit: monthly.amount,
          used: usage.monthly,
          requested: formatAmount(amount),
          message: `Monthly limit of ${monthly.amount} exceeded — ${usage.monthly} already authorized, ${formatAmount(amount)} requested.`,
        });
      }
    }

    return violations;
  }

  private requiredApproversFor(asset: string, amount: bigint): number {
    const threshold = this.approvalThresholds.get(asset);
    if (!threshold) return 0;
    const ceiling = parseAmount(threshold.amount) ?? 0n;
    if (amount <= ceiling) return 0;
    return threshold.requiredApprovers ?? 1;
  }

  /**
   * Record an approval from `approver`.
   *
   * Duplicate approvals from the same identity are rejected so that one approver
   * cannot satisfy a multi-approver requirement alone. The record becomes
   * "authorized" once the required count is reached.
   */
  approveRequest(requestId: string, approver: string): SorokitResult<SpendingRecord> {
    const record = this.records.get(requestId);
    if (!record) {
      return err(SorokitErrorCode.INVALID_CONFIG, `approveRequest: unknown request "${requestId}".`);
    }
    if (record.status !== "pending_approval") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `approveRequest: request "${requestId}" is ${record.status}, not pending approval.`,
      );
    }
    if (record.approvals.includes(approver)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `approveRequest: ${approver} has already approved request "${requestId}".`,
      );
    }

    const permitted = this.approvalThresholds.get(record.asset)?.approvers;
    if (permitted && !permitted.includes(approver)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `approveRequest: ${approver} is not an authorized approver for ${record.asset}.`,
      );
    }

    const approvals = [...record.approvals, approver];
    const updated: SpendingRecord = {
      ...record,
      approvals,
      status: approvals.length >= record.requiredApprovers ? "authorized" : "pending_approval",
    };
    this.records.set(requestId, updated);
    return ok(updated);
  }

  /** Reject a request, releasing the capacity it reserved. */
  rejectRequest(requestId: string): SorokitResult<SpendingRecord> {
    const record = this.records.get(requestId);
    if (!record) {
      return err(SorokitErrorCode.INVALID_CONFIG, `rejectRequest: unknown request "${requestId}".`);
    }
    const updated: SpendingRecord = { ...record, status: "rejected" };
    this.records.set(requestId, updated);
    return ok(updated);
  }

  /** Mark an authorized request as submitted and confirmed. Capacity stays consumed. */
  markCompleted(requestId: string): SorokitResult<SpendingRecord> {
    const record = this.records.get(requestId);
    if (!record) {
      return err(SorokitErrorCode.INVALID_CONFIG, `markCompleted: unknown request "${requestId}".`);
    }
    if (record.status !== "authorized") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `markCompleted: request "${requestId}" is ${record.status} — only authorized requests can complete.`,
      );
    }
    const updated: SpendingRecord = { ...record, status: "completed" };
    this.records.set(requestId, updated);
    return ok(updated);
  }

  /** Mark a request as failed, releasing the capacity it reserved. */
  markFailed(requestId: string): SorokitResult<SpendingRecord> {
    const record = this.records.get(requestId);
    if (!record) {
      return err(SorokitErrorCode.INVALID_CONFIG, `markFailed: unknown request "${requestId}".`);
    }
    const updated: SpendingRecord = { ...record, status: "failed" };
    this.records.set(requestId, updated);
    return ok(updated);
  }

  /** Look up a single evaluated request. */
  getRequest(requestId: string): SpendingRecord | undefined {
    return this.records.get(requestId);
  }

  /** List evaluated requests, optionally filtered by status. */
  listRequests(status?: SpendingRecordStatus): SpendingRecord[] {
    const all = [...this.records.values()];
    return status ? all.filter((record) => record.status === status) : all;
  }

  /** Discard all recorded requests. Configured limits are retained. */
  reset(): void {
    this.records.clear();
  }
}

/** Construct a {@link SpendingPolicyEngine}. */
export function createSpendingPolicyEngine(config?: SpendingPolicyConfig): SpendingPolicyEngine {
  return new SpendingPolicyEngine(config);
}
