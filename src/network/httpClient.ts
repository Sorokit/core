import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface HttpClientOptions { fetchFn?: typeof fetch; now?: () => number; }
interface CachedResponse { expiresAt: number; response: Response; }
export interface HttpClient { request(url: string, init?: RequestInit): Promise<SorokitResult<Response>>; get(url: string, init?: RequestInit): Promise<SorokitResult<Response>>; clear(): void; }
function maxAge(value: string | null): number | null { const match = value?.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i); return match ? Number(match[1]) * 1000 : null; }

/** Fetch successful GET responses when Cache-Control supplies a positive max-age. */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const fetchFn = options.fetchFn ?? (typeof fetch === "undefined" ? undefined : fetch);
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedResponse>();
  const request = async (url: string, init: RequestInit = {}): Promise<SorokitResult<Response>> => {
    if (!fetchFn) return err(SorokitErrorCode.NETWORK_ERROR, "No fetch implementation available");
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method}:${url}`;
    if (method === "GET") { const cached = cache.get(key); if (cached && cached.expiresAt > now()) return ok(cached.response.clone()); cache.delete(key); }
    try {
      const response = await fetchFn(url, init);
      const ttl = response.ok && method === "GET" ? maxAge(response.headers.get("Cache-Control")) : null;
      if (ttl !== null && ttl > 0) cache.set(key, { response: response.clone(), expiresAt: now() + ttl });
      return ok(response);
    } catch (cause) { return err(SorokitErrorCode.NETWORK_ERROR, cause instanceof Error ? cause.message : String(cause), cause); }
  };
  return { request, get: (url, init) => request(url, { ...init, method: "GET" }), clear: () => cache.clear() };
}
export function parseCacheControlMaxAge(value: string | null): number | null { const ttl = maxAge(value); return ttl === null ? null : ttl / 1000; }
