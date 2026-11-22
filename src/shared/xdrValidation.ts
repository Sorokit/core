/**
 * XDR Versioning Support — Handle Protocol Version Mismatches (#917)
 *
 * Validates XDR envelopes against expected Stellar protocol versions
 * and surfaces actionable warnings on mismatches to prevent decoding errors.
 */

import { TransactionBuilder, Networks, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";

export interface XdrValidationResult {
  valid: boolean;
  detectedProtocol: number;
  expectedProtocol: number;
  envelopeType: string;
  isMismatch: boolean;
  warning?: string | undefined;
}

export interface XdrValidationOptions {
  networkPassphrase?: string | undefined;
  allowLegacyProtocols?: boolean | undefined;
}

export const CURRENT_STELLAR_PROTOCOL = 21;
export const MINIMUM_RECOMMENDED_PROTOCOL = 20;

/**
 * Detect the Stellar protocol version and envelope structure represented by an XDR string.
 */
export function detectXdrProtocolVersion(
  xdrString: string,
  networkPassphrase: string = Networks.TESTNET,
): { protocol: number; envelopeType: string } {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(xdrString, "base64");
    const sw = envelope.switch();

    if (sw.value === xdr.EnvelopeType.envelopeTypeTxV0().value) {
      return { protocol: 12, envelopeType: "EnvelopeTypeTxV0" };
    }
    if (sw.value === xdr.EnvelopeType.envelopeTypeTxFeeBump().value) {
      return { protocol: 13, envelopeType: "EnvelopeTypeTxFeeBump" };
    }
    if (sw.value === xdr.EnvelopeType.envelopeTypeTx().value) {
      try {
        const tx = TransactionBuilder.fromXDR(xdrString, networkPassphrase);
        if ("sorobanData" in tx && (tx as unknown as { sorobanData?: unknown }).sorobanData) {
          return { protocol: 20, envelopeType: "EnvelopeTypeTxWithSoroban" };
        }
      } catch {}
      return { protocol: 20, envelopeType: "EnvelopeTypeTxV1" };
    }

    return { protocol: CURRENT_STELLAR_PROTOCOL, envelopeType: "EnvelopeTypeTx" };
  } catch {
    return { protocol: 0, envelopeType: "unknown" };
  }
}

/**
 * Validate an XDR envelope against an expected protocol version.
 */
export function validateXdrVersion(
  xdrString: string,
  expectedProtocol: number = CURRENT_STELLAR_PROTOCOL,
  options?: XdrValidationOptions,
): SorokitResult<XdrValidationResult> {
  try {
    if (!xdrString || typeof xdrString !== "string" || xdrString.trim().length === 0) {
      return err(
        SorokitErrorCode.XDR_INVALID,
        "Cannot validate empty or invalid XDR string",
      );
    }

    const passphrase = options?.networkPassphrase ?? Networks.TESTNET;
    const { protocol: detectedProtocol, envelopeType } = detectXdrProtocolVersion(
      xdrString.trim(),
      passphrase,
    );

    if (detectedProtocol === 0) {
      return err(
        SorokitErrorCode.XDR_INVALID,
        "Failed to decode or identify XDR envelope protocol version",
      );
    }

    const isMismatch = detectedProtocol !== expectedProtocol;
    let warning: string | undefined;

    if (isMismatch) {
      if (detectedProtocol < MINIMUM_RECOMMENDED_PROTOCOL) {
        warning = `XDR envelope uses legacy protocol ${detectedProtocol} (${envelopeType}). Node protocol is ${expectedProtocol}. Stale XDR may decode incorrectly or be rejected on newer nodes.`;
      } else {
        warning = `XDR protocol version mismatch: detected protocol ${detectedProtocol} (${envelopeType}), but expected protocol ${expectedProtocol}.`;
      }
    }

    return ok({
      valid: true,
      detectedProtocol,
      expectedProtocol,
      envelopeType,
      isMismatch,
      ...(warning ? { warning } : {}),
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.XDR_INVALID,
      cause instanceof Error ? cause.message : "Error validating XDR protocol version",
      cause,
    );
  }
}
