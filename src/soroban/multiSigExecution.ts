import { Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

// ─── Types ───

/** A signer permitted to authorize a contract execution request. */
export interface ContractExecutionSigner {
  publicKey: string;
  /** Weight this signer contributes toward the threshold. Defaults to 1. */
  weight?: number;
}

export interface CreateSigningRequestInput {
  /** Prepared, unsigned contract invocation XDR. */
  transactionXdr: string;
  networkPassphrase: string;
  signers: readonly ContractExecutionSigner[];
  /** Total weight required before execution is permitted. */
  threshold: number;
  /** Epoch milliseconds after which the request can no longer be executed. */
  expiresAt?: number;
  /** Epoch milliseconds treated as creation time. Defaults to `Date.now()`. */
  now?: number;
}

/** A signature contributed by one signer. */
export interface CollectedSignature {
  publicKey: string;
  /** Base64-encoded Ed25519 signature over the canonical payload. */
  signature: string;
  weight: number;
  collectedAt: number;
}

export type SigningRequestStatus = "collecting" | "ready" | "expired" | "executed";

/**
 * A pending N-of-M contract execution.
 *
 * `payloadHash` is the canonical signing payload: the transaction hash for the
 * given network passphrase. Every signature is verified against this exact
 * value, so the request cannot be replayed against a different network or a
 * different transaction body.
 */
export interface ContractSigningRequest {
  id: string;
  transactionXdr: string;
  networkPassphrase: string;
  /** Hex-encoded transaction hash that signers must sign. */
  payloadHash: string;
  signers: readonly Required<ContractExecutionSigner>[];
  threshold: number;
  signatures: readonly CollectedSignature[];
  collectedWeight: number;
  status: SigningRequestStatus;
  createdAt: number;
  expiresAt?: number;
}

export interface SigningRequestState {
  id: string;
  status: SigningRequestStatus;
  collectedWeight: number;
  threshold: number;
  /** Weight still needed. Zero once the threshold is satisfied. */
  remainingWeight: number;
  thresholdMet: boolean;
  signedBy: readonly string[];
  pendingSigners: readonly string[];
  expiresAt?: number;
}

// ─── Helpers ───

function normalizeSigners(
  signers: readonly ContractExecutionSigner[],
): Required<ContractExecutionSigner>[] {
  return signers.map((signer) => ({ publicKey: signer.publicKey, weight: signer.weight ?? 1 }));
}

/**
 * Compute the canonical payload signers must sign: the transaction hash bound
 * to the network passphrase.
 */
function computePayloadHash(
  transactionXdr: string,
  networkPassphrase: string,
): SorokitResult<Buffer> {
  try {
    const transaction = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    return ok(transaction.hash());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Signing request payload could not be derived — ${toMessage(cause)}`,
      cause,
    );
  }
}

function isExpired(request: ContractSigningRequest, now: number): boolean {
  return request.expiresAt !== undefined && now >= request.expiresAt;
}

function recompute(request: ContractSigningRequest, now: number): ContractSigningRequest {
  if (request.status === "executed") return request;
  if (isExpired(request, now)) return { ...request, status: "expired" };
  return {
    ...request,
    status: request.collectedWeight >= request.threshold ? "ready" : "collecting",
  };
}

// ─── Workflow ───

/**
 * Coordinates N-of-M authorization for a Soroban contract invocation.
 *
 * The workflow separates preparation, signature collection, validation and
 * submission. It never signs: callers sign the request's `payloadHash` with
 * their own wallet or keypair and submit the resulting signature here.
 *
 * Signatures are verified as Ed25519 signatures over the transaction hash — the
 * same payload the Stellar protocol itself signs — so no separate signing
 * format is introduced.
 */
export class MultiSigContractExecution {
  private readonly requests = new Map<string, ContractSigningRequest>();
  private sequence = 0;

  /**
   * Create a signing request for a prepared contract invocation.
   *
   * Validates that the XDR parses for the given network, that signers are
   * unique and positively weighted, and that the threshold is reachable.
   */
  createSigningRequest(input: CreateSigningRequestInput): SorokitResult<ContractSigningRequest> {
    const signers = normalizeSigners(input.signers);

    if (signers.length === 0) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "createSigningRequest: at least one signer is required.",
      );
    }

    const seen = new Set<string>();
    for (const signer of signers) {
      if (seen.has(signer.publicKey)) {
        return err(
          SorokitErrorCode.INVALID_CONFIG,
          `createSigningRequest: signer ${signer.publicKey} is listed more than once.`,
        );
      }
      seen.add(signer.publicKey);

      if (signer.weight < 1) {
        return err(
          SorokitErrorCode.INVALID_CONFIG,
          `createSigningRequest: signer ${signer.publicKey} has invalid weight ${signer.weight} — must be >= 1.`,
        );
      }
      try {
        Keypair.fromPublicKey(signer.publicKey);
      } catch {
        return err(
          SorokitErrorCode.INVALID_ADDRESS,
          `createSigningRequest: ${signer.publicKey} is not a valid Stellar public key.`,
        );
      }
    }

    if (!Number.isFinite(input.threshold) || input.threshold < 1) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `createSigningRequest: threshold must be >= 1 (got ${input.threshold}).`,
      );
    }

    const totalWeight = signers.reduce((sum, signer) => sum + signer.weight, 0);
    if (input.threshold > totalWeight) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `createSigningRequest: threshold (${input.threshold}) exceeds total signer weight (${totalWeight}) and can never be met.`,
      );
    }

    const payload = computePayloadHash(input.transactionXdr, input.networkPassphrase);
    if (payload.status === "error") return payload;

    const now = input.now ?? Date.now();
    if (input.expiresAt !== undefined && input.expiresAt <= now) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "createSigningRequest: expiresAt must be in the future.",
      );
    }

    this.sequence += 1;
    const request: ContractSigningRequest = {
      id: `csr-${this.sequence}-${payload.data.toString("hex").slice(0, 8)}`,
      transactionXdr: input.transactionXdr,
      networkPassphrase: input.networkPassphrase,
      payloadHash: payload.data.toString("hex"),
      signers,
      threshold: input.threshold,
      signatures: [],
      collectedWeight: 0,
      status: "collecting",
      createdAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };

    this.requests.set(request.id, request);
    return ok(request);
  }

  /**
   * Add a signature to a request.
   *
   * The signature must be a valid Ed25519 signature by `publicKey` over the
   * request's `payloadHash`. Invalid signatures are rejected and contribute no
   * weight. A signer that has already contributed is rejected, so one signer
   * cannot satisfy a multi-signer threshold alone.
   */
  addSignature(
    requestId: string,
    publicKey: string,
    signature: string,
    now: number = Date.now(),
  ): SorokitResult<ContractSigningRequest> {
    const existing = this.requests.get(requestId);
    if (!existing) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `addSignature: unknown signing request "${requestId}".`,
      );
    }

    const request = recompute(existing, now);
    this.requests.set(requestId, request);

    if (request.status === "executed") {
      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        `addSignature: request "${requestId}" has already been executed.`,
      );
    }
    if (request.status === "expired") {
      return err(
        SorokitErrorCode.OPERATION_TIMEOUT,
        `addSignature: request "${requestId}" expired and can no longer collect signatures.`,
      );
    }

    const signer = request.signers.find((entry) => entry.publicKey === publicKey);
    if (!signer) {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `addSignature: ${publicKey} is not a declared signer on this request.`,
      );
    }
    if (request.signatures.some((entry) => entry.publicKey === publicKey)) {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `addSignature: ${publicKey} has already signed this request.`,
      );
    }

    if (!this.isSignatureValid(request, publicKey, signature)) {
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `addSignature: signature from ${publicKey} is not a valid signature over this request payload.`,
      );
    }

    const signatures = [
      ...request.signatures,
      { publicKey, signature, weight: signer.weight, collectedAt: now },
    ];
    const collectedWeight = signatures.reduce((sum, entry) => sum + entry.weight, 0);
    const updated = recompute({ ...request, signatures, collectedWeight }, now);

    this.requests.set(requestId, updated);
    return ok(updated);
  }

  private isSignatureValid(
    request: ContractSigningRequest,
    publicKey: string,
    signature: string,
  ): boolean {
    try {
      const keypair = Keypair.fromPublicKey(publicKey);
      const payload = Buffer.from(request.payloadHash, "hex");
      return keypair.verify(payload, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }

  /** Current collection state of a request. */
  getRequestState(requestId: string, now: number = Date.now()): SorokitResult<SigningRequestState> {
    const existing = this.requests.get(requestId);
    if (!existing) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `getRequestState: unknown signing request "${requestId}".`,
      );
    }

    const request = recompute(existing, now);
    this.requests.set(requestId, request);

    const signedBy = request.signatures.map((entry) => entry.publicKey);
    return ok({
      id: request.id,
      status: request.status,
      collectedWeight: request.collectedWeight,
      threshold: request.threshold,
      remainingWeight: Math.max(0, request.threshold - request.collectedWeight),
      thresholdMet: request.collectedWeight >= request.threshold,
      signedBy,
      pendingSigners: request.signers
        .filter((signer) => !signedBy.includes(signer.publicKey))
        .map((signer) => signer.publicKey),
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /** Retrieve the full request record. */
  getRequest(requestId: string): ContractSigningRequest | undefined {
    return this.requests.get(requestId);
  }

  /** List every tracked request. */
  listRequests(): ContractSigningRequest[] {
    return [...this.requests.values()];
  }

  /**
   * Assemble the fully-signed transaction XDR once the threshold is met.
   *
   * Execution is blocked while the request is still collecting, expired, or
   * already executed. On success the collected signatures are attached to the
   * envelope and the request is marked executed, so the same authorization
   * cannot be assembled twice.
   *
   * @returns `ok(signedXdr)` ready to pass to submitTransaction().
   */
  execute(requestId: string, now: number = Date.now()): SorokitResult<string> {
    const existing = this.requests.get(requestId);
    if (!existing) {
      return err(SorokitErrorCode.INVALID_CONFIG, `execute: unknown signing request "${requestId}".`);
    }

    const request = recompute(existing, now);
    this.requests.set(requestId, request);

    if (request.status === "executed") {
      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        `execute: request "${requestId}" has already been executed.`,
      );
    }
    if (request.status === "expired") {
      return err(
        SorokitErrorCode.OPERATION_TIMEOUT,
        `execute: request "${requestId}" expired before the threshold was met and cannot be executed.`,
      );
    }
    if (request.collectedWeight < request.threshold) {
      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        `execute: threshold not met — ${request.threshold - request.collectedWeight} more weight required ` +
          `(collected ${request.collectedWeight}/${request.threshold}).`,
      );
    }

    let signedXdr: string;
    try {
      const transaction = TransactionBuilder.fromXDR(
        request.transactionXdr,
        request.networkPassphrase,
      );
      for (const entry of request.signatures) {
        const hint = Keypair.fromPublicKey(entry.publicKey).signatureHint();
        transaction.signatures.push(
          new xdr.DecoratedSignature({
            hint,
            signature: Buffer.from(entry.signature, "base64"),
          }),
        );
      }
      signedXdr = transaction.toXDR();
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `execute: failed to assemble the signed envelope — ${toMessage(cause)}`,
        cause,
      );
    }

    this.requests.set(requestId, { ...request, status: "executed" });
    return ok(signedXdr);
  }

  /** Discard a request. Returns true when one was removed. */
  cancelRequest(requestId: string): boolean {
    return this.requests.delete(requestId);
  }

  /** Discard all tracked requests. */
  clear(): void {
    this.requests.clear();
    this.sequence = 0;
  }
}

/** Construct a {@link MultiSigContractExecution} workflow. */
export function createMultiSigContractExecution(): MultiSigContractExecution {
  return new MultiSigContractExecution();
}
