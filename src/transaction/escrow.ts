import { Asset, BASE_FEE, Horizon, Keypair, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ResolvedNetworkConfig } from "../shared/types";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type EscrowAction = "release" | "refund" | "dispute";
export type EscrowState = "pending" | "released" | "refunded" | "disputed" | "expired";

export interface EscrowTiming {
  releaseAfter: number;
  refundAfter?: number;
  minReleaseTime?: number;
  maxReleaseTime?: number;
}

export interface EscrowParams extends EscrowTiming {
  buyer: string;
  seller: string;
  assetCode?: string;
  assetIssuer?: string;
  amount: string;
  action?: EscrowAction;
  state?: EscrowState;
  fee?: string;
  sequenceNumber?: string;
}

export interface EscrowValidation {
  valid: boolean;
  action: EscrowAction;
  timelock: { releaseAfter: number; refundAfter?: number };
}

const DEFAULT_MIN_RELEASE_SECONDS = 60;
const DEFAULT_MAX_RELEASE_SECONDS = 30 * 24 * 60 * 60;

function invalid(message: string): SorokitResult<never> {
  return err(SorokitErrorCode.TX_BUILD_FAILED, message);
}

function validateAddress(value: string, name: string): string | null {
  if (!value || !StrKey.isValidEd25519PublicKey(value)) return `${name} must be a valid Stellar public key.`;
  return null;
}

export function validateEscrow(
  params: EscrowParams,
  nowSeconds = Math.floor(Date.now() / 1000),
): SorokitResult<EscrowValidation> {
  for (const [value, name] of [[params.buyer, "buyer"], [params.seller, "seller"]] as const) {
    const addressError = validateAddress(value, name);
    if (addressError) return invalid(addressError);
  }
  if (params.buyer === params.seller) return invalid("buyer and seller must be different accounts.");
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return invalid("Escrow amount must be positive.");
  if (!Number.isInteger(params.releaseAfter) || params.releaseAfter <= nowSeconds)
    return invalid("releaseAfter must be a future Unix timestamp.");
  const minRelease = params.minReleaseTime ?? nowSeconds + DEFAULT_MIN_RELEASE_SECONDS;
  const maxRelease = params.maxReleaseTime ?? nowSeconds + DEFAULT_MAX_RELEASE_SECONDS;
  if (params.releaseAfter < minRelease || params.releaseAfter > maxRelease)
    return invalid("releaseAfter is outside the configured timelock window.");
  if (params.refundAfter !== undefined) {
    if (!Number.isInteger(params.refundAfter) || params.refundAfter <= params.releaseAfter)
      return invalid("refundAfter must be later than releaseAfter.");
  }
  const action = params.action ?? "release";
  const state = params.state ?? "pending";
  if (state !== "pending") return invalid(`Cannot ${action} escrow from ${state} state.`);
  return ok({ valid: true, action, timelock: { releaseAfter: params.releaseAfter, ...(params.refundAfter !== undefined ? { refundAfter: params.refundAfter } : {}) } });
}

export function validateEscrowAction(
  state: EscrowState,
  action: EscrowAction,
  nowSeconds = Math.floor(Date.now() / 1000),
  releaseAfter?: number,
  refundAfter?: number,
): SorokitResult<void> {
  if (state !== "pending") return invalid(`Cannot ${action} escrow from ${state} state.`);
  if (action === "release" && releaseAfter !== undefined && nowSeconds < releaseAfter)
    return invalid("Escrow release timelock has not elapsed.");
  if (action === "refund" && refundAfter !== undefined && nowSeconds < refundAfter)
    return invalid("Escrow refund timelock has not elapsed.");
  return ok(undefined);
}

export async function buildEscrowTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: EscrowParams,
): Promise<SorokitResult<string>> {
  const validation = validateEscrow(params);
  if (validation.status === "error") return validation;
  const action = validation.data.action;
  const transition = validateEscrowAction(params.state ?? "pending", action, Math.floor(Date.now() / 1000), params.releaseAfter, params.refundAfter);
  if (transition.status === "error") return transition;
  if (action === "dispute") return invalid("Dispute actions require an escrow contract or multisignature workflow and cannot be a direct payment.");
  const destination = action === "release" ? params.seller : params.buyer;
  const minTime = action === "release" ? params.releaseAfter : params.refundAfter;
  if (minTime === undefined) return invalid(`refundAfter is required for ${action}.`);
  try {
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(params.buyer);
    const asset = !params.assetCode || params.assetCode.toUpperCase() === "XLM"
      ? Asset.native()
      : params.assetIssuer && StrKey.isValidEd25519PublicKey(params.assetIssuer)
        ? new Asset(params.assetCode, params.assetIssuer)
        : null;
    if (!asset) return invalid("assetIssuer must be a valid Stellar public key for non-native assets.");
    const builder = new TransactionBuilder(sourceAccount, {
      fee: params.fee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    }).addOperation(Operation.payment({ destination, asset, amount: params.amount }));
    builder.setTimebounds(minTime, 0);
    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, cause instanceof Error ? cause.message : String(cause), cause);
  }
}

export function createEscrowRelease(params: Omit<EscrowParams, "action">): EscrowParams {
  return { ...params, action: "release" };
}
export function createEscrowRefund(params: Omit<EscrowParams, "action">): EscrowParams {
  return { ...params, action: "refund" };
}
export function createEscrowDispute(params: Omit<EscrowParams, "action">): EscrowParams {
  return { ...params, action: "dispute" };
}

export function isEscrowExpired(timing: EscrowTiming, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return timing.refundAfter !== undefined && nowSeconds >= timing.refundAfter;
}

export function isValidEscrowSecret(secret: string): boolean {
  try { return Keypair.fromSecret(secret).canSign(); } catch { return false; }
}
