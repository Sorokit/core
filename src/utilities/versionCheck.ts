/**
 * SDK Version Check Utility — Warn if Outdated (#968)
 *
 * Compares running SDK version against the latest published version on npm registry
 * with response caching to avoid excessive network traffic.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface SdkVersionInfo {
  currentVersion: string;
  latestVersion: string;
  isOutdated: boolean;
  warning?: string | undefined;
  checkedAt: number;
}

export interface SdkVersionCheckOptions {
  packageName?: string | undefined;
  currentVersion?: string | undefined;
  cacheTtlMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  onOutdated?: ((info: SdkVersionInfo) => void) | undefined;
}

export const CURRENT_SDK_VERSION = "0.1.0";
export const DEFAULT_PACKAGE_NAME = "sorokit-core";
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedVersionInfo: { info: SdkVersionInfo; expiresAt: number } | null = null;

function compareVersions(v1: string, v2: string): number {
  const p1 = v1.replace(/^[^0-9]*/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const p2 = v2.replace(/^[^0-9]*/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const max = Math.max(p1.length, p2.length);
  for (let i = 0; i < max; i++) {
    const a = p1[i] ?? 0;
    const b = p2[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Check whether the running SDK version is up to date against npm registry.
 */
export async function checkSdkVersion(
  options?: SdkVersionCheckOptions,
): Promise<SorokitResult<SdkVersionInfo>> {
  try {
    const now = Date.now();
    const ttl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

    if (cachedVersionInfo && cachedVersionInfo.expiresAt > now) {
      return ok(cachedVersionInfo.info);
    }

    const currentVersion = options?.currentVersion ?? CURRENT_SDK_VERSION;
    const pkg = options?.packageName ?? DEFAULT_PACKAGE_NAME;
    const fetchFn = options?.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);

    let latestVersion = currentVersion;

    if (fetchFn) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetchFn(`https://registry.npmjs.org/${pkg}/latest`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        clearTimeout(timeout);

        if (resp.ok) {
          const data = (await resp.json()) as { version?: string };
          if (data && typeof data.version === "string") {
            latestVersion = data.version;
          }
        }
      } catch {
        // Fallback silently if offline or blocked
      }
    }

    const isOutdated = compareVersions(currentVersion, latestVersion) < 0;
    let warning: string | undefined;

    if (isOutdated) {
      warning = `Warning: running ${pkg}@${currentVersion} is outdated. Latest version is ${latestVersion}. Please run 'npm update ${pkg}' to receive the latest security fixes and features.`;
      if (typeof console !== "undefined" && console.warn) {
        console.warn(warning);
      }
    }

    const info: SdkVersionInfo = {
      currentVersion,
      latestVersion,
      isOutdated,
      checkedAt: now,
      ...(warning ? { warning } : {}),
    };

    if (options?.onOutdated && isOutdated) {
      options.onOutdated(info);
    }

    cachedVersionInfo = {
      info,
      expiresAt: now + ttl,
    };

    return ok(info);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      cause instanceof Error ? cause.message : "Error checking SDK version",
      cause,
    );
  }
}

export function clearSdkVersionCache(): void {
  cachedVersionInfo = null;
}
