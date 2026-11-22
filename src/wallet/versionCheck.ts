/**
 * Wallet Upgrade Helper — Detect Outdated Wallet Versions (#1005)
 *
 * Compares connected wallet extensions against minimum supported versions
 * and produces actionable warnings to avoid compatibility issues.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface VersionInfo {
  wallet: string;
  detectedVersion: string;
  minimumVersion: string;
  isSupported: boolean;
  isOutdated: boolean;
  warning?: string;
  upgradeUrl?: string;
}

export interface WalletVersionTarget {
  name?: string;
  walletType?: string;
  version?: string;
  [key: string]: unknown;
}

/** Minimum supported extension / client versions by wallet type */
export const MINIMUM_WALLET_VERSIONS: Record<string, string> = {
  freighter: "5.0.0",
  xbull: "0.5.0",
  lobstr: "1.0.0",
  hana: "1.0.0",
  albedo: "0.10.0",
  rabet: "1.0.0",
};

/** Official upgrade links */
export const WALLET_UPGRADE_URLS: Record<string, string> = {
  freighter: "https://www.freighter.app/",
  xbull: "https://xbull.app/",
  lobstr: "https://lobstr.co/",
  hana: "https://hanawallet.io/",
  albedo: "https://albedo.link/",
  rabet: "https://rabet.io/",
};

/**
 * Compare two semantic version strings (e.g. "1.2.3" vs "1.2.0").
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 === v2
 */
export function compareSemver(v1: string, v2: string): number {
  const clean = (v: string) => v.replace(/^[^0-9]*/, "").split(/[-+]/)[0] ?? "";
  const parts1 = clean(v1).split(".").map((n) => parseInt(n, 10) || 0);
  const parts2 = clean(v2).split(".").map((n) => parseInt(n, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Check a wallet's version against the minimum supported version.
 */
export function checkWalletVersion(
  wallet: string | WalletVersionTarget,
  explicitVersion?: string,
  minVersions: Record<string, string> = MINIMUM_WALLET_VERSIONS,
): SorokitResult<VersionInfo> {
  try {
    let walletName = "";
    let detectedVersion = explicitVersion ?? "";

    if (typeof wallet === "string") {
      walletName = wallet.toLowerCase().trim();
    } else if (wallet && typeof wallet === "object") {
      walletName = (wallet.walletType ?? wallet.name ?? "").toLowerCase().trim();
      if (!detectedVersion && typeof wallet.version === "string") {
        detectedVersion = wallet.version;
      }
    }

    if (!walletName) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Cannot check wallet version: wallet name or type is required",
      );
    }

    const minVersion = minVersions[walletName] ?? "1.0.0";
    const upgradeUrl = WALLET_UPGRADE_URLS[walletName];

    if (!detectedVersion) {
      return ok({
        wallet: walletName,
        detectedVersion: "unknown",
        minimumVersion: minVersion,
        isSupported: true,
        isOutdated: false,
        warning: `Could not detect installed version for ${walletName}. Assuming compatible.`,
        ...(upgradeUrl ? { upgradeUrl } : {}),
      });
    }

    const cmp = compareSemver(detectedVersion, minVersion);
    const isOutdated = cmp < 0;

    let warning: string | undefined;
    if (isOutdated) {
      warning = `Wallet ${walletName} version ${detectedVersion} is below minimum supported version ${minVersion}. Please upgrade your wallet extension to prevent compatibility issues.`;
    }

    return ok({
      wallet: walletName,
      detectedVersion,
      minimumVersion: minVersion,
      isSupported: !isOutdated,
      isOutdated,
      ...(warning ? { warning } : {}),
      ...(upgradeUrl ? { upgradeUrl } : {}),
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      cause instanceof Error ? cause.message : "Error checking wallet version",
      cause,
    );
  }
}
