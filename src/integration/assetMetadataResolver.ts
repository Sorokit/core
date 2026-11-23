import { fetchStellarToml, type StellarToml } from "./sep1Toml";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

export interface AssetMetadata {
  code: string;
  issuer: string;
  name?: string;
  description?: string;
  logo?: string;
  image?: string;
  decimals?: number;
  conditions?: string;
  orgName?: string;
  domain?: string;
  toml?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AssetMetadataResolverOptions {
  domain?: string;
  horizonUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  bypassCache?: boolean;
}

const DEFAULT_METADATA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const metadataCache = new Map<string, { data: AssetMetadata; expiresAt: number }>();

function buildCacheKey(code: string, issuer: string): string {
  return `${code.toUpperCase()}:${issuer.trim()}`;
}

/**
 * Clears the in-memory asset metadata cache.
 */
export function clearAssetMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Retrieves cached asset metadata if available and not expired.
 */
export function getCachedAssetMetadata(
  code: string,
  issuer: string,
): AssetMetadata | undefined {
  const key = buildCacheKey(code, issuer);
  const entry = metadataCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    metadataCache.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * Stores asset metadata in cache with an expiration time.
 */
export function setCachedAssetMetadata(
  code: string,
  issuer: string,
  metadata: AssetMetadata,
  ttlMs: number = DEFAULT_METADATA_CACHE_TTL_MS,
): void {
  const key = buildCacheKey(code, issuer);
  metadataCache.set(key, {
    data: metadata,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Resolves metadata for a Stellar asset from the issuer's stellar.toml.
 * Results are cached in memory for fast subsequent lookups.
 *
 * @param code    - Asset code (e.g., "USDC", "XLM").
 * @param issuer  - Asset issuer public key (empty or ignored for native XLM).
 * @param options - Resolution options (domain override, horizonUrl, fetch, ttlMs).
 * @returns SorokitResult with AssetMetadata on success.
 */
export async function getAssetMetadata(
  code: string,
  issuer: string,
  options?: AssetMetadataResolverOptions,
): Promise<SorokitResult<AssetMetadata>> {
  if (!code || typeof code !== "string" || !code.trim()) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Asset code is required to resolve metadata.",
    );
  }

  const normalizedCode = code.trim().toUpperCase();

  // Handle native XLM
  if (normalizedCode === "XLM" || normalizedCode === "NATIVE") {
    const nativeMeta: AssetMetadata = {
      code: "XLM",
      issuer: "",
      name: "Lumen",
      description: "The native currency of the Stellar network.",
      logo: "https://stellar.org/favicon.ico",
      image: "https://stellar.org/favicon.ico",
      decimals: 7,
      domain: "stellar.org",
    };
    return ok(nativeMeta);
  }

  if (!issuer || typeof issuer !== "string" || !issuer.trim()) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Asset issuer is required for non-native assets.",
    );
  }

  const normalizedIssuer = issuer.trim();

  // Check cache unless bypassCache requested
  if (!options?.bypassCache) {
    const cached = getCachedAssetMetadata(normalizedCode, normalizedIssuer);
    if (cached) {
      return ok(cached);
    }
  }

  let domain = options?.domain?.trim();

  // If domain is not provided directly, resolve from issuer's account info
  if (!domain) {
    const horizonUrl =
      options?.horizonUrl ?? "https://horizon.stellar.org";
    try {
      const fetchFn = options?.fetch ?? globalThis.fetch;
      const accountRes = await fetchFn(`${horizonUrl}/accounts/${normalizedIssuer}`, {
        headers: { Accept: "application/json" },
      });
      if (accountRes.ok) {
        const accountData = (await accountRes.json()) as { home_domain?: string };
        domain = accountData.home_domain;
      }
    } catch {
      // Fallback if network/account lookup fails
    }
  }

  if (!domain) {
    return err(
      SorokitErrorCode.ACCOUNT_NOT_FOUND,
      `Cannot resolve asset metadata: issuer ${normalizedIssuer} has no home domain configured and no domain was provided.`,
    );
  }

  // Fetch stellar.toml from issuer's domain
  const tomlResult = await fetchStellarToml(domain, {
    fetch: options?.fetch,
    timeoutMs: options?.timeoutMs,
  });

  if (tomlResult.status === "error") {
    return err(
      SorokitErrorCode.SERVICE_UNAVAILABLE,
      `Failed to fetch stellar.toml from "${domain}": ${tomlResult.error.message}`,
      tomlResult.error,
    );
  }

  const toml = tomlResult.data;
  const currencies = (toml as Record<string, unknown>).CURRENCIES;

  let matchedCurrency: Record<string, unknown> | undefined;

  if (Array.isArray(currencies)) {
    matchedCurrency = currencies.find((c: unknown) => {
      if (!c || typeof c !== "object") return false;
      const rec = c as Record<string, unknown>;
      const codeMatch =
        typeof rec.code === "string" &&
        rec.code.toUpperCase() === normalizedCode;
      const issuerMatch =
        !rec.issuer ||
        (typeof rec.issuer === "string" && rec.issuer === normalizedIssuer);
      return codeMatch && issuerMatch;
    }) as Record<string, unknown> | undefined;

    // Fallback: match by code alone if issuer wasn't specified in toml
    if (!matchedCurrency) {
      matchedCurrency = currencies.find((c: unknown) => {
        if (!c || typeof c !== "object") return false;
        const rec = c as Record<string, unknown>;
        return (
          typeof rec.code === "string" &&
          rec.code.toUpperCase() === normalizedCode
        );
      }) as Record<string, unknown> | undefined;
    }
  }

  const doc = (toml as Record<string, unknown>).DOCUMENTATION as
    | Record<string, unknown>
    | undefined;

  const metadata: AssetMetadata = {
    code: normalizedCode,
    issuer: normalizedIssuer,
    name:
      (matchedCurrency?.name as string | undefined) ??
      normalizedCode,
    description:
      (matchedCurrency?.desc as string | undefined) ??
      (matchedCurrency?.description as string | undefined),
    logo:
      (matchedCurrency?.image as string | undefined) ??
      (matchedCurrency?.logo as string | undefined),
    image:
      (matchedCurrency?.image as string | undefined) ??
      (matchedCurrency?.logo as string | undefined),
    decimals:
      typeof matchedCurrency?.display_decimals === "number"
        ? matchedCurrency.display_decimals
        : undefined,
    conditions: matchedCurrency?.conditions as string | undefined,
    orgName: doc?.ORG_NAME as string | undefined,
    domain,
    toml: matchedCurrency,
  };

  // Cache resolved metadata
  setCachedAssetMetadata(
    normalizedCode,
    normalizedIssuer,
    metadata,
    options?.ttlMs ?? DEFAULT_METADATA_CACHE_TTL_MS,
  );

  return ok(metadata);
}
