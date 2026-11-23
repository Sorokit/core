import { Asset } from "@stellar/stellar-sdk";
import { createHorizonServer } from "../shared/serverFactory";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { validatePublicKey } from "../shared/validation";

/** Asset description for an account offer */
export interface OfferAsset {
  code: string;
  issuer?: string | null;
  type?: string;
}

/** Normalized offer structure */
export interface Offer {
  id: string;
  seller: string;
  selling: OfferAsset;
  buying: OfferAsset;
  amount: string;
  price: string;
  priceR?: {
    numerator: number;
    denominator: number;
  };
  lastModifiedLedger?: number;
  lastModifiedTime?: string;
  pagingToken?: string;
  status: "open" | "closed";
}

/** Filtering options for getAccountOffers */
export interface AccountOffersFilters {
  horizonUrl?: string;
  sellingAsset?: { code: string; issuer?: string | null } | string;
  buyingAsset?: { code: string; issuer?: string | null } | string;
  minPrice?: string | number;
  maxPrice?: string | number;
  status?: "open" | "closed" | "all";
  cursor?: string;
  limit?: number;
  order?: "asc" | "desc";
}

/** Asset description for an account trade */
export interface TradeAsset {
  code: string;
  issuer?: string | null;
  type?: string;
}

/** Normalized trade structure */
export interface Trade {
  id: string;
  pagingToken?: string;
  ledgerCloseTime?: string;
  offerId?: string;
  baseAccount?: string;
  baseAmount: string;
  baseAsset: TradeAsset;
  counterAccount?: string;
  counterAmount: string;
  counterAsset: TradeAsset;
  baseIsSeller?: boolean;
  price?: {
    n: number;
    d: number;
  };
  createdAt?: string;
}

/** Filtering options for getAccountTrades */
export interface AccountTradesFilters {
  horizonUrl?: string;
  baseAsset?: { code: string; issuer?: string | null } | string;
  counterAsset?: { code: string; issuer?: string | null } | string;
  startTime?: string | Date | number;
  endTime?: string | Date | number;
  cursor?: string;
  limit?: number;
  order?: "asc" | "desc";
}

function matchesAssetFilter(
  asset: { code?: string; issuer?: string | null; type?: string },
  filter?: { code: string; issuer?: string | null } | string,
): boolean {
  if (!filter) return true;
  const filterCode = typeof filter === "string" ? filter : filter.code;
  const filterIssuer = typeof filter === "string" ? undefined : filter.issuer;

  const code = (asset.code ?? "XLM").toUpperCase();
  const targetCode = filterCode.toUpperCase();

  if (targetCode === "XLM" || targetCode === "NATIVE") {
    return code === "XLM" || asset.type === "native";
  }

  if (code !== targetCode) return false;
  if (filterIssuer !== undefined && filterIssuer !== null && filterIssuer !== "") {
    return asset.issuer === filterIssuer;
  }
  return true;
}

/**
 * Fetch offers for an account with support for filtering and pagination.
 *
 * @param publicKey - The Stellar account public key (or horizonUrl when 3 arguments are passed).
 * @param filters - Filtering and pagination options.
 * @returns SorokitResult<Offer[]> on success or SorokitError on failure.
 */
export async function getAccountOffers(
  publicKey: string,
  filters?: AccountOffersFilters,
): Promise<SorokitResult<Offer[]>>;
export async function getAccountOffers(
  horizonUrl: string,
  publicKey: string,
  filters?: AccountOffersFilters,
): Promise<SorokitResult<Offer[]>>;
export async function getAccountOffers(
  publicKeyOrHorizonUrl: string,
  publicKeyOrFilters?: string | AccountOffersFilters,
  maybeFilters?: AccountOffersFilters,
): Promise<SorokitResult<Offer[]>> {
  let horizonUrl: string;
  let publicKey: string;
  let filters: AccountOffersFilters;

  if (typeof publicKeyOrFilters === "string") {
    horizonUrl = publicKeyOrHorizonUrl;
    publicKey = publicKeyOrFilters;
    filters = maybeFilters ?? {};
  } else {
    publicKey = publicKeyOrHorizonUrl;
    filters = publicKeyOrFilters ?? {};
    horizonUrl = filters.horizonUrl ?? "https://horizon.stellar.org";
  }

  const keyResult = validatePublicKey(publicKey);
  if (keyResult.status === "error") return keyResult;

  if (filters.status === "closed") {
    // Horizon offers endpoint only maintains live open offers on the ledger.
    // Querying closed offers directly returns an empty list as closed offers are deleted from the ledger state.
    return ok([]);
  }

  const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 20)));
  const order = filters.order ?? "desc";

  try {
    const server = createHorizonServer(horizonUrl);
    let builder: any = server.offers().forAccount(publicKey).limit(limit).order(order);

    if (filters.cursor) {
      builder = builder.cursor(filters.cursor);
    }

    const response = await builder.call();
    const records: any[] = response.records ?? [];

    let offers: Offer[] = records.map((record) => {
      const selling: OfferAsset = {
        code: record.selling?.asset_code ?? (record.selling?.asset_type === "native" ? "XLM" : "XLM"),
        issuer: record.selling?.asset_issuer ?? null,
        type: record.selling?.asset_type ?? (record.selling?.asset_code ? "credit_alphanum4" : "native"),
      };
      const buying: OfferAsset = {
        code: record.buying?.asset_code ?? (record.buying?.asset_type === "native" ? "XLM" : "XLM"),
        issuer: record.buying?.asset_issuer ?? null,
        type: record.buying?.asset_type ?? (record.buying?.asset_code ? "credit_alphanum4" : "native"),
      };
      return {
        id: String(record.id),
        seller: String(record.seller ?? publicKey),
        selling,
        buying,
        amount: String(record.amount ?? "0"),
        price: String(record.price ?? "0"),
        priceR: record.price_r ? { numerator: record.price_r.n, denominator: record.price_r.d } : undefined,
        lastModifiedLedger: record.last_modified_ledger,
        lastModifiedTime: record.last_modified_time,
        pagingToken: record.paging_token,
        status: "open" as const,
      };
    });

    if (filters.sellingAsset) {
      offers = offers.filter((o) => matchesAssetFilter(o.selling, filters.sellingAsset));
    }
    if (filters.buyingAsset) {
      offers = offers.filter((o) => matchesAssetFilter(o.buying, filters.buyingAsset));
    }
    if (filters.minPrice !== undefined) {
      const minP = Number(filters.minPrice);
      offers = offers.filter((o) => Number(o.price) >= minP);
    }
    if (filters.maxPrice !== undefined) {
      const maxP = Number(filters.maxPrice);
      offers = offers.filter((o) => Number(o.price) <= maxP);
    }
    if (filters.status && filters.status !== "all" && filters.status !== "open") {
      offers = offers.filter((o) => o.status === filters.status);
    }

    return ok(offers);
  } catch (cause) {
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `Failed to fetch account offers for ${publicKey}: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Fetch trades for an account with support for filtering and pagination.
 *
 * @param publicKey - The Stellar account public key (or horizonUrl when 3 arguments are passed).
 * @param filters - Filtering and pagination options.
 * @returns SorokitResult<Trade[]> on success or SorokitError on failure.
 */
export async function getAccountTrades(
  publicKey: string,
  filters?: AccountTradesFilters,
): Promise<SorokitResult<Trade[]>>;
export async function getAccountTrades(
  horizonUrl: string,
  publicKey: string,
  filters?: AccountTradesFilters,
): Promise<SorokitResult<Trade[]>>;
export async function getAccountTrades(
  publicKeyOrHorizonUrl: string,
  publicKeyOrFilters?: string | AccountTradesFilters,
  maybeFilters?: AccountTradesFilters,
): Promise<SorokitResult<Trade[]>> {
  let horizonUrl: string;
  let publicKey: string;
  let filters: AccountTradesFilters;

  if (typeof publicKeyOrFilters === "string") {
    horizonUrl = publicKeyOrHorizonUrl;
    publicKey = publicKeyOrFilters;
    filters = maybeFilters ?? {};
  } else {
    publicKey = publicKeyOrHorizonUrl;
    filters = publicKeyOrFilters ?? {};
    horizonUrl = filters.horizonUrl ?? "https://horizon.stellar.org";
  }

  const keyResult = validatePublicKey(publicKey);
  if (keyResult.status === "error") return keyResult;

  const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 20)));
  const order = filters.order ?? "desc";

  try {
    const server = createHorizonServer(horizonUrl);
    let builder: any = server.trades().forAccount(publicKey).limit(limit).order(order);

    if (filters.cursor) {
      builder = builder.cursor(filters.cursor);
    }

    const response = await builder.call();
    const records: any[] = response.records ?? [];

    let trades: Trade[] = records.map((record) => {
      const baseAsset: TradeAsset = {
        code: record.base_asset_code ?? (record.base_asset_type === "native" ? "XLM" : "XLM"),
        issuer: record.base_asset_issuer ?? null,
        type: record.base_asset_type ?? (record.base_asset_code ? "credit_alphanum4" : "native"),
      };
      const counterAsset: TradeAsset = {
        code: record.counter_asset_code ?? (record.counter_asset_type === "native" ? "XLM" : "XLM"),
        issuer: record.counter_asset_issuer ?? null,
        type: record.counter_asset_type ?? (record.counter_asset_code ? "credit_alphanum4" : "native"),
      };

      return {
        id: String(record.id ?? record.paging_token),
        pagingToken: record.paging_token,
        ledgerCloseTime: record.ledger_close_time,
        offerId: record.offer_id ? String(record.offer_id) : undefined,
        baseAccount: record.base_account,
        baseAmount: String(record.base_amount ?? "0"),
        baseAsset,
        counterAccount: record.counter_account,
        counterAmount: String(record.counter_amount ?? "0"),
        counterAsset,
        baseIsSeller: record.base_is_seller,
        price: record.price ? { n: record.price.n, d: record.price.d } : undefined,
        createdAt: record.created_at ?? record.ledger_close_time,
      };
    });

    if (filters.baseAsset) {
      trades = trades.filter((t) => matchesAssetFilter(t.baseAsset, filters.baseAsset));
    }
    if (filters.counterAsset) {
      trades = trades.filter((t) => matchesAssetFilter(t.counterAsset, filters.counterAsset));
    }
    if (filters.startTime !== undefined) {
      const startMs = new Date(filters.startTime).getTime();
      trades = trades.filter((t) => {
        const tTime = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        return tTime >= startMs;
      });
    }
    if (filters.endTime !== undefined) {
      const endMs = new Date(filters.endTime).getTime();
      trades = trades.filter((t) => {
        const tTime = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        return tTime <= endMs;
      });
    }

    return ok(trades);
  } catch (cause) {
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `Failed to fetch account trades for ${publicKey}: ${toMessage(cause)}`,
      cause,
    );
  }
}
