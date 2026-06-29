import { Horizon } from "@stellar/stellar-sdk";
import {
  isValidPublicKey,
  isNotFoundError,
  toMessage,
  retryWithBackoff,
  ok,
  err,
  SorokitErrorCode,
} from "../shared";
import type { SorokitResult } from "../shared";

export interface DestinationValidationResult {
  valid: boolean;
  formatValid: boolean;
  isSource: boolean;
  exists: boolean | null;
  error?: {
    code: "INVALID_FORMAT" | "SAME_AS_SOURCE" | "ACCOUNT_NOT_FOUND" | "FETCH_FAILED";
    message: string;
  };
}

export interface ValidateDestinationOptions {
  source?: string;
  checkExists?: boolean;
  horizonUrl?: string;
}

/**
 * Validate a destination address before building a transaction.
 *
 * Checks:
 * 1. Valid format (starts with G and has 56 characters)
 * 2. Different from source address (if provided)
 * 3. Account exists on-chain (optional, requires horizonUrl)
 *
 * @param publicKey - The destination public key to validate.
 * @param options - Optional validation settings.
 * @returns A detailed validation report.
 */
export async function validateDestination(
  publicKey: string,
  options?: ValidateDestinationOptions,
): Promise<SorokitResult<DestinationValidationResult>> {
  // 1. Validate public key format
  if (!isValidPublicKey(publicKey)) {
    return ok({
      valid: false,
      formatValid: false,
      isSource: false,
      exists: null,
      error: {
        code: "INVALID_FORMAT",
        message: `Destination ${publicKey} is not a valid Stellar public key format.`,
      },
    });
  }

  // 2. Check if it is the same as the source
  if (options?.source && publicKey === options.source) {
    return ok({
      valid: false,
      formatValid: true,
      isSource: true,
      exists: null,
      error: {
        code: "SAME_AS_SOURCE",
        message: "Destination address cannot be the same as the source address.",
      },
    });
  }

  // 3. Optional account existence check
  if (options?.checkExists) {
    if (!options.horizonUrl) {
      return err(
        SorokitErrorCode.UNKNOWN,
        "horizonUrl is required when checkExists is true.",
      );
    }

    try {
      await retryWithBackoff(async () => {
        const server = new Horizon.Server(options.horizonUrl!);
        return await server.loadAccount(publicKey);
      });

      return ok({
        valid: true,
        formatValid: true,
        isSource: false,
        exists: true,
      });
    } catch (cause) {
      if (isNotFoundError(cause)) {
        return ok({
          valid: false,
          formatValid: true,
          isSource: false,
          exists: false,
          error: {
            code: "ACCOUNT_NOT_FOUND",
            message: `Destination account ${publicKey} does not exist.`,
          },
        });
      }

      return ok({
        valid: false,
        formatValid: true,
        isSource: false,
        exists: null,
        error: {
          code: "FETCH_FAILED",
          message: `Failed to verify destination account existence: ${toMessage(cause)}`,
        },
      });
    }
  }

  // All checks passed (no existence check requested)
  return ok({
    valid: true,
    formatValid: true,
    isSource: false,
    exists: null,
  });
}
