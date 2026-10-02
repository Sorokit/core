/**
 * Asset registry and canonical IDs (#614).
 *
 * A single, app-shareable lookup for asset display metadata (name, decimals,
 * logo) keyed by a canonical asset ID (native "XLM", or "CODE:ISSUER" for an
 * issued asset), plus a way to register additional assets a given app cares
 * about.
 *
 * Pre-populated entries are limited to XLM and USDC. XLM's issuer is
 * trivially well-defined (there is none); USDC's mainnet issuer address
 * below was verified directly against Circle's own developer documentation
 * (developers.circle.com/stablecoins/usdc-contract-addresses) at the time
 * this was written. EURC and USDT are deliberately NOT pre-populated:
 * multiple EURC-ticker assets exist on Stellar (Stellar's own asset
 * explorer flags some as fraudulent), and no single canonical Tether-
 * published Stellar issuer exists the way Circle publishes one for USDC —
 * hardcoding either without independent verification would risk an SDK
 * silently vouching for the wrong issuer. Register them yourself via
 * `registerAsset()` with an address you've verified, or once a maintainer
 * supplies a verified address for this file.
 */

import { err, ok, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";
import type { TokenAsset } from "./validateToken";

export interface AssetInfo {
  /** Canonical asset ID: "XLM" for native, "CODE:ISSUER" for an issued asset. */
  id: string;
  code: string;
  issuer: string | null;
  name: string;
  /** Decimal precision for display/formatting purposes (see amountFormatter.ts). */
  decimals: number;
  logo?: string;
}

export type AssetMetadata = Omit<AssetInfo, "id" | "code" | "issuer">;

/** Builds the canonical registry key for an asset: "XLM" for native, "CODE:ISSUER" otherwise. */
export function canonicalAssetId(asset: TokenAsset): string {
  return asset.issuer === null ? "XLM" : `${asset.code}:${asset.issuer}`;
}

const BUILTIN_ASSETS: ReadonlyMap<string, AssetInfo> = new Map(
  [
    {
      id: "XLM",
      code: "XLM",
      issuer: null,
      name: "Stellar Lumens",
      decimals: 7,
    },
    {
      id: `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`,
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      name: "USD Coin",
      decimals: 7,
    },
  ].map((info) => [info.id, info]),
);

/**
 * Per-process registry of caller-supplied assets, layered on top of
 * BUILTIN_ASSETS. A custom registration with the same canonical ID as a
 * built-in asset overrides it (e.g. to attach a logo to USDC), rather than
 * being silently ignored or rejected.
 */
const customAssets = new Map<string, AssetInfo>();

/**
 * Register (or override) an asset's display metadata.
 *
 * @example
 * registerAsset(
 *   { code: "MYTOKEN", issuer: "GABC..." },
 *   { name: "My Token", decimals: 6, logo: "https://example.com/logo.png" },
 * );
 */
export function registerAsset(
  asset: TokenAsset,
  metadata: AssetMetadata,
): SorokitResult<AssetInfo> {
  if (!asset.code || typeof asset.code !== "string") {
    return err(SorokitErrorCode.VALIDATION, "Asset code must be a non-empty string.");
  }
  if (asset.issuer !== null && (typeof asset.issuer !== "string" || asset.issuer.length === 0)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Asset issuer must be null (native) or a non-empty string.",
    );
  }
  if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 20) {
    return err(
      SorokitErrorCode.VALIDATION,
      `decimals must be an integer between 0 and 20, got ${metadata.decimals}.`,
    );
  }
  if (!metadata.name || typeof metadata.name !== "string") {
    return err(SorokitErrorCode.VALIDATION, "Asset metadata must include a non-empty name.");
  }

  const id = canonicalAssetId(asset);
  const info: AssetInfo = {
    id,
    code: asset.code,
    issuer: asset.issuer,
    ...metadata,
  };
  customAssets.set(id, info);
  return ok(info);
}

/**
 * Look up an asset's display metadata: a custom registration first, falling
 * back to the built-in table, then an error if neither has it.
 *
 * @example
 * const info = getAssetInfo({ code: "USDC", issuer: "GA5Z..." });
 * // ok({ name: "USD Coin", decimals: 7, ... })
 */
export function getAssetInfo(asset: TokenAsset): SorokitResult<AssetInfo> {
  const id = canonicalAssetId(asset);
  const found = customAssets.get(id) ?? BUILTIN_ASSETS.get(id);
  if (!found) {
    return err(
      SorokitErrorCode.VALIDATION,
      `No registered metadata for asset "${id}". Call registerAsset() to add it.`,
    );
  }
  return ok(found);
}

/** List every currently-known asset (built-in plus registered), useful for building a picker UI. */
export function listKnownAssets(): AssetInfo[] {
  const merged = new Map(BUILTIN_ASSETS);
  for (const [id, info] of customAssets) merged.set(id, info);
  return Array.from(merged.values());
}

/**
 * Remove a custom registration, reverting lookups for that asset back to
 * the built-in table (or to "not found" if it was never built in). Has no
 * effect on BUILTIN_ASSETS itself — a built-in entry cannot be deleted,
 * only shadowed by re-registering it, or effectively ignored by callers
 * checking `listKnownAssets()` output themselves.
 */
export function unregisterAsset(asset: TokenAsset): boolean {
  return customAssets.delete(canonicalAssetId(asset));
}
