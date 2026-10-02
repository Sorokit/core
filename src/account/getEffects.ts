import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";

export interface EffectInfo { id: string; pagingToken: string; type: string; account?: string; createdAt: string; raw: Record<string, unknown>; }
export interface GetEffectsOptions { type?: string; cursor?: string; limit?: number; after?: string; before?: string; order?: "asc" | "desc"; }
export interface EffectsPage { effects: EffectInfo[]; nextCursor: string | null; }
export async function getEffects(horizonUrl: string, publicKey: string, options: GetEffectsOptions = {}): Promise<SorokitResult<EffectsPage>> {
  try {
    let builder: any = new Horizon.Server(horizonUrl).effects().forAccount(publicKey).limit(Math.min(Math.max(1, options.limit ?? 20), 200)).order(options.order ?? "desc");
    if (options.cursor) builder = builder.cursor(options.cursor);
    const records = ((await builder.call()).records as any[]).map((r) => ({ id: String(r.id ?? ""), pagingToken: String(r.paging_token ?? ""), type: String(r.type ?? ""), ...(r.account !== undefined && { account: String(r.account) }), createdAt: String(r.created_at ?? ""), raw: r }));
    const effects = records.filter((e) => (options.type === undefined || e.type === options.type) && (options.after === undefined || new Date(e.createdAt).getTime() >= new Date(options.after).getTime()) && (options.before === undefined || new Date(e.createdAt).getTime() < new Date(options.before).getTime()));
    return ok({ effects, nextCursor: effects.at(-1)?.pagingToken ?? null });
  } catch (cause) { const nf = isNotFoundError(cause); return err(nf ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.ACCOUNT_FETCH_FAILED, nf ? `Account not found: ${publicKey}` : `Failed to fetch effects for ${publicKey}: ${toMessage(cause)}`, cause); }
}
