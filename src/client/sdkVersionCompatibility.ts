import type { SorokitLogger } from "../shared/logger";

/**
 * The @stellar/stellar-sdk version this SDK was built and tested against.
 * Keep in sync with package.json's own peerDependencies entry (currently
 * pinned to an exact version, not a range): both must change together when
 * this SDK adopts a new stellar-sdk release.
 */
export const SUPPORTED_STELLAR_SDK_VERSION = "13.3.0";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a `major.minor.patch` version string, ignoring any
 * prerelease/build metadata suffix (e.g. `13.3.0-beta.1` parses the same as
 * `13.3.0`). Returns `null` for anything that doesn't start with three
 * dot-separated non-negative integers.
 */
export function parseSemverCore(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export type StellarSdkCompatibility =
  | { status: "compatible" }
  | { status: "unknown"; reason: string }
  | {
      status: "incompatible";
      kind: "major-mismatch" | "newer-minor" | "older-than-supported";
      installedVersion: string;
      supportedVersion: string;
      message: string;
    };

/**
 * Compares an installed `@stellar/stellar-sdk` version against the version
 * this SDK was built against (#865).
 *
 * This SDK's package.json pins an exact peer version rather than a range,
 * so npm itself normally catches a mismatch at install time, but that
 * protection is silently bypassed by `--legacy-peer-deps` (which this
 * repo's own CI pipeline uses) or by a nested duplicate install of a
 * different major version elsewhere in the dependency tree. This check
 * catches both at runtime instead of letting a consumer hit confusing,
 * version-skew-caused failures with no clear diagnostic.
 *
 * A major version difference is always `incompatible` (the installed
 * version's types/API shape cannot be assumed compatible across a major
 * bump). An installed version strictly older than supported is also
 * `incompatible` (this SDK may call APIs that don't exist yet in the older
 * version). An installed minor/patch newer than supported within the same
 * major is `incompatible` with kind `newer-minor` but framed as a
 * lower-severity warning by the caller (see `checkStellarSdkVersionCompatibility`),
 * since same-major newer releases are usually additive, not breaking.
 *
 * There is deliberately no attempt here to read the installed version from
 * `node_modules` automatically: @stellar/stellar-sdk's package.json is not
 * reachable through its own `exports` map (`./package.json` is absent from
 * it), so `require("@stellar/stellar-sdk/package.json")` throws under
 * strict Node ESM/CJS resolution and an equivalent dynamic `import()`
 * fails identically; confirmed directly against the installed package,
 * not assumed. The caller supplies `installedVersion` however suits their
 * own module resolution (e.g. `require("@stellar/stellar-sdk/package.json").version`
 * works in a plain Node/CJS entry point even though it is not usable from
 * inside this bundled SDK itself, or a build-time-injected constant for
 * bundled browser code).
 */
export function compareStellarSdkVersion(
  installedVersion: string | undefined,
  supportedVersion: string = SUPPORTED_STELLAR_SDK_VERSION,
): StellarSdkCompatibility {
  if (!installedVersion) {
    return {
      status: "unknown",
      reason: "No installed @stellar/stellar-sdk version was supplied to check against.",
    };
  }

  const installed = parseSemverCore(installedVersion);
  const supported = parseSemverCore(supportedVersion);
  if (!installed || !supported) {
    return {
      status: "unknown",
      reason: `Could not parse version "${installedVersion}" or "${supportedVersion}" as major.minor.patch.`,
    };
  }

  if (installed.major !== supported.major) {
    return {
      status: "incompatible",
      kind: "major-mismatch",
      installedVersion,
      supportedVersion,
      message:
        `Installed @stellar/stellar-sdk@${installedVersion} has a different major version than the ` +
        `@stellar/stellar-sdk@${supportedVersion} this SDK was built against. A major version ` +
        `difference may change exported types, class shapes, or method signatures this SDK relies on.`,
    };
  }

  if (
    installed.minor < supported.minor ||
    (installed.minor === supported.minor && installed.patch < supported.patch)
  ) {
    return {
      status: "incompatible",
      kind: "older-than-supported",
      installedVersion,
      supportedVersion,
      message:
        `Installed @stellar/stellar-sdk@${installedVersion} is older than the ` +
        `@stellar/stellar-sdk@${supportedVersion} this SDK was built against. This SDK may call an ` +
        `API that does not exist yet in the installed version.`,
    };
  }

  if (
    installed.minor > supported.minor ||
    (installed.minor === supported.minor && installed.patch > supported.patch)
  ) {
    return {
      status: "incompatible",
      kind: "newer-minor",
      installedVersion,
      supportedVersion,
      message:
        `Installed @stellar/stellar-sdk@${installedVersion} is newer than the ` +
        `@stellar/stellar-sdk@${supportedVersion} this SDK was built against. Same-major releases are ` +
        `usually additive, so this is unlikely to break anything, but has not been tested against ` +
        `this SDK's test suite.`,
    };
  }

  return { status: "compatible" };
}

/**
 * Runs `compareStellarSdkVersion` and logs a warning for any non-compatible
 * result (#865). Does not throw: a version mismatch is a diagnostic aid,
 * not a hard failure, since many mismatches (especially `newer-minor`) are
 * harmless in practice.
 *
 * @example
 * import { createRequire } from "node:module";
 * const require = createRequire(import.meta.url);
 * // Works from a plain application entry point's own module resolution,
 * // even though it cannot be done from inside this SDK (see
 * // compareStellarSdkVersion's own doc comment for why).
 * const installedVersion = require("@stellar/stellar-sdk/package.json").version;
 *
 * checkStellarSdkVersionCompatibility(installedVersion, { logger: myLogger });
 */
export function checkStellarSdkVersionCompatibility(
  installedVersion: string | undefined,
  options: { supportedVersion?: string; logger?: SorokitLogger } = {},
): StellarSdkCompatibility {
  const result = compareStellarSdkVersion(installedVersion, options.supportedVersion);
  if (result.status === "incompatible") {
    options.logger?.warn(result.message, {
      installedVersion: result.installedVersion,
      supportedVersion: result.supportedVersion,
      kind: result.kind,
    });
  }
  return result;
}
