/**
 * Shared sequence number cache for account prefetching.
 * Used by both account module (prefetchSequence) and transaction builders.
 */

const SEQUENCE_CACHE_TTL_MS = 30_000; // 30 seconds

interface SequenceCacheEntry {
  sequence: string;
  cachedAt: number;
}

const _sequenceCache = new Map<string, SequenceCacheEntry>();

/**
 * Get a cached sequence number for a public key.
 * Returns null if not cached or expired.
 */
export function getCachedSequence(publicKey: string): string | null {
  const entry = _sequenceCache.get(publicKey);
  if (!entry || Date.now() - entry.cachedAt > SEQUENCE_CACHE_TTL_MS) {
    _sequenceCache.delete(publicKey);
    return null;
  }
  return entry.sequence;
}

/**
 * Cache a sequence number for a public key.
 */
export function cacheSequence(publicKey: string, sequence: string): void {
  _sequenceCache.set(publicKey, {
    sequence,
    cachedAt: Date.now(),
  });
}

/**
 * Clear the sequence cache. Useful for test isolation.
 */
export function clearSequenceCache(): void {
  _sequenceCache.clear();
}

/**
 * Get the cache TTL in milliseconds.
 */
export function getSequenceCacheTtl(): number {
  return SEQUENCE_CACHE_TTL_MS;
}

/**
 * Internal cache accessor for testing purposes only.
 */
export function _getSequenceCacheForTesting(): Map<
  string,
  SequenceCacheEntry
> {
  return _sequenceCache;
}
