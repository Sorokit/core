/**
 * Pluggable cache interface.
 *
 * sorokit-core is stateless by default.
 * Pass a SorokitCache implementation to createSorokitClient() to enable
 * caching of account/balance data.
 *
 * sorokit-ui ships a React Query adapter.
 * For Node scripts, a simple Map-based implementation is sufficient.
 */
export interface SorokitCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs?: number): void;
  invalidate(key: string): void;
  clear(): void;
}
