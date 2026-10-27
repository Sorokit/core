import { parse } from "smol-toml";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitLogger } from "../shared/logger";

export interface StellarToml {
  FEDERATION_SERVER?: string;
  AUTH_SERVER?: string;
  TRANSFER_SERVER?: string;
  TRANSFER_SERVER_SEP0024?: string;
  WEB_AUTH_ENDPOINT?: string;
  SIGNING_KEY?: string;
  NETWORK_PASSPHRASE?: string;
  federation_server?: string;
  auth_server?: string;
  transfer_server?: string;
  transfer_server_sep0024?: string;
  web_auth_endpoint?: string;
  signing_key?: string;
  network_passphrase?: string;
  [key: string]: unknown;
}

export interface FetchStellarTomlOptions {
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * When true (the default), a cache hit is verified against a fresh
   * network fetch before being trusted. If the fresh document's
   * SIGNING_KEY or any CURRENCIES issuer diverges from what's cached, the
   * cache is invalidated, a warning is logged, and the fresh (not the
   * stale) document is returned (#837).
   *
   * Set to false to skip verification and always trust a cache hit
   * immediately (the old behavior) — useful for latency-sensitive callers
   * that already re-verify issuer identity another way.
   */
  verifyOnCacheHit?: boolean;
  /** Logger for conflict warnings. Defaults to a no-op logger. */
  logger?: SorokitLogger;
}

/** Extract issuer addresses from a parsed TOML's CURRENCIES table, if present. */
function currencyIssuers(toml: StellarToml): Set<string> {
  const issuers = new Set<string>();
  const currencies = (toml as Record<string, unknown>).CURRENCIES;
  if (!Array.isArray(currencies)) return issuers;
  for (const entry of currencies) {
    if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).issuer === "string") {
      issuers.add((entry as Record<string, unknown>).issuer as string);
    }
  }
  return issuers;
}

/**
 * Detect whether two stellar.toml documents disagree on security-critical
 * fields: the SEP-10 SIGNING_KEY, or any CURRENCIES issuer address (#837).
 * Returns a human-readable description of the conflict, or undefined when
 * the two documents agree on everything checked.
 */
export function detectStellarTomlConflict(
  cached: StellarToml,
  fresh: StellarToml,
): string | undefined {
  if (cached.SIGNING_KEY && fresh.SIGNING_KEY && cached.SIGNING_KEY !== fresh.SIGNING_KEY) {
    return `SIGNING_KEY changed from "${cached.SIGNING_KEY}" to "${fresh.SIGNING_KEY}"`;
  }
  const cachedIssuers = currencyIssuers(cached);
  const freshIssuers = currencyIssuers(fresh);
  for (const issuer of freshIssuers) {
    if (cachedIssuers.size > 0 && !cachedIssuers.has(issuer)) {
      return `CURRENCIES issuer set changed (new issuer "${issuer}" not present in cached document)`;
    }
  }
  for (const issuer of cachedIssuers) {
    if (!freshIssuers.has(issuer)) {
      return `CURRENCIES issuer set changed (previously-cached issuer "${issuer}" is no longer present)`;
    }
  }
  return undefined;
}

export const DEFAULT_STELLAR_TOML_CACHE_TTL_MS = 5 * 60 * 1000;

const tomlCache = new Map<string, { data: StellarToml; expiresAt: number }>();

const NOOP_LOGGER: SorokitLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function domainUrl(domain: string): URL | null {
  if (typeof domain !== "string" || !domain.trim()) return null;
  try {
    const input = /^[a-z][a-z\d+.-]*:\/\//i.test(domain.trim())
      ? domain.trim()
      : `https://${domain.trim()}`;
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeStellarToml(fields: Record<string, unknown>): StellarToml {
  return {
    ...fields,
    ...(typeof fields.FEDERATION_SERVER === "string" ? { federation_server: fields.FEDERATION_SERVER } : {}),
    ...(typeof fields.AUTH_SERVER === "string" ? { auth_server: fields.AUTH_SERVER } : {}),
    ...(typeof fields.TRANSFER_SERVER === "string" ? { transfer_server: fields.TRANSFER_SERVER } : {}),
    ...(typeof fields.TRANSFER_SERVER_SEP0024 === "string" ? { transfer_server_sep0024: fields.TRANSFER_SERVER_SEP0024 } : {}),
    ...(typeof fields.WEB_AUTH_ENDPOINT === "string" ? { web_auth_endpoint: fields.WEB_AUTH_ENDPOINT } : {}),
    ...(typeof fields.SIGNING_KEY === "string" ? { signing_key: fields.SIGNING_KEY } : {}),
    ...(typeof fields.NETWORK_PASSPHRASE === "string" ? { network_passphrase: fields.NETWORK_PASSPHRASE } : {}),
  };
}

export function getCachedStellarToml(domain: string): StellarToml | undefined {
  const url = domainUrl(domain);
  if (!url) return undefined;

  const cacheKey = url.origin.toLowerCase();
  const cached = tomlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (cached) tomlCache.delete(cacheKey);
  return undefined;
}

export function cacheStellarToml(
  domain: string,
  data: StellarToml,
  ttlMs: number = DEFAULT_STELLAR_TOML_CACHE_TTL_MS,
): void {
  const url = domainUrl(domain);
  if (!url || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
  tomlCache.set(url.origin.toLowerCase(), {
    data: normalizeStellarToml(data),
    expiresAt: Date.now() + ttlMs,
  });
}

/** Fetch and parse a stellar.toml document from a single, specific URL path. */
async function fetchStellarTomlAtPath(
  url: URL,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<SorokitResult<StellarToml>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "text/plain, application/toml" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return err(SorokitErrorCode.NETWORK_ERROR, `stellar.toml request failed (${response.status}).`);
    }

    try {
      const parsed: unknown = parse(await response.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The TOML document must contain a table.");
      }
      return ok(normalizeStellarToml(parsed as Record<string, unknown>));
    } catch (cause) {
      return err(SorokitErrorCode.INVALID_CONFIG, "The domain returned invalid stellar.toml.", cause);
    }
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "Failed to fetch stellar.toml.", cause);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Perform the actual network fetch + parse, without touching the cache.
 *
 * SEP-1 requires `/.well-known/stellar.toml`, so that path is tried first.
 * Some domains predating widespread SEP-1 adoption still only serve a bare
 * `/stellar.toml` at the root; rather than fail discovery outright, that
 * legacy path is tried as a fallback when the standard path 404s or errors
 * (#862). The modern path is always preferred when both exist.
 */
async function fetchStellarTomlFresh(
  domain: string,
  baseUrl: URL,
  options: FetchStellarTomlOptions,
): Promise<SorokitResult<StellarToml>> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return err(SorokitErrorCode.NETWORK_ERROR, "Fetch is unavailable in this runtime.");
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return err(SorokitErrorCode.VALIDATION, "Request timeout must be a positive finite number.");
  }

  const wellKnownResult = await fetchStellarTomlAtPath(
    new URL("/.well-known/stellar.toml", baseUrl),
    fetcher,
    timeoutMs,
  );
  if (wellKnownResult.status === "ok") return wellKnownResult;

  return fetchStellarTomlAtPath(new URL("/stellar.toml", baseUrl), fetcher, timeoutMs);
}

/** Fetch and parse a domain's SEP-1 `/.well-known/stellar.toml` document. */
export async function fetchStellarToml(
  domain: string,
  options: FetchStellarTomlOptions = {},
): Promise<SorokitResult<StellarToml>> {
  const baseUrl = domainUrl(domain);
  if (!baseUrl) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "A valid HTTPS domain is required.");
  }

  const ttlMs = options.ttlMs ?? DEFAULT_STELLAR_TOML_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return err(SorokitErrorCode.VALIDATION, "Cache TTL must be a non-negative finite number.");
  }

  const cached = getCachedStellarToml(domain);
  if (cached) {
    const verifyOnCacheHit = options.verifyOnCacheHit ?? true;
    if (!verifyOnCacheHit) return ok(cached);

    // #837: re-verify the cached issuer data against a fresh fetch before
    // trusting it, instead of returning a possibly stale/conflicting
    // cached document indefinitely.
    const fresh = await fetchStellarTomlFresh(domain, baseUrl, options);
    if (fresh.status !== "ok") {
      // The re-verification fetch itself failed (network blip, etc). Fall
      // back to the cached data rather than failing the whole call — the
      // cache has not been proven stale, only unverifiable right now.
      return ok(cached);
    }

    const conflict = detectStellarTomlConflict(cached, fresh.data);
    if (conflict) {
      (options.logger ?? NOOP_LOGGER).warn(
        `stellar.toml for "${domain}" diverged from cached data: ${conflict}. Invalidating cache.`,
        { domain, conflict },
      );
      clearStellarTomlCache(domain);
      cacheStellarToml(domain, fresh.data, ttlMs);
      return ok(fresh.data);
    }

    // No conflict — refresh the cache entry's TTL with the confirmed-fresh
    // data and return it.
    cacheStellarToml(domain, fresh.data, ttlMs);
    return ok(fresh.data);
  }

  const fresh = await fetchStellarTomlFresh(domain, baseUrl, options);
  if (fresh.status !== "ok") return fresh;

  cacheStellarToml(domain, fresh.data, ttlMs);
  return ok(fresh.data);
}

/** Clear all cached stellar.toml documents, or only one domain's entry. */
export function clearStellarTomlCache(domain?: string): void {
  if (domain === undefined) {
    tomlCache.clear();
    return;
  }
  const url = domainUrl(domain);
  if (url) tomlCache.delete(url.origin.toLowerCase());
}