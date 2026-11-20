import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";

export const ACCOUNT_QUERY_DEFAULT_HORIZON_URL =
  "https://horizon-testnet.stellar.org";

export interface PaymentInfo {
  id: string;
  pagingToken: string;
  from: string;
  to: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  createdAt: string;
  transactionHash: string;
  raw: Record<string, unknown>;
}

export interface PaymentPage {
  payments: PaymentInfo[];
  nextCursor: string | null;
}

export interface PaymentHistoryOptions {
  cursor?: string;
  limit?: number;
  order?: "asc" | "desc";
  counterparty?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  after?: string;
  before?: string;
}

export type PaymentDirection = "incoming" | "outgoing";

export interface Payment extends PaymentInfo {
  asset: string;
  ledger: number;
  direction: PaymentDirection;
}

export interface PaymentFilters {
  asset?: string | null | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
  minLedger?: number | undefined;
  maxLedger?: number | undefined;
  after?: string | undefined;
  before?: string | undefined;
  horizonUrl?: string | undefined;
}

export function resolveAccountQueryHorizonUrl(explicit?: string): string {
  if (explicit) return explicit;
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  return env?.SOROKIT_HORIZON_URL ?? ACCOUNT_QUERY_DEFAULT_HORIZON_URL;
}

function numberFrom(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const mapPayment = (r: any): PaymentInfo => ({
  id: String(r.id ?? ""),
  pagingToken: String(r.paging_token ?? ""),
  from: String(r.from ?? r.source_account ?? ""),
  to: String(r.to ?? r.destination ?? ""),
  amount: String(r.amount ?? ""),
  ...(r.asset_code !== undefined && { assetCode: String(r.asset_code) }),
  ...(r.asset_issuer !== undefined && { assetIssuer: String(r.asset_issuer) }),
  createdAt: String(r.created_at ?? ""),
  transactionHash: String(r.transaction_hash ?? ""),
  raw: r,
});

function toPayment(info: PaymentInfo, publicKey: string): Payment {
  const code = info.assetCode;
  const issuer = info.assetIssuer;
  const asset =
    code !== undefined && issuer !== undefined
      ? `${code}:${issuer}`
      : "native";
  const direction: PaymentDirection =
    info.to.toLowerCase() === publicKey.toLowerCase()
      ? "incoming"
      : "outgoing";

  return {
    ...info,
    asset,
    ledger: numberFrom(info.raw.ledger),
    direction,
  };
}

function paymentFailure(publicKey: string, cause: unknown): SorokitResult<never> {
  const notFound = isNotFoundError(cause);
  return err(
    notFound ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
    notFound
      ? `Account not found: ${publicKey}`
      : `Failed to fetch payment history for ${publicKey}: ${toMessage(cause)}`,
    cause,
  );
}

async function fetchPayments(
  horizonUrl: string,
  publicKey: string,
  options: PaymentHistoryOptions,
): Promise<SorokitResult<PaymentInfo[]>> {
  try {
    let builder: any = new Horizon.Server(horizonUrl)
      .payments()
      .forAccount(publicKey)
      .limit(Math.min(Math.max(1, options.limit ?? 20), 200))
      .order(options.order ?? "desc");

    if (options.cursor) builder = builder.cursor(options.cursor);

    const records = ((await builder.call()).records as any[]).map(mapPayment);
    const payments = records.filter(
      (payment) =>
        (!options.counterparty ||
          payment.from === options.counterparty ||
          payment.to === options.counterparty) &&
        (options.assetCode === undefined ||
          (options.assetCode === "native"
            ? payment.assetCode === undefined
            : payment.assetCode === options.assetCode)) &&
        (options.assetIssuer === undefined ||
          (options.assetIssuer === null
            ? payment.assetIssuer === undefined
            : payment.assetIssuer === options.assetIssuer)) &&
        (options.after === undefined ||
          new Date(payment.createdAt).getTime() >= new Date(options.after).getTime()) &&
        (options.before === undefined ||
          new Date(payment.createdAt).getTime() < new Date(options.before).getTime()),
    );

    return ok(payments);
  } catch (cause) {
    return paymentFailure(publicKey, cause);
  }
}

function toPaymentHistoryOptions(filters: PaymentFilters): PaymentHistoryOptions {
  const options: PaymentHistoryOptions = {
    ...(filters.cursor !== undefined ? { cursor: filters.cursor } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.order !== undefined ? { order: filters.order } : {}),
    ...(filters.after !== undefined ? { after: filters.after } : {}),
    ...(filters.before !== undefined ? { before: filters.before } : {}),
  };

  if (filters.asset !== undefined && filters.asset !== null) {
    if (filters.asset === "native") {
      options.assetCode = "native";
    } else {
      const separator = filters.asset.indexOf(":");
      if (separator > 0) {
        options.assetCode = filters.asset.slice(0, separator);
        options.assetIssuer = filters.asset.slice(separator + 1);
      } else {
        options.assetCode = filters.asset;
      }
    }
  }

  return options;
}

export function getPaymentHistory(
  publicKey: string,
  filters?: PaymentFilters,
): Promise<SorokitResult<Payment[]>>;
export function getPaymentHistory(
  horizonUrl: string,
  publicKey: string,
  options?: PaymentHistoryOptions,
): Promise<SorokitResult<PaymentPage>>;
export async function getPaymentHistory(
  first: string,
  second?: string | PaymentFilters,
  third?: PaymentHistoryOptions,
): Promise<SorokitResult<Payment[] | PaymentPage>> {
  if (typeof second === "string") {
    const result = await fetchPayments(first, second, third ?? {});
    if (result.status === "error") return result;
    return ok({
      payments: result.data,
      nextCursor: result.data.at(-1)?.pagingToken ?? null,
    });
  }

  const filters = second ?? {};
  const result = await fetchPayments(
    resolveAccountQueryHorizonUrl(filters.horizonUrl),
    first,
    toPaymentHistoryOptions(filters),
  );
  if (result.status === "error") return result;

  const payments = result.data
    .map((payment) => toPayment(payment, first))
    .filter(
      (payment) =>
        (filters.minLedger === undefined || payment.ledger >= filters.minLedger) &&
        (filters.maxLedger === undefined || payment.ledger <= filters.maxLedger),
    );

  return ok(payments);
}
