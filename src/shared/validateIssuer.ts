import { SorokitErrorCode } from "./response";

/**
 * Validates an asset issuer against the trusted issuers whitelist.
 * If no whitelist is configured, all issuers are allowed (backward compatible).
 *
 * @param issuer - The asset issuer address to validate
 * @param trustedIssuers - Optional whitelist of trusted issuer addresses
 * @throws Error with code TX_BUILD_FAILED if issuer is not whitelisted
 */
export function validateIssuer(issuer: string, trustedIssuers: string[] | null): void {
  if (trustedIssuers === null || trustedIssuers.length === 0) {
    return; // no whitelist configured — allow all (backward compatible)
  }

  if (!trustedIssuers.includes(issuer)) {
    throw Object.assign(
      new Error(`Asset issuer ${issuer} is not in the trusted issuers whitelist`),
      { code: SorokitErrorCode.TX_BUILD_FAILED },
    );
  }
}
