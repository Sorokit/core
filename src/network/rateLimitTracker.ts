import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface RateLimitUsage { endpoint: string; requests: number; responses: number; limit: number | null; remaining: number | null; resetAt: number | null; lastUpdatedAt: number | null; }
export interface RateLimitTrackerOptions { warningThreshold?: number; onWarning?: (usage: RateLimitUsage) => void; }
type HeaderSource = Headers | Record<string, string | undefined>;
function header(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : record[key] ?? null;
}
function numberHeader(headers: HeaderSource, names: string[], minimum: number): number | null {
  for (const name of names) { const value = header(headers, name); if (value !== null) { const parsed = Number(value); if (Number.isFinite(parsed) && parsed >= minimum) return parsed; } }
  return null;
}
function copy(usage: RateLimitUsage): RateLimitUsage { return { ...usage }; }
/** Tracks server-reported request quotas without enforcing them. */
export class RateLimitTracker {
  private readonly usages = new Map<string, RateLimitUsage>();
  private readonly warningThreshold: number;
  constructor(private readonly options: RateLimitTrackerOptions = {}) { this.warningThreshold = Math.min(1, Math.max(0, options.warningThreshold ?? 0.1)); }
  private get(endpoint: string): RateLimitUsage { const existing = this.usages.get(endpoint); if (existing) return existing; const created: RateLimitUsage = { endpoint, requests: 0, responses: 0, limit: null, remaining: null, resetAt: null, lastUpdatedAt: null }; this.usages.set(endpoint, created); return created; }
  recordRequest(endpoint: string): RateLimitUsage { const usage = this.get(endpoint); usage.requests += 1; return copy(usage); }
  recordResponse(endpoint: string, headers: HeaderSource): RateLimitUsage { const usage = this.get(endpoint); usage.responses += 1; usage.limit = numberHeader(headers, ["x-ratelimit-limit", "x-rate-limit-limit"], 1) ?? usage.limit; usage.remaining = numberHeader(headers, ["x-ratelimit-remaining", "x-rate-limit-remaining"], 0) ?? usage.remaining; const reset = numberHeader(headers, ["x-ratelimit-reset", "x-rate-limit-reset"], 1); if (reset !== null) usage.resetAt = reset > 1e12 ? reset : Date.now() + reset * 1000; usage.lastUpdatedAt = Date.now(); const result = copy(usage); if (usage.limit !== null && usage.remaining !== null && usage.remaining / usage.limit <= this.warningThreshold) this.options.onWarning?.(result); return result; }
  getUsage(endpoint: string): SorokitResult<RateLimitUsage> { return ok(copy(this.get(endpoint))); }
  getRemainingRequests(endpoint: string): number | null { return this.get(endpoint).remaining; }
  reset(endpoint?: string): void { endpoint === undefined ? this.usages.clear() : this.usages.delete(endpoint); }
}
export function createRateLimitTracker(options?: RateLimitTrackerOptions): RateLimitTracker { return new RateLimitTracker(options); }
