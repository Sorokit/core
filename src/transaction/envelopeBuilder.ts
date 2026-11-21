/**
 * Transaction envelope builder (#975).
 *
 * A Stellar transaction envelope is the transaction body plus up to 20
 * `DecoratedSignature`s. Each decorated signature is:
 *
 *   - `hint`      – the last 4 bytes of the signer's ed25519 public key, and
 *   - `signature` – a 64-byte ed25519 signature over the transaction hash
 *                   (SHA-256 of the network passphrase hash + envelope type + tx body).
 *
 * `EnvelopeBuilder` keeps the signatures keyed by signer public key so they
 * can be added, replaced, removed and inspected independently of how they
 * were collected. Every signature is verified against the transaction hash
 * when it is added, so a wrong-network or wrong-transaction signature is
 * rejected immediately instead of failing at submission.
 *
 * ## Serialization
 *
 * `build()` returns `envelopeXdr`: the base64 XDR of the `TransactionEnvelope`
 * union (`ENVELOPE_TYPE_TX`, or `ENVELOPE_TYPE_TX_FEE_BUMP` for fee bumps),
 * which is the format Horizon's `POST /transactions` and Soroban RPC's
 * `sendTransaction` accept. Signatures are written in the order they were
 * added. The transaction body is never modified, so the hash (and therefore
 * every signature) stays valid across `build()` calls. `build()` can be
 * called repeatedly; it never mutates the builder.
 *
 * Out of scope: requesting signatures from wallets (see `collectSignature`
 * / `MultiSigCoordinator` for orchestrating that).
 */
import { FeeBumpTransaction, Keypair, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** Stellar protocol limit on signatures per envelope. */
export const MAX_ENVELOPE_SIGNATURES = 20;

/** Signature input accepted by {@link EnvelopeBuilder.addSignature}. */
export interface EnvelopeSignerInput {
  /** Signer's G… ed25519 public key. */
  publicKey: string;
  /** 64-byte ed25519 signature over the transaction hash: raw bytes or base64. */
  signature: Uint8Array | string;
}

/** A verified signature held by the builder. */
export interface EnvelopeSignature {
  /** Signer's G… public key. */
  publicKey: string;
  /** Base64 of the 4-byte signature hint (last 4 bytes of the public key). */
  hint: string;
  /** Base64 of the 64-byte signature. */
  signature: string;
}

/** Result of {@link EnvelopeBuilder.build}. */
export interface TransactionEnvelope {
  /** Base64 `TransactionEnvelope` XDR, ready to submit. */
  envelopeXdr: string;
  /** Hex transaction hash that every signature signs. */
  hash: string;
  /** Network passphrase the hash was computed for. */
  networkPassphrase: string;
  /** `"transaction"` or `"feeBump"`. */
  envelopeType: "transaction" | "feeBump";
  /** Signatures in envelope order. */
  signatures: EnvelopeSignature[];
}

export interface CreateEnvelopeBuilderOptions {
  /**
   * Public keys that may already have signed the input XDR. Existing
   * signatures are attributed by verifying them against these keys; the
   * builder can only manage signatures it can attribute.
   */
  knownSigners?: string[];
  /**
   * When true, existing signatures that match none of `knownSigners` are
   * dropped. When false (default) they cause an error, so nothing is lost
   * silently.
   */
  dropUnattributedSignatures?: boolean;
}

function decodeSignature(input: Uint8Array | string): Buffer | null {
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    return Buffer.from(input, "base64");
  }
  return null;
}

/**
 * Manages the signature set of one transaction envelope.
 *
 * Create it with {@link createEnvelopeBuilder}.
 *
 * @example
 * const builder = createEnvelopeBuilder(unsignedXdr, Networks.TESTNET);
 * if (builder.status === "error") throw builder.error;
 *
 * builder.data.addSignature({ publicKey: alice.publicKey(), signature: aliceSig });
 * builder.data.addSignature({ publicKey: bob.publicKey(), signature: bobSig });
 * builder.data.removeSignature(bob.publicKey());
 *
 * const envelope = builder.data.build();
 * if (envelope.status === "ok") await submitTransaction(envelope.data.envelopeXdr);
 */
export class EnvelopeBuilder {
  private readonly signatures = new Map<string, EnvelopeSignature>();
  private readonly hashBytes: Buffer;

  /** @internal Use {@link createEnvelopeBuilder}. */
  constructor(
    private readonly tx: Transaction | FeeBumpTransaction,
    readonly networkPassphrase: string,
  ) {
    this.hashBytes = tx.hash();
  }

  /** Hex transaction hash that signatures must sign. */
  get hash(): string {
    return this.hashBytes.toString("hex");
  }

  /** Raw transaction hash bytes, e.g. for `keypair.sign(builder.hashBytes)`. */
  getHashBytes(): Buffer {
    return Buffer.from(this.hashBytes);
  }

  /**
   * Add a signer's signature. The signature must verify against this
   * transaction's hash for the signer's public key. Re-adding a signer
   * replaces their previous signature.
   *
   * @returns `ok(EnvelopeSignature)` for the stored signature, or a
   *   `VALIDATION` error (bad key, malformed or non-verifying signature,
   *   or the 20-signature limit reached).
   */
  addSignature(input: EnvelopeSignerInput): SorokitResult<EnvelopeSignature> {
    const publicKey = input?.publicKey;
    if (typeof publicKey !== "string" || !StrKey.isValidEd25519PublicKey(publicKey)) {
      return err(SorokitErrorCode.VALIDATION, `addSignature: "${String(publicKey)}" is not a valid G… public key`);
    }
    const sig = decodeSignature(input.signature);
    if (!sig || sig.length !== 64) {
      return err(
        SorokitErrorCode.VALIDATION,
        `addSignature: signature for ${publicKey} must be 64 bytes (raw or base64), got ${sig ? sig.length : "an invalid value"}`,
      );
    }
    if (!Keypair.fromPublicKey(publicKey).verify(this.hashBytes, sig)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `addSignature: signature does not verify for ${publicKey} against transaction ${this.hash} — wrong transaction, network or signer`,
      );
    }
    if (!this.signatures.has(publicKey) && this.signatures.size >= MAX_ENVELOPE_SIGNATURES) {
      return err(
        SorokitErrorCode.VALIDATION,
        `addSignature: an envelope holds at most ${MAX_ENVELOPE_SIGNATURES} signatures`,
      );
    }

    const stored: EnvelopeSignature = {
      publicKey,
      hint: Keypair.fromPublicKey(publicKey).signatureHint().toString("base64"),
      signature: sig.toString("base64"),
    };
    // Replacing keeps a stable position: delete-then-set would move it last.
    this.signatures.set(publicKey, stored);
    return ok({ ...stored });
  }

  /**
   * Sign with a local keypair and add the signature. Convenience for tests
   * and server-side signers.
   */
  sign(keypair: Keypair): SorokitResult<EnvelopeSignature> {
    return this.addSignature({ publicKey: keypair.publicKey(), signature: keypair.sign(this.hashBytes) });
  }

  /**
   * Remove a signer's signature.
   * @returns `true` when a signature was removed, `false` when that signer had not signed.
   */
  removeSignature(signerKey: string): boolean {
    return this.signatures.delete(signerKey);
  }

  /** Whether `signerKey` has a signature in the envelope. */
  hasSignature(signerKey: string): boolean {
    return this.signatures.has(signerKey);
  }

  /** All signatures, in envelope order (copies; mutating them has no effect). */
  getSignatures(): EnvelopeSignature[] {
    return Array.from(this.signatures.values(), (s) => ({ ...s }));
  }

  /** Public keys that have signed, in envelope order. */
  getSigners(): string[] {
    return Array.from(this.signatures.keys());
  }

  /**
   * Serialize the transaction with the current signatures.
   * Does not mutate the builder; safe to call repeatedly.
   */
  build(): SorokitResult<TransactionEnvelope> {
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(this.tx.toEnvelope().toXDR());
      const decorated = Array.from(
        this.signatures.values(),
        (s) =>
          new xdr.DecoratedSignature({
            hint: Buffer.from(s.hint, "base64"),
            signature: Buffer.from(s.signature, "base64"),
          }),
      );
      const isFeeBump = this.tx instanceof FeeBumpTransaction;
      if (isFeeBump) envelope.feeBump().signatures(decorated);
      else if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTxV0()) envelope.v0().signatures(decorated);
      else envelope.v1().signatures(decorated);

      return ok({
        envelopeXdr: envelope.toXDR("base64"),
        hash: this.hash,
        networkPassphrase: this.networkPassphrase,
        envelopeType: isFeeBump ? "feeBump" : "transaction",
        signatures: this.getSignatures(),
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `EnvelopeBuilder.build: failed to serialize envelope: ${(cause as Error)?.message ?? String(cause)}`,
        cause,
      );
    }
  }
}

/**
 * Create an {@link EnvelopeBuilder} for a transaction or fee-bump XDR.
 *
 * Signatures already present in the XDR are imported when they verify for
 * one of `options.knownSigners`; see {@link CreateEnvelopeBuilderOptions}.
 *
 * @returns `ok(EnvelopeBuilder)`, or an error for malformed XDR
 *   (`XDR_INVALID`) or unattributable existing signatures (`VALIDATION`).
 */
export function createEnvelopeBuilder(
  transactionXdr: string,
  networkPassphrase: string,
  options: CreateEnvelopeBuilderOptions = {},
): SorokitResult<EnvelopeBuilder> {
  if (typeof networkPassphrase !== "string" || networkPassphrase.length === 0) {
    return err(SorokitErrorCode.VALIDATION, "createEnvelopeBuilder: networkPassphrase is required");
  }
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch (cause) {
    return err(
      SorokitErrorCode.XDR_INVALID,
      `createEnvelopeBuilder: could not parse transaction XDR: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  const builder = new EnvelopeBuilder(tx, networkPassphrase);
  const known = (options.knownSigners ?? []).filter((k) => StrKey.isValidEd25519PublicKey(k));

  for (const existing of tx.signatures) {
    const hint = existing.hint();
    const signature = existing.signature();
    const signer = known.find(
      (k) =>
        Keypair.fromPublicKey(k).signatureHint().equals(hint) &&
        Keypair.fromPublicKey(k).verify(tx.hash(), signature),
    );
    if (signer) {
      const added = builder.addSignature({ publicKey: signer, signature });
      if (added.status === "error") return added as unknown as SorokitResult<EnvelopeBuilder>;
    } else if (!options.dropUnattributedSignatures) {
      return err(
        SorokitErrorCode.VALIDATION,
        `createEnvelopeBuilder: existing signature with hint ${hint.toString("hex")} matches none of knownSigners; pass its public key or set dropUnattributedSignatures`,
      );
    }
  }

  return ok(builder);
}
