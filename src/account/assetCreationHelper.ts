import { Asset, Operation } from "@stellar/stellar-sdk";
import { isValidStellarPublicKey } from "./keyRotation";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { validateAssetCode } from "../shared/validation";

type SetFlags = NonNullable<Parameters<typeof Operation.setOptions>[0]["setFlags"]>;

export interface AssetCreationStep {
  order: number;
  title: string;
  detail: string;
}

export interface AssetIssuingPreset {
  asset: Asset;
  /** Operations for the distributor account: trust the asset. */
  distributorOperations: (limit?: string) => ReturnType<typeof Operation.changeTrust>[];
  /** Operations for the issuer account: lock or configure the issuing account. */
  issuerOperations: ReturnType<typeof Operation.setOptions>[];
}

/**
 * Ordered setup steps for issuing an asset. The issuer must be a funded
 * account (minimum reserve) whose key you control. Use a separate distributor
 * account so the issuer key can stay offline.
 */
export function getAssetCreationSteps(issuerKey: string): SorokitResult<AssetCreationStep[]> {
  if (!isValidStellarPublicKey(issuerKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid issuer address: ${issuerKey}`);
  }
  return ok([
    { order: 1, title: "Fund the issuer", detail: `Ensure ${issuerKey} exists and holds the base reserve.` },
    { order: 2, title: "Create a distributor", detail: "Create and fund a second account to hold the supply." },
    { order: 3, title: "Set issuer flags", detail: "Optionally set auth flags (required, revocable) before any trustline exists." },
    { order: 4, title: "Establish trustline", detail: "The distributor adds a trustline to the asset." },
    { order: 5, title: "Issue supply", detail: "Send a payment from the issuer to the distributor (minting is out of scope here)." },
  ]);
}

/** Validate an alphanumeric asset code (1-12 characters). */
export { validateAssetCode };

/** Build the operations preset for issuing `code` from `issuerKey`. */
export function prepareAssetForIssuing(
  code: string,
  issuerKey: string,
  options: { authRequired?: boolean; authRevocable?: boolean } = {},
): SorokitResult<AssetIssuingPreset> {
  const codeCheck = validateAssetCode(code);
  if (codeCheck.status === "error") return err(codeCheck.error.code, codeCheck.error.message);
  if (!isValidStellarPublicKey(issuerKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid issuer address: ${issuerKey}`);
  }
  const asset = new Asset(code, issuerKey);
  let setFlags = 0;
  if (options.authRequired) setFlags |= 1;
  if (options.authRevocable) setFlags |= 2;
  return ok({
    asset,
    distributorOperations: (limit) => [Operation.changeTrust({ asset, ...(limit ? { limit } : {}) })],
    issuerOperations: setFlags ? [Operation.setOptions({ setFlags: setFlags as SetFlags })] : [],
  });
}
