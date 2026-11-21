import type { ResolvedNetworkConfig } from "../shared/types";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { TrustlineParams } from "./types";
import { buildTrustlineTransaction, validateTrustline } from "./buildTransaction";

export interface TrustlineManagerOptions {
  /** Cache duration for successful existence lookups. Defaults to five minutes. */
  cacheTtlMs?: number;
}

export interface CreateTrustlineResult {
  /** Unsigned transaction XDR, or null when no operation was needed. */
  xdr: string | null;
  /** True when the requested trustline was already present. */
  skipped: boolean;
  warning?: string;
}

interface CacheEntry {
  exists: boolean;
  expiresAt: number;
}

/**
 * Checks trustline existence before creating a changeTrust operation.
 * Existence is queried from Horizon and cached for the configured TTL.
 */
export class TrustlineManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(
    private readonly horizonUrl: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    options: TrustlineManagerOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async createTrustline(
    sourcePublicKey: string,
    params: TrustlineParams,
    trustedIssuers?: string[] | null,
  ): Promise<SorokitResult<CreateTrustlineResult>> {
    const key = `${sourcePublicKey}:${params.assetCode.toUpperCase()}:${params.assetIssuer}`;
    const now = Date.now();
    let cached = this.cache.get(key);
    if (!cached || cached.expiresAt <= now) {
      const state = await validateTrustline(this.horizonUrl, sourcePublicKey, {
        code: params.assetCode,
        issuer: params.assetIssuer,
      });
      if (state.status === "error") return state;
      cached = { exists: state.data.exists, expiresAt: now + this.cacheTtlMs };
      this.cache.set(key, cached);
    }

    if (cached.exists) {
      const warning = `Trustline ${params.assetCode}:${params.assetIssuer} already exists; no operation was added.`;
      return ok({ xdr: null, skipped: true, warning });
    }

    const built = await buildTrustlineTransaction(
      this.horizonUrl,
      this.networkConfig,
      sourcePublicKey,
      params,
      trustedIssuers,
    );
    if (built.status === "error") return built;
    return ok({ xdr: built.data, skipped: false });
  }
}

export function createTrustlineManager(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  options?: TrustlineManagerOptions,
): TrustlineManager {
  return new TrustlineManager(horizonUrl, networkConfig, options);
}

/**
 * Convenience one-shot API. Use TrustlineManager when creating multiple lines
 * so successful Horizon existence lookups can be reused.
 */
export async function createTrustline(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: TrustlineParams,
  options: TrustlineManagerOptions & { trustedIssuers?: string[] | null } = {},
): Promise<SorokitResult<CreateTrustlineResult>> {
  if (options.cacheTtlMs !== undefined && options.cacheTtlMs < 0) {
    return err(SorokitErrorCode.INVALID_CONFIG, "cacheTtlMs must be non-negative.");
  }
  return createTrustlineManager(horizonUrl, networkConfig, options).createTrustline(
    sourcePublicKey,
    params,
    options.trustedIssuers,
  );
}
