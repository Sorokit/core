import { parse } from "smol-toml";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

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
}

export const DEFAULT_STELLAR_TOML_CACHE_TTL_MS = 5 * 60 * 1000;

const tomlCache = new Map<string, { data: StellarToml; expiresAt: number }>();

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

  const cacheKey = baseUrl.origin.toLowerCase();
  const cached = tomlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.data);
  if (cached) tomlCache.delete(cacheKey);

  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return err(SorokitErrorCode.NETWORK_ERROR, "Fetch is unavailable in this runtime.");
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return err(SorokitErrorCode.VALIDATION, "Request timeout must be a positive finite number.");
  }

  const url = new URL("/.well-known/stellar.toml", baseUrl);
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

    let data: StellarToml;
    try {
      const parsed: unknown = parse(await response.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The TOML document must contain a table.");
      }
      const fields = parsed as Record<string, unknown>;
      data = {
        ...fields,
        ...(typeof fields.FEDERATION_SERVER === "string" ? { federation_server: fields.FEDERATION_SERVER } : {}),
        ...(typeof fields.AUTH_SERVER === "string" ? { auth_server: fields.AUTH_SERVER } : {}),
        ...(typeof fields.TRANSFER_SERVER === "string" ? { transfer_server: fields.TRANSFER_SERVER } : {}),
        ...(typeof fields.TRANSFER_SERVER_SEP0024 === "string" ? { transfer_server_sep0024: fields.TRANSFER_SERVER_SEP0024 } : {}),
        ...(typeof fields.WEB_AUTH_ENDPOINT === "string" ? { web_auth_endpoint: fields.WEB_AUTH_ENDPOINT } : {}),
        ...(typeof fields.SIGNING_KEY === "string" ? { signing_key: fields.SIGNING_KEY } : {}),
        ...(typeof fields.NETWORK_PASSPHRASE === "string" ? { network_passphrase: fields.NETWORK_PASSPHRASE } : {}),
      };
    } catch (cause) {
      return err(SorokitErrorCode.INVALID_CONFIG, "The domain returned invalid stellar.toml.", cause);
    }

    if (ttlMs > 0) tomlCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
    return ok(data);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "Failed to fetch stellar.toml.", cause);
  } finally {
    clearTimeout(timer);
  }
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