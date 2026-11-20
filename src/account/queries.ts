import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
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
