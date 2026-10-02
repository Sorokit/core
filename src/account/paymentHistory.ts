import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";

export interface PaymentInfo { id: string; pagingToken: string; from: string; to: string; amount: string; assetCode?: string; assetIssuer?: string; createdAt: string; transactionHash: string; raw: Record<string, unknown>; }
export interface PaymentPage { payments: PaymentInfo[]; nextCursor: string | null; }
export interface PaymentHistoryOptions { cursor?: string; limit?: number; order?: "asc" | "desc"; counterparty?: string; assetCode?: string; assetIssuer?: string | null; after?: string; before?: string; }
const mapPayment = (r: any): PaymentInfo => ({ id: String(r.id ?? ""), pagingToken: String(r.paging_token ?? ""), from: String(r.from ?? r.source_account ?? ""), to: String(r.to ?? r.destination ?? ""), amount: String(r.amount ?? ""), ...(r.asset_code !== undefined && { assetCode: String(r.asset_code) }), ...(r.asset_issuer !== undefined && { assetIssuer: String(r.asset_issuer) }), createdAt: String(r.created_at ?? ""), transactionHash: String(r.transaction_hash ?? ""), raw: r });
export async function getPaymentHistory(horizonUrl: string, publicKey: string, options: PaymentHistoryOptions = {}): Promise<SorokitResult<PaymentPage>> {
  try {
    let builder: any = new Horizon.Server(horizonUrl).payments().forAccount(publicKey).limit(Math.min(Math.max(1, options.limit ?? 20), 200)).order(options.order ?? "desc");
    if (options.cursor) builder = builder.cursor(options.cursor);
    const records = ((await builder.call()).records as any[]).map(mapPayment);
    const payments = records.filter((p) => (!options.counterparty || p.from === options.counterparty || p.to === options.counterparty) && (options.assetCode === undefined || (options.assetCode === "native" ? p.assetCode === undefined : p.assetCode === options.assetCode)) && (options.assetIssuer === undefined || (options.assetIssuer === null ? p.assetIssuer === undefined : p.assetIssuer === options.assetIssuer)) && (options.after === undefined || new Date(p.createdAt).getTime() >= new Date(options.after).getTime()) && (options.before === undefined || new Date(p.createdAt).getTime() < new Date(options.before).getTime()));
    return ok({ payments, nextCursor: payments.at(-1)?.pagingToken ?? null });
  } catch (cause) { const nf = isNotFoundError(cause); return err(nf ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED, nf ? `Account not found: ${publicKey}` : `Failed to fetch payment history for ${publicKey}: ${toMessage(cause)}`, cause); }
}
