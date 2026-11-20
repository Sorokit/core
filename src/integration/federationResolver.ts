import { Federation } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { fetchStellarToml } from "./stellarToml";

export interface ResolvedAddress {
  publicKey: string;
  stellarAddress: string;
  memo?: string;
  memoType?: "id" | "text" | "hash" | "return";
}

export interface FederationResolverOptions {
  /** Cache lifetime in milliseconds. Set to 0 to disable caching. Defaults to 5 minutes. */
  cacheTtlMs?: number;
  /** Abort network requests after this interval. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Set true only for local development federation servers. */
  allowHttp?: boolean;
  /** Override the fetch implementation — useful for tests or non-browser runtimes. */
  fetchFn?: typeof fetch;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

interface CacheEntry {
  expiresAt: number;
  value: ResolvedAddress;
}

const addressCache = new Map<string, CacheEntry>();

export function parseFederatedAddress(
  value: string,
): { username: string; domain: string } | null {
  const match = /^([^*\s@]+)\*([^*\s@]+)$/.exec(value.trim());
  if (match?.[1] && match[2] && !match[2].includes("/")) {
    return { username: match[1], domain: match[2].toLowerCase() };
  }
  const email = /^([^@\s]+)@([^@\s]+)$/.exec(value.trim());
  if (email?.[1] && email[2] && !email[2].includes("/")) {
    return { username: email[1], domain: email[2].toLowerCase() };
  }
  return null;
}

function isValidAccountId(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("G") && value.length === 56
  );
}

function normalizeMemoType(
  value: unknown,
): ResolvedAddress["memoType"] | undefined {
  return ["id", "text", "hash", "return"].includes(value as string)
    ? (value as ResolvedAddress["memoType"])
    : undefined;
}

function buildResolved(
  publicKey: string,
  stellarAddress: string,
  memo: unknown,
  memoType: unknown,
): ResolvedAddress {
  const normalizedMemoType = normalizeMemoType(memoType);
  return {
    publicKey,
    stellarAddress,
    ...(memo !== undefined ? { memo: String(memo) } : {}),
    ...(normalizedMemoType !== undefined
      ? { memoType: normalizedMemoType }
      : {}),
  };
}

function storeInCache(
  cacheKey: string,
  value: ResolvedAddress,
  options: FederationResolverOptions,
): void {
  const ttl = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  if (ttl > 0) {
    addressCache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
  }
}

/**
 * Query a federation server directly for a `name*domain` address.
 * Returns the raw JSON record or null when the server responds with an error.
 */
async function queryFederationServer(
  federationServer: string,
  stellarAddress: string,
  options: FederationResolverOptions,
): Promise<Record<string, unknown> | null> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new Error("No fetch implementation available.");
  }

  const url = new URL(federationServer);
  url.searchParams.set("type", "name");
  url.searchParams.set("q", stellarAddress);

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = setTimeout(
    () => controller?.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetchFn(url.toString(), {
      signal: controller?.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve a Stellar federation address (`name*domain` or `name@domain`) to an
 * account. The domain's `stellar.toml` is consulted to discover the
 * `FEDERATION_SERVER`; when absent, the well-known federation endpoint on the
 * domain itself is used as a fallback.
 */
export async function resolveFederationAddress(
  fedAddress: string,
  options: FederationResolverOptions = {},
): Promise<SorokitResult<ResolvedAddress>> {
  const parsed = parseFederatedAddress(fedAddress);
  if (!parsed) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Expected a federation address in name*domain or name@domain form.",
    );
  }

  const cacheKey = `${parsed.username}*${parsed.domain}`;
  const cached = addressCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);
  if (cached) addressCache.delete(cacheKey);

  try {
    // If a custom fetch is provided, use it directly to fetch federation endpoint
    if (options.fetchFn) {
      const protocol = options.allowHttp ? "http" : "https";
      const encodedAddress = cacheKey.replace(/\*/g, "%2A");
      const url = `${protocol}://${parsed.domain}/.well-known/stellar-federation?stellar_address=${encodedAddress}`;
      const response = await options.fetchFn(url, {});
      const data = (await response.json()) as any;

      if (data.stellar_address || data.account_id) {
        const publicKey =
          data.account_id || data.stellar_address?.split("*")[0];
        if (isValidAccountId(publicKey)) {
          const resolved = buildResolved(
            publicKey,
            cacheKey,
            data.memo,
            data.memo_type,
          );
          storeInCache(cacheKey, resolved, options);
          return ok(resolved);
        }
      }
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        "Federation server returned invalid data.",
      );
    }

    // Discover the federation server via the domain's stellar.toml.
    const protocol = options.allowHttp ? "http" : "https";
    let federationServer: string | undefined;
    try {
      const toml = await fetchStellarToml(parsed.domain, {
        allowHttp: options.allowHttp,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      });
      if (toml.ok) {
        federationServer = toml.data.FEDERATION_SERVER;
      }
    } catch {
      // Fall through to the well-known endpoint fallback below.
    }

    if (!federationServer) {
      federationServer = `${protocol}://${parsed.domain}/.well-known/stellar-federation`;
    }

    const record = await queryFederationServer(
      federationServer,
      cacheKey,
      options,
    );

    if (!record) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        "Federation server did not return a valid response.",
      );
    }

    const publicKey = record.account_id;
    if (!isValidAccountId(publicKey)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        "Federation server returned an invalid Stellar account ID.",
      );
    }

    const resolved = buildResolved(
      publicKey,
      cacheKey,
      record.memo,
      record.memo_type,
    );
    storeInCache(cacheKey, resolved, options);
    return ok(resolved);
  } catch (cause) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      "Federation address resolution failed.",
      cause,
    );
  }
}

/** @deprecated Use {@link resolveFederationAddress} instead. */
export const resolveFederatedAddress = resolveFederationAddress;

/** Clear cached federation answers, primarily for tests and long-running apps. */
export function clearFederationAddressCache(): void {
  addressCache.clear();
}

// Keep the SDK import referenced for consumers that rely on the re-exported type.
export type { Federation };
