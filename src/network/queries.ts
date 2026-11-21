import { Asset } from "@stellar/stellar-sdk";
import { createHorizonServer } from "../shared/serverFactory";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { horizonErrorResult } from "../shared/horizonErrorMapper";
import { validateAssetCode, validateAssetIssuer, validatePublicKey } from "../shared/validation";
import { resolveAccountQueryHorizonUrl } from "../account/paymentHistory";

/** An asset as a Stellar `Asset` or a plain `{ code, issuer? }`; `XLM` means native. */
export type LiquidityPoolAsset = Asset | { code: string; issuer?: string };

export interface LiquidityPoolReserve {
  /** Canonical form: `"native"` or `"CODE:ISSUER"`. */
  asset: string;
  code: string;
  issuer?: string;
  amount: string;
}

export interface LiquidityPool {
  id: string;
  /** Use the last pool's `pagingToken` as `cursor` to fetch the next page. */
  pagingToken?: string;
  type: string;
  /** Pool fee in basis points (30 = 0.3%). */
  feeBps: number;
  /** Pool fee as a percentage (0.3 for 30 bps). */
  feePercent: number;
  totalTrustlines: number;
  /** Total pool shares outstanding, as Horizon's decimal string. */
  totalShares: string;
  reserves: LiquidityPoolReserve[];
  lastModifiedLedger?: number;
  lastModifiedTime?: string;
}

export interface LiquidityPoolFilters {
  /** Only pools this account holds shares in. */
  account?: string;
  /** Only pools holding these assets (one or two). */
  assets?: LiquidityPoolAsset[];
  /** Paging cursor: the `pagingToken` of the last pool of the previous page. */
  cursor?: string;
  /** Page size, 1 to 200. Default 10. */
  limit?: number;
  order?: "asc" | "desc";
  /** Horizon URL; defaults to `SOROKIT_HORIZON_URL` or the SDK default. */
  horizonUrl?: string;
}

export interface LiquidityPoolByAssetsOptions {
  horizonUrl?: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

function describeAsset(asset: LiquidityPoolAsset): { code: string; issuer?: string } {
  return asset instanceof Asset
    ? { code: asset.getCode(), issuer: asset.isNative() ? undefined : asset.getIssuer() }
    : asset;
}

function isNativeAsset(value: { code: string; issuer?: string }): boolean {
  return value.code === "XLM" && !value.issuer;
}

/** `"native"` or `"CODE:ISSUER"`, used to compare assets regardless of their form. */
function canonical(value: { code: string; issuer?: string }): string {
  return isNativeAsset(value) ? "native" : `${value.code}:${value.issuer}`;
}

function toSdkAsset(asset: LiquidityPoolAsset): SorokitResult<Asset> {
  if (asset instanceof Asset) return ok(asset);
  if (!asset || typeof asset !== "object") {
    return err(SorokitErrorCode.VALIDATION, "Each asset must be an Asset or { code, issuer? }.");
  }
  if (isNativeAsset(asset)) return ok(Asset.native());
  const code = validateAssetCode(asset.code);
  if (code.status === "error") return code;
  if (!asset.issuer) {
    return err(SorokitErrorCode.VALIDATION, `Asset ${asset.code} needs an issuer (only XLM is native).`);
  }
  const issuer = validateAssetIssuer(asset.issuer);
  if (issuer.status === "error") return issuer;
  try {
    return ok(new Asset(asset.code, asset.issuer));
  } catch (cause) {
    return err(SorokitErrorCode.VALIDATION, `Invalid asset ${asset.code}:${asset.issuer}.`, cause);
  }
}

function mapReserve(reserve: { asset?: string; amount?: string }): LiquidityPoolReserve {
  const raw = reserve.asset ?? "native";
  if (raw === "native") return { asset: "native", code: "XLM", amount: reserve.amount ?? "0" };
  const [code, issuer] = raw.split(":");
  return { asset: raw, code, issuer, amount: reserve.amount ?? "0" };
}

function mapPool(record: any): LiquidityPool {
  const feeBps = Number(record.fee_bp ?? 0);
  return {
    id: String(record.id),
    pagingToken: record.paging_token,
    type: record.type,
    feeBps,
    feePercent: feeBps / 100,
    totalTrustlines: Number(record.total_trustlines ?? 0),
    totalShares: String(record.total_shares ?? "0"),
    reserves: (record.reserves ?? []).map(mapReserve),
    lastModifiedLedger: record.last_modified_ledger,
    lastModifiedTime: record.last_modified_time,
  };
}

/**
 * List liquidity pools from Horizon.
 *
 * Filter by `account` (pools it holds shares in) and/or `assets` (one or two),
 * and page with `cursor` / `limit` / `order`. To get the next page, pass the
 * last returned pool's `pagingToken` as `cursor`. Each pool includes its fee
 * (`feeBps`, `feePercent`), reserves and share totals; nothing is aggregated.
 *
 * Returns `VALIDATION` for a bad account, asset list or asset (no request is
 * made), and a mapped network error (`NETWORK_ERROR`, `SERVICE_UNAVAILABLE`,
 * ...) when Horizon fails. Never throws.
 */
export async function getLiquidityPools(
  filters: LiquidityPoolFilters = {},
): Promise<SorokitResult<LiquidityPool[]>> {
  if (filters.account !== undefined) {
    const account = validatePublicKey(filters.account);
    if (account.status === "error") return account;
  }

  let assets: Asset[] | undefined;
  if (filters.assets !== undefined) {
    if (!Array.isArray(filters.assets) || filters.assets.length < 1 || filters.assets.length > 2) {
      return err(SorokitErrorCode.VALIDATION, "assets must contain one or two assets.");
    }
    assets = [];
    for (const asset of filters.assets) {
      const sdkAsset = toSdkAsset(asset);
      if (sdkAsset.status === "error") return sdkAsset;
      assets.push(sdkAsset.data);
    }
  }

  const requested = Math.floor(filters.limit ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(requested) ? requested : DEFAULT_LIMIT));

  try {
    const query = createHorizonServer(resolveAccountQueryHorizonUrl(filters.horizonUrl)).liquidityPools();
    if (filters.account) query.forAccount(filters.account);
    if (assets) query.forAssets(...assets);
    query.limit(limit);
    if (filters.cursor) query.cursor(filters.cursor);
    if (filters.order) query.order(filters.order);
    const response = await query.call();
    return ok(response.records.map(mapPool));
  } catch (cause) {
    return horizonErrorResult<LiquidityPool[]>(cause, { fallbackCode: SorokitErrorCode.NETWORK_ERROR });
  }
}

/**
 * Find the liquidity pools that hold a given asset pair.
 *
 * The order of `assetA` and `assetB` does not matter: `(A, B)` and `(B, A)`
 * return the same pools. Native XLM may be given as `Asset.native()` or
 * `{ code: "XLM" }`. Returns `VALIDATION` if either asset is invalid or both
 * are the same asset. Pools are checked against the pair after fetching, so
 * only pools holding both assets are returned; no routing is performed.
 */
export async function getLiquidityPoolByAssets(
  assetA: LiquidityPoolAsset,
  assetB: LiquidityPoolAsset,
  options: LiquidityPoolByAssetsOptions = {},
): Promise<SorokitResult<LiquidityPool[]>> {
  const a = toSdkAsset(assetA);
  if (a.status === "error") return a;
  const b = toSdkAsset(assetB);
  if (b.status === "error") return b;

  const keyA = canonical(describeAsset(a.data));
  const keyB = canonical(describeAsset(b.data));
  if (keyA === keyB) {
    return err(SorokitErrorCode.VALIDATION, "assetA and assetB must be different assets.");
  }

  const result = await getLiquidityPools({
    assets: [a.data, b.data],
    limit: MAX_LIMIT,
    horizonUrl: options.horizonUrl,
  });
  if (result.status === "error") return result;

  return ok(
    result.data.filter((pool) => {
      const held = new Set(pool.reserves.map((reserve) => reserve.asset));
      return held.has(keyA) && held.has(keyB);
    }),
  );
}
