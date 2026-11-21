import { Asset } from "@stellar/stellar-sdk";
import { createHorizonServer } from "../shared/serverFactory";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import { validatePublicKey } from "../shared/validation";

export type DexAsset = Asset | { code: string; issuer?: string };
export interface DexActivityOptions {
  asset?: DexAsset;
  sellingAsset?: DexAsset;
  buyingAsset?: DexAsset;
  counterparty?: string;
  fromDate?: string | Date;
  toDate?: string | Date;
  cursor?: string;
  limit?: number;
}
export interface OfferInfo {
  id: string;
  pagingToken?: string;
  seller: string;
  selling: DexAssetAmount;
  buying: DexAssetAmount;
  price: string;
  amount: string;
  lastModifiedLedger?: number;
}
export interface TradeInfo {
  id: string;
  pagingToken?: string;
  seller: string;
  buyer: string;
  offerId?: string;
  base: DexAssetAmount;
  counter: DexAssetAmount;
  price: string;
  createdAt?: string;
}
export interface DexAssetAmount {
  type?: string;
  code: string;
  issuer?: string;
  amount: string;
}
export interface DexActivityResult<T> {
  records: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

function assetMatches(value: { asset_code?: string; asset_issuer?: string }, asset?: DexAsset): boolean {
  if (!asset) return true;
  const requested = asset instanceof Asset ? { code: asset.getCode(), issuer: asset.getIssuer() } : asset;
  return (value.asset_code ?? "XLM").toUpperCase() === requested.code.toUpperCase() &&
    (requested.issuer === undefined || value.asset_issuer === requested.issuer);
}

function assetValue(asset: DexAsset): { code: string; issuer?: string } {
  return asset instanceof Asset ? { code: asset.getCode(), issuer: asset.getIssuer() } : asset;
}

function applyAssetFilter(query: any, method: "forSellingAsset" | "forBuyingAsset", asset?: DexAsset): void {
  if (!asset || typeof query[method] !== "function") return;
  const value = assetValue(asset);
  query[method](value.code.toUpperCase() === "XLM" ? Asset.native() : new Asset(value.code, value.issuer));
}

function dateMatches(value: string | undefined, options: DexActivityOptions): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  const from = options.fromDate instanceof Date ? options.fromDate.getTime() : options.fromDate ? Date.parse(options.fromDate) : undefined;
  const to = options.toDate instanceof Date ? options.toDate.getTime() : options.toDate ? Date.parse(options.toDate) : undefined;
  return (from === undefined || timestamp >= from) && (to === undefined || timestamp <= to);
}

function page<T extends { paging_token?: string }>(records: T[], limit: number): DexActivityResult<T> {
  const hasMore = records.length > limit;
  const visible = hasMore ? records.slice(0, limit) : records;
  return { records: visible, nextCursor: hasMore ? visible[visible.length - 1]?.paging_token ?? null : null, hasMore };
}

function mapAsset(value: any): DexAssetAmount {
  return {
    type: value.asset_type,
    code: value.asset_code ?? "XLM",
    issuer: value.asset_issuer,
    amount: value.amount ?? "0",
  };
}

function mapOffer(record: any): OfferInfo {
  return {
    id: String(record.id),
    pagingToken: record.paging_token,
    seller: record.seller,
    selling: mapAsset(record.selling),
    buying: mapAsset(record.buying),
    price: record.price,
    amount: record.amount,
    lastModifiedLedger: record.last_modified_ledger,
  };
}

function mapTrade(record: any): TradeInfo {
  return {
    id: String(record.id ?? record.paging_token),
    pagingToken: record.paging_token,
    seller: record.base_account,
    buyer: record.counter_account,
    offerId: record.offer_id,
    base: mapAsset(record.base_asset),
    counter: mapAsset(record.counter_asset),
    price: record.price,
    createdAt: record.created_at,
  };
}

export async function getOffers(horizonUrl: string, publicKey: string, options: DexActivityOptions = {}): Promise<SorokitResult<DexActivityResult<OfferInfo>>> {
  const keyResult = validatePublicKey(publicKey);
  if (keyResult.status === "error") return keyResult;
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
  try {
    const query = createHorizonServer(horizonUrl).offers().forAccount(publicKey).limit(limit + 1);
    applyAssetFilter(query, "forSellingAsset", options.sellingAsset);
    applyAssetFilter(query, "forBuyingAsset", options.buyingAsset);
    if (options.cursor) query.cursor(options.cursor);
    const response = await query.call();
    const records = response.records.filter((record: any) => assetMatches(record.selling, options.asset) && assetMatches(record.buying, options.asset) && assetMatches(record.selling, options.sellingAsset) && assetMatches(record.buying, options.buyingAsset) && dateMatches(record.last_modified_time, options));
    const result = page(records, limit);
    return ok({ records: result.records.map(mapOffer), nextCursor: result.nextCursor, hasMore: result.hasMore });
  } catch (cause) {
    return err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, `Failed to fetch offers: ${toMessage(cause)}`, cause);
  }
}

/**
 * Fetch a single offer from Horizon by its id.
 *
 * `offerId` is Horizon's offer id: a positive integer, given as a digit string or a safe integer
 * number. Returns `OFFER_NOT_FOUND` when Horizon answers 404 (the offer never existed, or was
 * fully filled or cancelled), `VALIDATION` for a malformed id (no request is made), and
 * `ACCOUNT_FETCH_FAILED` for any other failure. In the result, `price` is the price of one unit
 * of the selling asset in the buying asset and `amount` is how much of the selling asset is
 * still on offer.
 */
export async function getOfferById(horizonUrl: string, offerId: string | number): Promise<SorokitResult<OfferInfo>> {
  const id = typeof offerId === "number" ? (Number.isSafeInteger(offerId) ? String(offerId) : "") : String(offerId).trim();
  if (!/^[1-9]\d*$/.test(id)) {
    return err(SorokitErrorCode.VALIDATION, `Invalid offer id: ${String(offerId)}. Expected a positive integer.`);
  }
  try {
    const record = await createHorizonServer(horizonUrl).offers().offer(id).call();
    return ok(mapOffer(record));
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return err(SorokitErrorCode.OFFER_NOT_FOUND, `Offer not found: ${id}`, cause);
    }
    return err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, `Failed to fetch offer ${id}: ${toMessage(cause)}`, cause);
  }
}

export async function getTrades(horizonUrl: string, publicKey: string, options: DexActivityOptions = {}): Promise<SorokitResult<DexActivityResult<TradeInfo>>> {
  const keyResult = validatePublicKey(publicKey);
  if (keyResult.status === "error") return keyResult;
  const counterpartyResult = options.counterparty ? validatePublicKey(options.counterparty) : null;
  if (counterpartyResult?.status === "error") return counterpartyResult;
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
  try {
    const query = createHorizonServer(horizonUrl).trades().forAccount(publicKey).limit(limit + 1);
    if (options.cursor) query.cursor(options.cursor);
    const response = await query.call();
    const records = response.records.filter((record: any) =>
      (!options.counterparty || record.base_account === options.counterparty || record.counter_account === options.counterparty) &&
      assetMatches(record.base_asset, options.asset) && assetMatches(record.counter_asset, options.asset) && dateMatches(record.created_at, options),
    );
    const result = page(records, limit);
    return ok({ records: result.records.map(mapTrade), nextCursor: result.nextCursor, hasMore: result.hasMore });
  } catch (cause) {
    return err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, `Failed to fetch trades: ${toMessage(cause)}`, cause);
  }
}
