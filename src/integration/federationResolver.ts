import { Federation } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface ResolvedAddress {
  publicKey: string;
  stellarAddress: string;
  memo?: string;
  memoType?: "id" | "text" | "hash" | "return";
}

export type FederationMemoType = "id" | "text" | "hash" | "return";

export interface ParsedFederatedAddress {
  username: string;
  domain: string;
  memo?: string;
  memoType?: FederationMemoType;
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
): ParsedFederatedAddress | null {
  const [addressPart, query = ""] = value.trim().split("?", 2);
  const match = /^([^*\s@]+)\*([^*\s@]+)$/.exec(addressPart ?? "");
  if (match?.[1] && match[2] && !match[2].includes("/")) {
    return parseFederationMemo(match[1], match[2], query);
  }
  const email = /^([^@\s]+)@([^@\s]+)$/.exec(addressPart ?? "");
  if (email?.[1] && email[2] && !email[2].includes("/")) {
    return parseFederationMemo(email[1], email[2], query);
  }
  return null;
}

function parseFederationMemo(
  username: string,
  domain: string,
  query: string,
): ParsedFederatedAddress | null {
  if (!query) return { username, domain: domain.toLowerCase() };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }

  const memoType = params.get("memo_type") as FederationMemoType | null;
  const memo = params.get("memo_id") ?? params.get("memo_text") ?? params.get("memo_hash") ?? params.get("memo_return");
  if (!memoType || !memo || !["id", "text", "hash", "return"].includes(memoType)) return null;
  if (memoType === "id" && (!/^\d+$/.test(memo) || BigInt(memo) > 18446744073709551615n)) return null;
  if (memoType === "hash" && !/^[0-9a-fA-F]{64}$/.test(memo)) return null;
  if (memoType === "text" && new TextEncoder().encode(memo).length > 28) return null;

  return { username, domain: domain.toLowerCase(), memo, memoType };
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

  const cacheKey = value.trim();
  const cached = addressCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);
  if (cached) addressCache.delete(cacheKey);

  try {
    // If a custom fetch is provided, use it directly to fetch federation endpoint
    if (options.fetchFn) {
      const protocol = options.allowHttp ? "http" : "https";
      const encodedAddress = `${parsed.username}*${parsed.domain}`.replace(
        /\*/g,
        "%2A",
      );
      const url = `${protocol}://${parsed.domain}/.well-known/stellar-federation?stellar_address=${encodedAddress}`;
      const response = await options.fetchFn(url, {});
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
          const resolvedMemo = data.memo ?? parsed.memo;
          const resolvedMemoType = memoType ?? parsed.memoType;
          const resolved: ResolvedAddress = {
            publicKey,
            stellarAddress: cacheKey,
            ...(resolvedMemo !== undefined ? { memo: resolvedMemo } : {}),
            ...(resolvedMemoType !== undefined ? { memoType: resolvedMemoType } : {}),
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
      const resolvedMemo = record.memo ?? parsed.memo;
      const resolvedMemoType = memoType ?? parsed.memoType;
      const resolved: ResolvedAddress = {
        publicKey,
        stellarAddress: cacheKey,
        ...(resolvedMemo !== undefined ? { memo: resolvedMemo } : {}),
        ...(resolvedMemoType !== undefined ? { memoType: resolvedMemoType } : {}),
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
