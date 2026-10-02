/**
 * Stellar Federation Resolution with Identity Verification and Caching (#517)
 *
 * Implements federation resolution utilities that parse federation addresses,
 * query the configured federation service, validate the response, and cache successful lookups.
 */

import { ok, err, SorokitResult, SorokitErrorCode } from "../shared/response";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FederationAddress {
  name: string;
  domain: string;
  memo?: string | null;
}

export interface FederationResponse {
  account_id: string;
  memo_type?: "id" | "text" | "hash" | "none";
  memo?: string;
}

export interface ResolvedFederationAddress {
  accountId: string;
  memoType?: "id" | "text" | "hash" | "none";
  memo?: string;
  federationDomain: string;
  originalAddress: string;
}

export interface FederationResolverConfig {
  defaultTtlMs?: number;
  enableCache?: boolean;
  maxCacheSize?: number;
  timeoutMs?: number;
}

interface CacheEntry {
  resolved: ResolvedFederationAddress;
  timestamp: number;
}

// ─── Federation Address Parsing ─────────────────────────────────────────────────

const FEDERATION_ADDRESS_REGEX = /^([^*]+)\*([^*]+)(?:\*([^*]+))?$/;

export function parseFederationAddress(
  address: string,
): SorokitResult<FederationAddress> {
  if (!address || typeof address !== "string") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Federation address must be a non-empty string",
    );
  }

  const match = address.match(FEDERATION_ADDRESS_REGEX);
  if (!match) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid federation address format: ${address}. Expected format: name*domain or name*domain*memo`,
    );
  }

  const [, name, domain, memo] = match;

  // Validate domain
  if (!domain || !domain.includes(".")) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid federation domain: ${domain}`,
    );
  }

  // Validate name
  if (!name || name.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid federation name: ${name}`,
    );
  }

  return ok({
    name,
    domain,
    memo: memo || null,
  });
}

function formatFederationAddress(
  address: FederationAddress,
): string {
  if (address.memo) {
    return `${address.name}*${address.domain}*${address.memo}`;
  }
  return `${address.name}*${address.domain}`;
}

// ─── Federation Query ─────────────────────────────────────────────────────────

export class FederationResolver {
  private cache: Map<string, CacheEntry>;
  private config: Required<FederationResolverConfig>;

  constructor(config: FederationResolverConfig = {}) {
    this.cache = new Map();
    this.config = {
      defaultTtlMs: config.defaultTtlMs ?? 5 * 60 * 1000, // 5 minutes
      enableCache: config.enableCache ?? true,
      maxCacheSize: config.maxCacheSize ?? 1000,
      timeoutMs: config.timeoutMs ?? 10000, // 10 seconds
    };
  }

  /**
   * Resolve a federation address to account information
   */
  async resolveAddress(
    federationAddress: string,
  ): Promise<SorokitResult<ResolvedFederationAddress>> {
    // Parse the address
    const parseResult = parseFederationAddress(federationAddress);
    if (parseResult.status === "error") {
      return parseResult;
    }

    const parsed = parseResult.data;

    // Check cache first
    if (this.config.enableCache) {
      const cached = this.getCached(federationAddress);
      if (cached) {
        return ok(cached);
      }
    }

    // Build federation URL
    const federationUrl = `https://${parsed.domain}/.well-known/stellar.toml`;
    
    try {
      // Fetch stellar.toml to get federation server
      const stellarTomlResponse = await this.fetchWithTimeout(
        federationUrl,
        this.config.timeoutMs,
      );

      if (!stellarTomlResponse.ok) {
        return err(
          SorokitErrorCode.NETWORK_ERROR,
          `Failed to fetch stellar.toml from ${parsed.domain}`,
        );
      }

      const stellarTomlText = await stellarTomlResponse.text();
      const federationServer = this.extractFederationServer(stellarTomlText);

      if (!federationServer) {
        return err(
          SorokitErrorCode.VALIDATION,
          `No federation server found in stellar.toml for ${parsed.domain}`,
        );
      }

      // Query federation server
      const queryUrl = new URL(federationServer);
      queryUrl.searchParams.set("type", "name");
      queryUrl.searchParams.set("q", federationAddress);

      const queryResponse = await this.fetchWithTimeout(
        queryUrl.toString(),
        this.config.timeoutMs,
      );

      if (!queryResponse.ok) {
        return err(
          SorokitErrorCode.NETWORK_ERROR,
          `Federation query failed for ${federationAddress}`,
        );
      }

      const federationData: FederationResponse = await queryResponse.json();

      // Validate response
      const validationResult = this.validateFederationResponse(
        federationData,
        parsed,
      );
      if (validationResult.status === "error") {
        return validationResult;
      }

      const resolved: ResolvedFederationAddress = {
        accountId: federationData.account_id,
        ...(federationData.memo_type !== undefined && federationData.memo_type !== "none"
          ? { memoType: federationData.memo_type }
          : {}),
        ...(federationData.memo !== undefined ? { memo: federationData.memo } : {}),
        federationDomain: parsed.domain,
        originalAddress: federationAddress,
      };

      // Cache the result
      if (this.config.enableCache) {
        this.setCache(federationAddress, resolved);
      }

      return ok(resolved);
    } catch (error) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `Failed to resolve federation address: ${federationAddress}`,
        error,
      );
    }
  }

  /**
   * Extract federation server URL from stellar.toml
   */
  private extractFederationServer(stellarToml: string): string | null {
    const federationMatch = stellarToml.match(
      /FEDERATION_SERVER\s*=\s*["']([^"']+)["']/,
    );
    return federationMatch && federationMatch[1] ? federationMatch[1] : null;
  }

  /**
   * Validate federation response against the requested address
   */
  private validateFederationResponse(
    response: FederationResponse,
    parsed: FederationAddress,
  ): SorokitResult<void> {
    if (!response.account_id) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Federation response missing account_id",
      );
    }

    // Validate Stellar public key format
    if (!this.isValidStellarAddress(response.account_id)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Invalid account_id in federation response: ${response.account_id}`,
      );
    }

    // Validate memo type if present
    if (response.memo_type && !["id", "text", "hash", "none"].includes(response.memo_type)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Invalid memo_type in federation response: ${response.memo_type}`,
      );
    }

    // If memo is present, memo_type should not be "none"
    if (response.memo !== undefined && response.memo_type === "none") {
      return err(
        SorokitErrorCode.VALIDATION,
        "Memo present but memo_type is 'none'",
      );
    }

    return ok(undefined);
  }

  /**
   * Check if a string is a valid Stellar address
   */
  private isValidStellarAddress(address: string): boolean {
    // Stellar public keys are 56 characters starting with 'G'
    if (typeof address !== "string" || address.length !== 56) {
      return false;
    }
    return address.startsWith("G") && /^[A-Z0-9]+$/.test(address);
  }

  /**
   * Fetch with timeout
   */
  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get cached resolution
   */
  private getCached(address: string): ResolvedFederationAddress | null {
    const entry = this.cache.get(address);
    if (!entry) return null;

    const isExpired = Date.now() - entry.timestamp > this.config.defaultTtlMs;
    if (isExpired) {
      this.cache.delete(address);
      return null;
    }

    return entry.resolved;
  }

  /**
   * Set cached resolution
   */
  private setCache(address: string, resolved: ResolvedFederationAddress): void {
    // Enforce max cache size
    if (this.cache.size >= this.config.maxCacheSize) {
      // Remove oldest entry (simple FIFO)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(address, {
      resolved,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear cache for a specific address or all addresses
   */
  clearCache(address?: string): void {
    if (address) {
      this.cache.delete(address);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Invalidate cache entries older than a given timestamp
   */
  invalidateCacheOlderThan(timestamp: number): void {
    const toDelete: string[] = [];
    this.cache.forEach((entry, key) => {
      if (entry.timestamp < timestamp) {
        toDelete.push(key);
      }
    });
    toDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    ttlMs: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize,
      ttlMs: this.config.defaultTtlMs,
    };
  }

  /**
   * Verify identity using federation metadata if available
   */
  async verifyIdentity(
    federationAddress: string,
  ): Promise<SorokitResult<{ verified: boolean; metadata?: Record<string, unknown> }>> {
    const resolveResult = await this.resolveAddress(federationAddress);
    if (resolveResult.status === "error") {
      return resolveResult;
    }

    const resolved = resolveResult.data;

    try {
      // Fetch stellar.toml for identity verification
      const stellarTomlUrl = `https://${resolved.federationDomain}/.well-known/stellar.toml`;
      const response = await this.fetchWithTimeout(
        stellarTomlUrl,
        this.config.timeoutMs,
      );

      if (!response.ok) {
        return ok({ verified: false });
      }

      const stellarTomlText = await response.text();
      const metadata = this.extractIdentityMetadata(stellarTomlText);

      return ok({
        verified: true,
        metadata,
      });
    } catch (error) {
      // Verification failure doesn't mean the address is invalid
      return ok({ verified: false });
    }
  }

  /**
   * Extract identity metadata from stellar.toml
   */
  private extractIdentityMetadata(stellarToml: string): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    // Extract common identity fields
    const fields = [
      "ORGANIZATION_NAME",
      "ORGANIZATION_URL",
      "ORGANIZATION_LOGO",
      "ORGANIZATION_TWITTER",
      "ORGANIZATION_GITHUB",
      "ORGANIZATION_KEYBASE",
      "ORGANIZATION_EMAIL",
    ];

    fields.forEach((field) => {
      const match = stellarToml.match(new RegExp(`${field}\\s*=\\s*["']([^"']+)["']`));
      if (match) {
        metadata[field] = match[1];
      }
    });

    return metadata;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

const defaultResolver = new FederationResolver();

export function createFederationResolver(
  config?: FederationResolverConfig,
): FederationResolver {
  return new FederationResolver(config);
}

export function getDefaultFederationResolver(): FederationResolver {
  return defaultResolver;
}

// ─── Convenience Functions ─────────────────────────────────────────────────────

/**
 * Resolve a federation address using the default resolver
 */
export async function resolveAddress(
  federationAddress: string,
): Promise<SorokitResult<ResolvedFederationAddress>> {
  return defaultResolver.resolveAddress(federationAddress);
}

/**
 * Clear federation cache
 */
export function clearFederationCache(address?: string): void {
  defaultResolver.clearCache(address);
}

/**
 * Verify identity for a federation address
 */
export async function verifyIdentity(
  federationAddress: string,
): Promise<SorokitResult<{ verified: boolean; metadata?: Record<string, unknown> }>> {
  return defaultResolver.verifyIdentity(federationAddress);
}
