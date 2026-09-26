import { Account, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { validatePublicKey, validateStellarAddress } from "../shared/validation";
import { createHorizonServer } from "../shared/serverFactory";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SetOptionsParams } from "./types";

function validateByte(name: string, value: number | undefined, minimum = 0): SorokitResult<void> {
  if (value === undefined) return ok(undefined);
  if (!Number.isInteger(value) || value < minimum || value > 255) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, `${name} must be an integer between ${minimum} and 255`);
  }
  return ok(undefined);
}

function validateHomeDomain(domain: string | null | undefined): SorokitResult<void> {
  if (domain === undefined || domain === null) return ok(undefined);
  if (domain.length === 0 || domain.length > 32 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "homeDomain must be a valid DNS name of 1-32 characters");
  }
  return ok(undefined);
}

function validateOptionalAddress(name: string, value: string | null | undefined): SorokitResult<void> {
  if (value === undefined || value === null) return ok(undefined);
  const result = validateStellarAddress(value);
  return result.status === "error"
    ? err(SorokitErrorCode.TX_BUILD_FAILED, `${name} must be a valid Stellar public key`)
    : ok(undefined);
}

/** Build an unsigned Stellar Set Options transaction. */
export async function buildSetOptionsTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: SetOptionsParams,
): Promise<SorokitResult<string>> {
  const sourceResult = validatePublicKey(sourcePublicKey);
  if (sourceResult.status === "error") return sourceResult;
  for (const [name, value] of [
    ["masterWeight", params.masterWeight],
    ["lowThreshold", params.lowThreshold],
    ["medThreshold", params.medThreshold],
    ["highThreshold", params.highThreshold],
  ] as const) {
    const result = validateByte(name, value);
    if (result.status === "error") return result;
  }
  if (params.lowThreshold !== undefined && params.medThreshold !== undefined && params.lowThreshold > params.medThreshold) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "lowThreshold must be less than or equal to medThreshold");
  }
  if (params.medThreshold !== undefined && params.highThreshold !== undefined && params.medThreshold > params.highThreshold) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "medThreshold must be less than or equal to highThreshold");
  }
  const domainResult = validateHomeDomain(params.homeDomain);
  if (domainResult.status === "error") return domainResult;
  const inflationResult = validateOptionalAddress("inflationDest", params.inflationDest);
  if (inflationResult.status === "error") return inflationResult;
  for (const signer of params.signers ?? []) {
    const keyResult = validatePublicKey(signer.publicKey);
    if (keyResult.status === "error") return keyResult;
    const weightResult = validateByte("signer weight", signer.weight, 1);
    if (weightResult.status === "error") return weightResult;
  }

  try {
    const sourceAccount = params.sequenceNumber
      ? new Account(sourcePublicKey, params.sequenceNumber)
      : await createHorizonServer(horizonUrl).loadAccount(sourcePublicKey);
    const builder = new TransactionBuilder(sourceAccount, {
      fee: params.estimatedFee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });
    const operation: Parameters<typeof Operation.setOptions>[0] = {
      ...(params.masterWeight !== undefined && { masterWeight: params.masterWeight }),
      ...(params.lowThreshold !== undefined && { lowThreshold: params.lowThreshold }),
      ...(params.medThreshold !== undefined && { medThreshold: params.medThreshold }),
      ...(params.highThreshold !== undefined && { highThreshold: params.highThreshold }),
      ...(params.homeDomain !== undefined && { homeDomain: params.homeDomain ?? "" }),
      ...(params.inflationDest != null && { inflationDest: params.inflationDest }),
      ...(params.clearFlags !== undefined && { clearFlags: params.clearFlags as NonNullable<Parameters<typeof Operation.setOptions>[0]["clearFlags"]> }),
    };
    const signers = params.signers ?? [];
    if (Object.keys(operation).length > 0) {
      builder.addOperation(Operation.setOptions(operation));
    }
    for (const signer of signers) {
      builder.addOperation(Operation.setOptions({
        signer: { ed25519PublicKey: signer.publicKey, weight: signer.weight },
      }));
    }
    return ok(builder.setTimeout(0).build().toXDR());
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, `Failed to build set options transaction: ${toMessage(cause)}`, cause);
  }
}
