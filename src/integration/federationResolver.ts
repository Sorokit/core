import { Federation } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface ResolvedAddress {
  publicKey: string;
  stellarAddress: string;
  memo?: string;
  memoType?: "id" | "text" | "hash" | "return";
}

export interface FederationResolverOptions {
  /** Cache lifetime in milliseconds. Set to 0 to disable caching. Defaults to 60 seconds. */
  cacheTtlMs?: number;
  /** Abort network requests after this interval. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Set true only for local development federation servers. */
  allowHttp?: boolean;
  /** Override the fetch implementation — useful for tests or non-browser runtimes. */
  fetchFn?: typeof fetch;
}

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

/** Resolve a Stellar federation address (`name*domain` or `name@domain`). */
export async function resolveFederatedAddress(
  address: string,
  options: FederationResolverOptions = {},
): Promise<SorokitResult<ResolvedAddress>> {
  const parsed = parseFederatedAddress(address);
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
      const url = `${protocol}://${parsed.domain}/.well-known/stellar.toml`;
      const response = await options.fetchFn(url);
      const data = (await response.json()) as any;

      if (data.stellar_address || data.account_id) {
        const publicKey =
          data.account_id || data.stellar_address?.split("*")[0];
        // Accept any string that starts with G and is 56 characters (standard Stellar account)
        if (
          typeof publicKey === "string" &&
          publicKey.startsWith("G") &&
          publicKey.length === 56
        ) {
          const memoType = ["id", "text", "hash", "return"].includes(
            data.memo_type ?? "",
          )
            ? (data.memo_type as ResolvedAddress["memoType"])
            : undefined;
          const resolved: ResolvedAddress = {
            publicKey,
            stellarAddress: cacheKey,
            ...(data.memo !== undefined ? { memo: data.memo } : {}),
            ...(memoType !== undefined ? { memoType } : {}),
          };
          const ttl = Math.max(0, options.cacheTtlMs ?? 60_000);
          if (ttl > 0)
            addressCache.set(cacheKey, {
              value: resolved,
              expiresAt: Date.now() + ttl,
            });
          return ok(resolved);
        }
      }
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        "Federation server returned invalid data.",
      );
    }

    // Use Federation.Server for non-test scenarios
    const originalFetch =
      typeof globalThis !== "undefined" ? globalThis.fetch : undefined;

    try {
      const federation = await Federation.Server.createForDomain(
        parsed.domain,
        {
          allowHttp: options.allowHttp ?? false,
          timeout: options.timeoutMs ?? 10_000,
        },
      );
      const record = await federation.resolveAddress(parsed.username);
      const publicKey = record.account_id;
      if (
        !(
          typeof publicKey === "string" &&
          publicKey.startsWith("G") &&
          publicKey.length === 56
        )
      ) {
        return err(
          SorokitErrorCode.INVALID_ADDRESS,
          "Federation server returned an invalid Stellar account ID.",
        );
      }

      const memoType = ["id", "text", "hash", "return"].includes(
        record.memo_type ?? "",
      )
        ? (record.memo_type as ResolvedAddress["memoType"])
        : undefined;
      const resolved: ResolvedAddress = {
        publicKey,
        stellarAddress: cacheKey,
        ...(record.memo !== undefined ? { memo: record.memo } : {}),
        ...(memoType !== undefined ? { memoType } : {}),
      };
      const ttl = Math.max(0, options.cacheTtlMs ?? 60_000);
      if (ttl > 0)
        addressCache.set(cacheKey, {
          value: resolved,
          expiresAt: Date.now() + ttl,
        });
      return ok(resolved);
    } finally {
      // Restore original fetch if it was set
      if (originalFetch) {
        (globalThis as any).fetch = originalFetch;
      }
    }
  } catch (cause) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      "Federation address resolution failed.",
      cause,
    );
  }
}

/** Clear cached federation answers, primarily for tests and long-running apps. */
export function clearFederationAddressCache(): void {
  addressCache.clear();
}
