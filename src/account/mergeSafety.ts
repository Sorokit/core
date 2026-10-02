/**
 * mergeSafety.ts — account merge simulation and pre-flight safety checks.
 *
 * Account merge is destructive and irreversible: it transfers all XLM from the
 * source account to a destination and closes the source account permanently.
 * This module lets callers simulate the merge, validate every precondition, and
 * inspect the projected outcome before building or signing any transaction.
 *
 * Scope: simulation and validation only. Merge execution is a separate concern.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidPublicKey } from "../shared/utils";
import { getAccount } from "./getAccount";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Stellar base reserve per ledger entry in XLM (stroops / 10,000,000).
 * Each account requires 2 base reserves (1 XLM at the current reserve setting),
 * and each additional subentry (trustline, offer, signer, data entry) costs
 * 1 base reserve (0.5 XLM).
 *
 * Reference: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts#minimum-balance
 */
const BASE_RESERVE_XLM = 0.5;

/**
 * Minimum number of base reserves required to keep an account alive.
 * Two base reserves = 1 XLM.
 */
const BASE_ACCOUNT_RESERVES = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A non-native trustline on the source account that would block an account
 * merge unless removed first.
 */
export interface MergeTrustlineInfo {
  /** Asset code (e.g. "USDC"). */
  assetCode: string;
  /** Asset issuer G-address, or null for the native asset. */
  assetIssuer: string | null;
  /** Current balance string as returned by Horizon. */
  balance: string;
}

/**
 * The detailed report returned by `simulateAccountMerge` on success.
 * All checks passed — the merge is safe to proceed.
 */
export interface AccountMergeSimulation {
  /** Source account G-address being merged (closed). */
  sourceAccount: string;
  /** Destination account G-address that will receive the XLM. */
  destinationAccount: string;
  /**
   * XLM balance that will be transferred to the destination, expressed as a
   * decimal string (e.g. "9.9999900"). This is the source's current XLM
   * balance minus the transaction fee reserve. The exact fee depends on the
   * base fee at submission time; this value is indicative only.
   */
  xlmToTransfer: string;
  /** Current XLM balance of the source account (decimal string). */
  sourceXlmBalance: string;
  /** Whether the source account has any non-native trustlines. */
  hasTrustlines: boolean;
  /**
   * Non-native trustlines currently on the source account.
   * An empty array means no trustlines are present. When non-empty, the merge
   * will be blocked by Horizon unless all non-native balances are zero and all
   * trustlines are removed first — the simulation still passes because the
   * caller opted in via `allowTrustlines: true`.
   */
  trustlines: MergeTrustlineInfo[];
  /**
   * Current number of subentries on the source account (trustlines, offers,
   * signers, data entries).
   */
  sourceSubentryCount: number;
  /**
   * Minimum XLM balance required to keep the source account open, calculated
   * as `(2 + subentryCount) × 0.5 XLM`. The account must hold at least this
   * amount; an account with a balance below this threshold cannot be created
   * and therefore cannot be merged either.
   */
  minimumRequiredBalance: string;
  /** Whether the destination account already exists on-ledger. */
  destinationExists: boolean;
  /**
   * `true` when every safety check passed. This is always `true` for the ok
   * result — the field exists so callers can destructure the simulation and
   * log it without re-checking `status`.
   */
  isSafe: boolean;
  /** Human-readable summary of what the merge will do. */
  summary: string;
}

/**
 * Options for `simulateAccountMerge`.
 */
export interface SimulateAccountMergeOptions {
  /**
   * When `true`, the simulation succeeds even if the source account has
   * non-native trustlines. The caller is responsible for removing those
   * trustlines before executing the merge.
   *
   * When `false` (the default) or omitted, the simulation returns an error
   * result when non-native trustlines exist, because Horizon will reject a
   * merge transaction from an account that still holds non-native balances.
   */
  allowTrustlines?: boolean;
  /** AbortSignal to cancel in-flight Horizon requests. */
  signal?: AbortSignal;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Simulate an account merge and run all safety checks before any transaction
 * is built or signed.
 *
 * Checks performed:
 * 1. Both `sourcePublicKey` and `destinationPublicKey` are valid G-addresses.
 * 2. Source and destination are not the same account.
 * 3. Source account exists and can be fetched from Horizon.
 * 4. Destination account exists on-ledger (Horizon returns it).
 * 5. Source account meets the minimum balance requirement.
 * 6. Source account has no non-native trustlines, unless `allowTrustlines` is set.
 *
 * @param horizonUrl        - Horizon base URL (e.g. "https://horizon-testnet.stellar.org").
 * @param sourcePublicKey   - G-address of the account to be merged (closed).
 * @param destPublicKey     - G-address of the account that will receive the XLM.
 * @param options           - Optional `allowTrustlines` flag and abort signal.
 * @returns                 - `ok(AccountMergeSimulation)` when all checks pass,
 *                            or an `error` result with a descriptive message.
 *
 * @example
 * ```ts
 * const sim = await simulateAccountMerge(
 *   "https://horizon-testnet.stellar.org",
 *   sourceKey,
 *   destinationKey,
 * );
 * if (sim.status === "ok") {
 *   console.log("Safe to merge:", sim.data.xlmToTransfer, "XLM will transfer");
 * } else {
 *   console.error("Merge blocked:", sim.error.message);
 * }
 * ```
 */
export async function simulateAccountMerge(
  horizonUrl: string,
  sourcePublicKey: string,
  destPublicKey: string,
  options: SimulateAccountMergeOptions = {},
): Promise<SorokitResult<AccountMergeSimulation>> {
  const { allowTrustlines = false, signal } = options;

  // ── 1. Validate address formats ───────────────────────────────────────────
  if (!isValidPublicKey(sourcePublicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid source public key: "${sourcePublicKey}". Expected a 56-character G-address.`,
    );
  }

  if (!isValidPublicKey(destPublicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid destination public key: "${destPublicKey}". Expected a 56-character G-address.`,
    );
  }

  // ── 2. Source and destination must differ ─────────────────────────────────
  if (sourcePublicKey === destPublicKey) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Source and destination accounts must be different. An account cannot be merged into itself.",
    );
  }

  // ── 3. Fetch source account ───────────────────────────────────────────────
  const sourceResult = await getAccount(horizonUrl, sourcePublicKey, {
    signal,
  });
  if (sourceResult.status === "error") {
    if (sourceResult.error.code === SorokitErrorCode.ACCOUNT_NOT_FOUND) {
      return err(
        SorokitErrorCode.ACCOUNT_NOT_FOUND,
        `Source account not found: ${sourcePublicKey}. The account must exist on-ledger before it can be merged.`,
        sourceResult.error.cause,
      );
    }
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `Failed to fetch source account (${sourcePublicKey}): ${sourceResult.error.message}`,
      sourceResult.error.cause,
    );
  }
  const source = sourceResult.data;

  // ── 4. Fetch destination account (must exist to receive funds) ────────────
  const destResult = await getAccount(horizonUrl, destPublicKey, { signal });
  if (destResult.status === "error") {
    if (destResult.error.code === SorokitErrorCode.ACCOUNT_NOT_FOUND) {
      return err(
        SorokitErrorCode.ACCOUNT_NOT_FOUND,
        `Destination account not found: ${destPublicKey}. The destination must already exist on-ledger to receive a merge.`,
        destResult.error.cause,
      );
    }
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `Failed to fetch destination account (${destPublicKey}): ${destResult.error.message}`,
      destResult.error.cause,
    );
  }

  // ── 5. Minimum balance check ──────────────────────────────────────────────
  const xlmBalance = source.balances.find((b) => b.assetType === "native");
  const xlmBalanceStr = xlmBalance?.balance ?? "0";
  const xlmBalanceFloat = parseFloat(xlmBalanceStr);

  const minimumRequired =
    (BASE_ACCOUNT_RESERVES + source.subentryCount) * BASE_RESERVE_XLM;
  const minimumRequiredStr = minimumRequired.toFixed(7);

  if (xlmBalanceFloat < minimumRequired) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Source account balance (${xlmBalanceStr} XLM) is below the minimum required balance ` +
        `(${minimumRequiredStr} XLM for ${source.subentryCount} subentries). ` +
        `The account cannot be merged in this state.`,
    );
  }

  // ── 6. Trustline check ────────────────────────────────────────────────────
  const nonNativeTrustlines: MergeTrustlineInfo[] = source.balances
    .filter(
      (b) =>
        b.assetType === "credit_alphanum4" ||
        b.assetType === "credit_alphanum12",
    )
    .map((b) => ({
      assetCode: b.assetCode,
      assetIssuer: b.assetIssuer,
      balance: b.balance,
    }));

  const hasTrustlines = nonNativeTrustlines.length > 0;

  if (hasTrustlines && !allowTrustlines) {
    const trustlineList = nonNativeTrustlines
      .map((t) => `${t.assetCode}/${t.assetIssuer ?? "native"} (balance: ${t.balance})`)
      .join(", ");
    return err(
      SorokitErrorCode.VALIDATION,
      `Source account has ${nonNativeTrustlines.length} non-native trustline(s) that must be ` +
        `removed before merging: ${trustlineList}. ` +
        `All non-native balances must be zero and trustlines removed before account_merge will succeed. ` +
        `Pass allowTrustlines: true to simulate anyway.`,
    );
  }

  // ── All checks passed — build the simulation report ───────────────────────
  // The transfer amount is the full XLM balance; the network will deduct the
  // transaction fee at submission time. We report the gross balance here.
  const trustlineNote =
    hasTrustlines && allowTrustlines
      ? ` Note: ${nonNativeTrustlines.length} trustline(s) must be removed before executing the merge.`
      : "";

  const summary =
    `Merge of ${sourcePublicKey} into ${destPublicKey} is safe to proceed. ` +
    `${xlmBalanceStr} XLM will transfer (minus network fee at submission).${trustlineNote}`;

  const simulation: AccountMergeSimulation = {
    sourceAccount: sourcePublicKey,
    destinationAccount: destPublicKey,
    xlmToTransfer: xlmBalanceStr,
    sourceXlmBalance: xlmBalanceStr,
    hasTrustlines,
    trustlines: nonNativeTrustlines,
    sourceSubentryCount: source.subentryCount,
    minimumRequiredBalance: minimumRequiredStr,
    destinationExists: true,
    isSafe: true,
    summary,
  };

  return ok(simulation);
}

/**
 * Validate an account merge using the same pre-flight checks as the
 * simulation. This named alias is useful when callers only need a
 * safety decision and do not need to build a merge transaction.
 */
export const validateMerge = simulateAccountMerge;

export interface AccountMergeDataLoss {
  sourceAccount: string;
  nonNativeTrustlines: MergeTrustlineInfo[];
  subentryCount: number;
  warning: string;
}

/**
 * Report account state that must be cleared before an account merge.
 * This is intentionally read-only and never submits a transaction.
 */
export async function getDataLoss(
  horizonUrl: string,
  sourcePublicKey: string,
  options: { signal?: AbortSignal } = {},
): Promise<SorokitResult<AccountMergeDataLoss>> {
  if (!isValidPublicKey(sourcePublicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid source public key: " + sourcePublicKey + ". Expected a 56-character G-address.",
    );
  }

  const result = await getAccount(horizonUrl, sourcePublicKey, options);
  if (result.status === "error") {
    return err(result.error.code, result.error.message, result.error.cause);
  }

  const nonNativeTrustlines = result.data.balances
    .filter(
      (balance) =>
        balance.assetType === "credit_alphanum4" ||
        balance.assetType === "credit_alphanum12",
    )
    .map((balance) => ({
      assetCode: balance.assetCode,
      assetIssuer: balance.assetIssuer,
      balance: balance.balance,
    }));

  return ok({
    sourceAccount: sourcePublicKey,
    nonNativeTrustlines,
    subentryCount: result.data.subentryCount,
    warning:
      nonNativeTrustlines.length > 0
        ? "Remove all non-native trustlines and settle their balances before merging."
        : "No non-native trustlines were found; review subentries before merging.",
  });
}