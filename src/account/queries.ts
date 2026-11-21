import { Horizon, StrKey } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import { getOfferById } from "./dexActivity";
import type { OfferInfo } from "./dexActivity";
import { getEffects } from "./getEffects";
import type { EffectInfo, GetEffectsOptions } from "./getEffects";
import { resolveAccountQueryHorizonUrl } from "./paymentHistory";
import { getSigners, getThresholds } from "./signers";

export { getPaymentHistory } from "./paymentHistory";
export type {
  Payment,
  PaymentDirection,
  PaymentFilters,
} from "./paymentHistory";

export type Effect = EffectInfo;

export interface EffectFilters {
  type?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
  after?: string | undefined;
  before?: string | undefined;
  horizonUrl?: string | undefined;
}

export interface SignerEntry {
  key: string;
  type: string;
  weight: number;
}

export interface SignerData {
  masterWeight: number;
  signers: SignerEntry[];
}

export interface SignerThresholds {
  low: number;
  med: number;
  high: number;
}

function toEffectOptions(filters: EffectFilters): GetEffectsOptions {
  return {
    ...(filters.type !== undefined ? { type: filters.type } : {}),
    ...(filters.cursor !== undefined ? { cursor: filters.cursor } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.order !== undefined ? { order: filters.order } : {}),
    ...(filters.after !== undefined ? { after: filters.after } : {}),
    ...(filters.before !== undefined ? { before: filters.before } : {}),
  };
}

function splitArgs<F extends { horizonUrl?: string | undefined }>(
  first: string,
  second?: string | F,
  third?: F,
): { publicKey: string; filters: F; horizonUrl: string } {
  if (typeof second === "string") {
    return {
      publicKey: second,
      filters: (third ?? {}) as F,
      horizonUrl: resolveAccountQueryHorizonUrl(first),
    };
  }

  const filters = (second ?? {}) as F;
  return {
    publicKey: first,
    filters,
    horizonUrl: resolveAccountQueryHorizonUrl(filters.horizonUrl),
  };
}

function splitSingle(
  first: string,
  second?: string,
): { publicKey: string; horizonUrl: string } {
  return typeof second === "string"
    ? {
        publicKey: second,
        horizonUrl: resolveAccountQueryHorizonUrl(first),
      }
    : {
        publicKey: first,
        horizonUrl: resolveAccountQueryHorizonUrl(),
      };
}

export function getAccountEffects(
  publicKey: string,
  filters?: EffectFilters,
): Promise<SorokitResult<Effect[]>>;
export function getAccountEffects(
  horizonUrl: string,
  publicKey: string,
  filters?: EffectFilters,
): Promise<SorokitResult<Effect[]>>;
export async function getAccountEffects(
  first: string,
  second?: string | EffectFilters,
  third?: EffectFilters,
): Promise<SorokitResult<Effect[]>> {
  const { publicKey, filters, horizonUrl } = splitArgs(first, second, third);
  const result = await getEffects(horizonUrl, publicKey, toEffectOptions(filters));
  if (result.status === "error") return result;
  return ok(result.data.effects);
}

export function getAccountSigners(
  publicKey: string,
): Promise<SorokitResult<SignerData>>;
export function getAccountSigners(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<SignerData>>;
export async function getAccountSigners(
  first: string,
  second?: string,
): Promise<SorokitResult<SignerData>> {
  const { publicKey, horizonUrl } = splitSingle(first, second);
  const result = await getSigners(horizonUrl, publicKey);
  if (result.status === "error") return result;

  const signers: SignerEntry[] = [];
  let masterSeen = false;
  for (const signer of result.data.signers) {
    if (signer.type === "master" || signer.key === publicKey) {
      if (masterSeen) continue;
      masterSeen = true;
      signers.push({
        key: publicKey,
        type: "master",
        weight: result.data.masterWeight,
      });
      continue;
    }
    signers.push({
      key: signer.key,
      type: signer.type,
      weight: signer.weight,
    });
  }
  if (!masterSeen) {
    signers.unshift({
      key: publicKey,
      type: "master",
      weight: result.data.masterWeight,
    });
  }

  return ok({ masterWeight: result.data.masterWeight, signers });
}

/** A single offer, as returned by Horizon. */
export type Offer = OfferInfo;

/**
 * Fetch one offer by its Horizon offer id (#946).
 *
 * Uses `SOROKIT_HORIZON_URL` (or the default Horizon) unless a Horizon URL is passed first.
 * Resolves with the offer's seller, selling and buying assets, `price` and `amount`, or an error
 * result: `OFFER_NOT_FOUND` for an unknown, filled or cancelled offer, `VALIDATION` for a
 * malformed id, `ACCOUNT_FETCH_FAILED` otherwise. Never throws.
 */
export function getOffer(offerId: string | number): Promise<SorokitResult<Offer>>;
export function getOffer(
  horizonUrl: string,
  offerId: string | number,
): Promise<SorokitResult<Offer>>;
export async function getOffer(
  first: string | number,
  second?: string | number,
): Promise<SorokitResult<Offer>> {
  return second === undefined
    ? getOfferById(resolveAccountQueryHorizonUrl(), first)
    : getOfferById(resolveAccountQueryHorizonUrl(String(first)), second);
}

/** Alias of {@link getOffer}. */
export const getAccountOffer = getOffer;

export function getSignerThresholds(
  publicKey: string,
): Promise<SorokitResult<SignerThresholds>>;
export function getSignerThresholds(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<SignerThresholds>>;
export async function getSignerThresholds(
  first: string,
  second?: string,
): Promise<SorokitResult<SignerThresholds>> {
  const { publicKey, horizonUrl } = splitSingle(first, second);
  const result = await getThresholds(horizonUrl, publicKey);
  if (result.status === "error") return result;
  return ok({
    low: result.data.low,
    med: result.data.medium,
    high: result.data.high,
  });
}

// ─── Trustline balances (#980) ───────────────────────────────────────────────

/**
 * One balance line of an account: native XLM, an issued asset (trustline) or
 * liquidity-pool shares. All amounts are 7-decimal strings, exactly as Horizon
 * reports them, so no precision is lost.
 */
export interface Balance {
  assetType: "native" | "credit_alphanum4" | "credit_alphanum12" | "liquidity_pool_shares";
  /** `"XLM"` for native; the pool ID for liquidity-pool shares. */
  assetCode: string;
  /** Issuer G… address; `null` for native and pool shares. */
  assetIssuer: string | null;
  /** Set for `liquidity_pool_shares` only. */
  liquidityPoolId?: string;
  isNative: boolean;
  /** Total balance held. */
  balance: string;
  /** Trustline limit; `null` for native XLM, which has no trustline. */
  limit: string | null;
  /**
   * Amount that can be spent right now:
   * `balance − sellingLiabilities`, and for XLM also minus the account's
   * minimum reserve. Never negative.
   */
  available: string;
  /**
   * Amount that can still be received before hitting the limit:
   * `limit − balance − buyingLiabilities`. `null` for native XLM.
   */
  availableToReceive: string | null;
  /** Amount locked by open sell offers. */
  sellingLiabilities: string;
  /** Amount reserved for open buy offers. */
  buyingLiabilities: string;
  /** Issuer authorization for trustlines; `null` for native and pool shares. */
  isAuthorized: boolean | null;
}

/** Filters for {@link getTrustlineBalances}. All are optional. */
export interface TrustlineBalanceFilters {
  /** Only this asset code (case-insensitive; `"XLM"` selects native). */
  assetCode?: string | undefined;
  /** Only assets from this issuer. */
  assetIssuer?: string | undefined;
  /** Only these asset types. */
  assetType?: Balance["assetType"] | Balance["assetType"][] | undefined;
  /** Include the native XLM balance. Default `true`. */
  includeNative?: boolean | undefined;
  /** Drop balances that are exactly zero. Default `false`. */
  excludeZero?: boolean | undefined;
  /**
   * Network base reserve in XLM used for the native `available` amount.
   * Default `"0.5"` (the current value on public network and testnet).
   */
  baseReserve?: string | undefined;
  /** Horizon URL; defaults to `SOROKIT_HORIZON_URL` or the SDK default. */
  horizonUrl?: string | undefined;
}

const STROOPS = 10_000_000n;

function toStroops(amount: unknown): bigint {
  const text = String(amount ?? "0").trim();
  if (!/^\d+(\.\d{1,7})?$/.test(text)) return 0n;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole as string) * STROOPS + BigInt(frac.padEnd(7, "0"));
}

function fromStroops(stroops: bigint): string {
  const v = stroops < 0n ? 0n : stroops;
  return `${v / STROOPS}.${(v % STROOPS).toString().padStart(7, "0")}`;
}

function toBalance(raw: any, nativeReserveStroops: bigint): Balance {
  const balance = toStroops(raw.balance);
  const selling = toStroops(raw.selling_liabilities);
  const buying = toStroops(raw.buying_liabilities);
  const common = {
    balance: fromStroops(balance),
    sellingLiabilities: fromStroops(selling),
    buyingLiabilities: fromStroops(buying),
  };

  if (raw.asset_type === "native") {
    return {
      assetType: "native",
      assetCode: "XLM",
      assetIssuer: null,
      isNative: true,
      ...common,
      limit: null,
      available: fromStroops(balance - selling - nativeReserveStroops),
      availableToReceive: null,
      isAuthorized: null,
    };
  }

  const limit = toStroops(raw.limit);
  const isPool = raw.asset_type === "liquidity_pool_shares";
  return {
    assetType: raw.asset_type,
    assetCode: isPool ? String(raw.liquidity_pool_id ?? "LP") : String(raw.asset_code),
    assetIssuer: isPool ? null : String(raw.asset_issuer),
    ...(isPool && raw.liquidity_pool_id ? { liquidityPoolId: String(raw.liquidity_pool_id) } : {}),
    isNative: false,
    ...common,
    limit: fromStroops(limit),
    available: fromStroops(balance - selling),
    availableToReceive: fromStroops(limit - balance - buying),
    isAuthorized: isPool ? null : raw.is_authorized !== false,
  };
}

/**
 * Fetch every balance of an account — native XLM plus each trustline and
 * liquidity-pool share — with its limit and spendable/receivable amounts.
 *
 * Uses `SOROKIT_HORIZON_URL` (or the default Horizon) unless a Horizon URL is
 * passed first or as `filters.horizonUrl`. Never throws.
 *
 * @returns `ok(Balance[])` (native first, then Horizon order), or an error:
 *   `INVALID_ADDRESS` for a malformed key, `ACCOUNT_NOT_FOUND` for an
 *   unfunded account, `ACCOUNT_FETCH_FAILED` otherwise.
 *
 * @example
 * const result = await getTrustlineBalances(publicKey, { excludeZero: true });
 * if (result.status === "ok") {
 *   for (const b of result.data) console.log(b.assetCode, b.balance, "/", b.limit ?? "∞", "spendable", b.available);
 * }
 */
export function getTrustlineBalances(
  publicKey: string,
  filters?: TrustlineBalanceFilters,
): Promise<SorokitResult<Balance[]>>;
export function getTrustlineBalances(
  horizonUrl: string,
  publicKey: string,
  filters?: TrustlineBalanceFilters,
): Promise<SorokitResult<Balance[]>>;
export async function getTrustlineBalances(
  first: string,
  second?: string | TrustlineBalanceFilters,
  third?: TrustlineBalanceFilters,
): Promise<SorokitResult<Balance[]>> {
  const { publicKey, filters, horizonUrl } = splitArgs<TrustlineBalanceFilters>(first, second, third);

  if (typeof publicKey !== "string" || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${String(publicKey)}`);
  }
  if (filters.assetIssuer && !StrKey.isValidEd25519PublicKey(filters.assetIssuer)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid asset issuer address: ${filters.assetIssuer}`);
  }
  const baseReserve = filters.baseReserve ?? "0.5";
  if (!/^\d+(\.\d{1,7})?$/.test(baseReserve)) {
    return err(SorokitErrorCode.VALIDATION, `baseReserve must be a decimal XLM amount, got "${baseReserve}"`);
  }

  let account: any;
  try {
    account = await new Horizon.Server(horizonUrl).loadAccount(publicKey);
  } catch (cause) {
    const notFound = isNotFoundError(cause);
    return err(
      notFound ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      notFound ? `Account not found: ${publicKey}` : `Failed to fetch balances for ${publicKey}: ${toMessage(cause)}`,
      cause,
    );
  }

  // Minimum balance = (2 + subentries + sponsoring − sponsored) × base reserve.
  const reserveUnits =
    2n +
    BigInt(Number(account.subentry_count ?? 0)) +
    BigInt(Number(account.num_sponsoring ?? 0)) -
    BigInt(Number(account.num_sponsored ?? 0));
  const nativeReserve = (reserveUnits < 0n ? 0n : reserveUnits) * toStroops(baseReserve);

  let balances: Balance[] = (account.balances ?? []).map((raw: any) => toBalance(raw, nativeReserve));
  balances.sort((a, b) => Number(b.isNative) - Number(a.isNative));

  const { assetCode, assetIssuer, assetType, includeNative = true, excludeZero = false } = filters;
  if (!includeNative) balances = balances.filter((b) => !b.isNative);
  if (assetCode !== undefined) {
    const code = assetCode.toUpperCase();
    balances = balances.filter((b) => b.assetCode.toUpperCase() === code);
  }
  if (assetIssuer !== undefined) balances = balances.filter((b) => b.assetIssuer === assetIssuer);
  if (assetType !== undefined) {
    const types = Array.isArray(assetType) ? assetType : [assetType];
    balances = balances.filter((b) => types.includes(b.assetType));
  }
  if (excludeZero) balances = balances.filter((b) => b.balance !== "0.0000000");

  return ok(balances);
}
