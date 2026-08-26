export { getWalletCapabilities, WALLET_CAPABILITY_IDS } from "./capabilities";
export { connectWallet } from "./connect";
export { disconnectWallet } from "./disconnect";
export { signTransaction } from "./signTransaction";
export { signTransactionOffline } from "./signTransactionOffline";
export { createSigningChallenge, mergeSignatures } from "./signingDelegation";
export { FreighterAdapter, XBullAdapter, LobstrAdapter } from "./adapters";
export { WalletType } from "./types";
export type {
  WalletState,
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
  DiagnosticStatus,
  DiagnosticCheck,
  WalletDiagnosticReport,
  WalletDiagnosticOptions,
  DetectedWallet,
  RecommendationCriteria,
  WalletFeature,
  ConnectedAccountsResult,
  AccountSwitchResult,
  WalletCapability,
  WalletCapabilityId,
  WalletCapabilitySource,
  WalletCapabilities,
} from "./types";
export {
  getSigningHistory,
  exportSigningHistory,
  InMemorySigningHistoryStore,
} from "./signingHistory";
export type {
  SigningRecord,
  SigningHistoryFilter,
  SigningHistoryStore,
} from "./signingHistory";
export type {
  CreateSigningChallengeOptions,
  MergeSignaturesResult,
  SigningChallenge,
  SigningDelegationSignature,
} from "./signingDelegation";

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared/errors";
import { xdr } from "@stellar/stellar-sdk";
import type {
  WalletState,
  WalletAdapter,
  DiagnosticCheck,
  WalletDiagnosticReport,
  WalletDiagnosticOptions,
  DetectedWallet,
  RecommendationCriteria,
  WalletFeature,
  ConnectedAccountsResult,
  AccountSwitchResult,
  WalletCapability,
  WalletCapabilityId,
  WalletCapabilitySource,
  WalletCapabilities,
} from "./types";
import { WalletType } from "./types";

const WALLET_FEATURE_MAP: Record<WalletType, WalletFeature[]> = {
  [WalletType.FREIGHTER]: ["multisig"],
  [WalletType.XBULL]: ["multisig", "hardware"],
  [WalletType.LOBSTR]: ["multisig"],
  [WalletType.HANA]: [],
  [WalletType.RABET]: [],
};

export type EnvelopeSignatureInput = string | xdr.DecoratedSignature;
export type SignatureHintInput = string | Buffer | Uint8Array;

function parseEnvelope(envelopeXdr: string): xdr.TransactionEnvelope {
  if (typeof envelopeXdr !== "string" || envelopeXdr.trim().length === 0) {
    throw new Error("Transaction envelope XDR must be a non-empty base64 string.");
  }

  try {
    return xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  } catch {
    throw new Error("Invalid transaction envelope XDR.");
  }
}

function parseSignature(signature: EnvelopeSignatureInput): xdr.DecoratedSignature {
  let decoratedSignature: xdr.DecoratedSignature;

  if (typeof signature === "string") {
    if (signature.trim().length === 0) {
      throw new Error("Signature XDR must be a non-empty base64 string.");
    }

    try {
      decoratedSignature = xdr.DecoratedSignature.fromXDR(signature, "base64");
    } catch {
      throw new Error("Invalid decorated signature XDR.");
    }
  } else {
    decoratedSignature = signature;
  }

  if (decoratedSignature.hint().length !== 4) {
    throw new Error("Signature hint must be exactly 4 bytes.");
  }

  if (decoratedSignature.signature().length === 0) {
    throw new Error("Signature bytes must not be empty.");
  }

  return decoratedSignature;
}

function normalizeSignatureHint(hint: SignatureHintInput): Buffer {
  const bytes =
    typeof hint === "string"
      ? /^[0-9a-fA-F]{8}$/.test(hint)
        ? Buffer.from(hint, "hex")
        : Buffer.from(hint, "base64")
      : Buffer.from(hint);

  if (bytes.length !== 4) {
    throw new Error("Signature hint must be exactly 4 bytes.");
  }

  return bytes;
}

function bufferEquals(left: Buffer | Uint8Array, right: Buffer | Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function getEnvelopeSignatures(envelope: xdr.TransactionEnvelope): xdr.DecoratedSignature[] {
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTxV0():
      return envelope.v0().signatures();
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().signatures();
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().signatures();
    default:
      throw new Error("Unsupported transaction envelope type.");
  }
}

function setEnvelopeSignatures(
  envelope: xdr.TransactionEnvelope,
  signatures: xdr.DecoratedSignature[],
): void {
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTxV0():
      envelope.v0().signatures(signatures);
      return;
    case xdr.EnvelopeType.envelopeTypeTx():
      envelope.v1().signatures(signatures);
      return;
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      envelope.feeBump().signatures(signatures);
      return;
    default:
      throw new Error("Unsupported transaction envelope type.");
  }
}

/**
 * Add a decorated signature to a transaction envelope XDR.
 *
 * The input envelope is parsed and re-serialized; the original XDR string is not
 * modified. `signature` may be a base64-encoded DecoratedSignature XDR or an SDK
 * DecoratedSignature instance.
 */
export function addSignatureToEnvelope(
  envelopeXdr: string,
  signature: EnvelopeSignatureInput,
): string {
  const envelope = parseEnvelope(envelopeXdr);
  const decoratedSignature = parseSignature(signature);
  setEnvelopeSignatures(envelope, [
    ...getEnvelopeSignatures(envelope),
    decoratedSignature,
  ]);
  return envelope.toXDR("base64");
}

/**
 * Remove decorated signatures with the provided 4-byte hint from an envelope XDR.
 *
 * `hint` may be raw bytes, an 8-character hex string, or a base64-encoded
 * 4-byte signature hint. The returned XDR is a fresh serialized envelope.
 */
export function removeSignatureFromEnvelope(
  envelopeXdr: string,
  hint: SignatureHintInput,
): string {
  const envelope = parseEnvelope(envelopeXdr);
  const normalizedHint = normalizeSignatureHint(hint);
  const retainedSignatures = getEnvelopeSignatures(envelope)
    .filter((signature) => !bufferEquals(signature.hint(), normalizedHint));

  setEnvelopeSignatures(envelope, retainedSignatures);
  return envelope.toXDR("base64");
}

/**
 * Detect which wallet adapters are currently installed and available.
 * Only works in a browser environment — returns available: false for all in Node.
 */
export function detectInstalledWallets(adapters: WalletAdapter[]): DetectedWallet[] {
  return adapters.map((adapter) => ({
    walletType: adapter.walletType,
    available: adapter.isAvailable(),
    features: WALLET_FEATURE_MAP[adapter.walletType] ?? [],
  }));
}

/**
 * Reorder wallet adapters by availability and an optional preferred type.
 *
 * Order: preferred (when available) → other available wallets (input order)
 * → unavailable wallets (input order). If the preferred wallet is present
 * but unavailable, it falls to the unavailable bucket and the first
 * available adapter leads.
 */
export function prioritizeWallet(
  adapters: WalletAdapter[],
  preferred?: WalletType,
): WalletAdapter[] {
  const preferredAvailable: WalletAdapter[] = [];
  const otherAvailable: WalletAdapter[] = [];
  const unavailable: WalletAdapter[] = [];

  for (const adapter of adapters) {
    const available = adapter.isAvailable();
    if (!available) {
      unavailable.push(adapter);
      continue;
    }
    if (preferred !== undefined && adapter.walletType === preferred) {
      preferredAvailable.push(adapter);
    } else {
      otherAvailable.push(adapter);
    }
  }

  return [...preferredAvailable, ...otherAvailable, ...unavailable];
}

/**
 * Recommend wallets from a list of adapters based on optional feature criteria.
 * Returns all available wallets when no criteria are provided.
 * Requires a browser environment — adapters report unavailable in Node.
 */
export function recommendWallets(
  adapters: WalletAdapter[],
  criteria?: RecommendationCriteria,
): DetectedWallet[] {
  const detected = detectInstalledWallets(adapters);
  const available = detected.filter((w) => w.available);
  const requiredFeatures = criteria?.features;
  if (!requiredFeatures?.length) return available;
  return available.filter((w) =>
    requiredFeatures.every((f) => w.features.includes(f)),
  );
}

/**
 * Return a canonical disconnected WalletState wrapped in SorokitResult.
 * Use this to initialise wallet state in the UI layer.
 */
export function emptyWalletState(): SorokitResult<WalletState> {
  return ok({ connected: false, publicKey: null, walletType: null });
}

/**
 * List all accounts currently accessible from the connected wallet.
 *
 * When the adapter implements the optional `getAccounts()` method (signalling
 * that the underlying wallet / SWK version supports multi-account listing),
 * that method is called and its results are combined with the currently-active
 * account returned by `adapter.connect()`.
 *
 * When `getAccounts()` is absent, this function falls back gracefully: it calls
 * `adapter.connect()` and returns a single-item list containing the active account.
 *
 * The returned `ConnectedAccountsResult.accounts` array is deduplicated and always
 * contains at least the active account on success.
 *
 * @returns `ok(ConnectedAccountsResult)` on success, or an `error` result when
 *          the adapter is unavailable or the active account cannot be resolved.
 *
 * @example
 * const result = await listConnectedAccounts(adapter);
 * if (result.status === "ok") {
 *   console.log("Active:", result.data.activeAccount);
 *   console.log("All accounts:", result.data.accounts);
 * }
 */
export async function listConnectedAccounts(
  adapter: WalletAdapter,
): Promise<SorokitResult<ConnectedAccountsResult>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  // Resolve the currently active account — always required.
  const activeResult = await adapter.connect();
  if (activeResult.status === "error") return activeResult;
  const activeAccount = activeResult.data;

  // If the adapter exposes multi-account listing, use it.
  if (typeof adapter.getAccounts === "function") {
    const accountsResult = await adapter.getAccounts();
    if (accountsResult.status === "error") return accountsResult;

    // Merge, dedup, and ensure the active account is always present.
    const seen = new Set<string>([activeAccount]);
    const accounts: string[] = [activeAccount];
    for (const key of accountsResult.data) {
      if (!seen.has(key)) {
        seen.add(key);
        accounts.push(key);
      }
    }

    return ok({ accounts, activeAccount });
  }

  // Fallback: single-account wallet — return just the active account.
  return ok({ accounts: [activeAccount], activeAccount });
}

/**
 * Switch the wallet's active account to the given public key.
 *
 * Requires the adapter to implement the optional `setActiveAccount()` method.
 * When the method is absent (the wallet does not support programmatic account
 * switching), the function returns a `WALLET_NOT_FOUND` error with a clear message.
 *
 * On success, a fresh `WalletState` reflecting the switched account is returned
 * alongside the resolved public key.
 *
 * @param adapter     - The wallet adapter to operate on.
 * @param accountKey  - The Stellar public key (G...) to switch to.
 * @returns `ok(AccountSwitchResult)` on success, or an `error` result.
 *
 * @example
 * const result = await switchAccount(adapter, "GABC...");
 * if (result.status === "ok") {
 *   console.log("Now signed in as", result.data.publicKey);
 * }
 */
export async function switchAccount(
  adapter: WalletAdapter,
  accountKey: string,
): Promise<SorokitResult<AccountSwitchResult>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  if (typeof adapter.setActiveAccount !== "function") {
    return err(
      SorokitErrorCode.WALLET_NOT_FOUND,
      `${adapter.walletType} does not support programmatic account switching.`,
    );
  }

  if (!accountKey || accountKey.trim().length === 0) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      "switchAccount: accountKey must be a non-empty public key string.",
    );
  }

  const switchResult = await adapter.setActiveAccount(accountKey);
  if (switchResult.status === "error") return switchResult;

  const publicKey = switchResult.data;
  const walletState: WalletState = {
    connected: true,
    publicKey,
    walletType: adapter.walletType,
  };

  return ok({ publicKey, walletState });
}

/**
 * Collect signatures from multiple signers sequentially, returning the fully-signed XDR.
 *
 * Each `signFn` call receives the current (partially-signed) XDR and the signer's public key.
 * It should return the XDR with that signer's signature appended.
 * If any signer fails, the error is returned immediately and remaining signers are skipped.
 *
 * @param xdr - The unsigned (or partially-signed) transaction XDR.
 * @param signers - Ordered list of signer public keys.
 * @param signFn - Signing function called for each signer in order.
 * @returns The fully-signed XDR on success, or the first encountered error.
 */
export async function collectMultiSignatures(
  xdr: string,
  signers: string[],
  signFn: (xdr: string, signer: string) => Promise<SorokitResult<string>>,
): Promise<SorokitResult<string>> {
  if (signers.length === 0) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "collectMultiSignatures: signers list must not be empty.",
    );
  }

  let currentXdr = xdr;
  for (const signer of signers) {
    const result = await signFn(currentXdr, signer);
    if (result.status !== "ok") return result;
    currentXdr = result.data;
  }

  return ok(currentXdr);
}

/**
 * Diagnose a wallet connection by running a series of lightweight checks and
 * returning a structured report with findings and recommendations.
 *
 * Checks performed, in order:
 * 1. `wallet_installed` — `adapter.isAvailable()` (extension present + browser env).
 * 2. `network_connectivity` — reaches `options.networkUrl` when provided (skipped otherwise).
 * 3. `extension_responsive` — attempts `adapter.connect()` to confirm the wallet responds
 *    (skipped when unavailable or `options.probeConnection === false`).
 *
 * Never throws — diagnostics are always returned as a successful SorokitResult.
 *
 * @example
 * const report = await diagnoseWalletConnection(adapter, { networkUrl: horizonUrl });
 * if (report.status === "ok" && !report.data.healthy) {
 *   console.warn(report.data.recommendations);
 * }
 */
export async function diagnoseWalletConnection(
  adapter: WalletAdapter,
  options?: WalletDiagnosticOptions,
): Promise<SorokitResult<WalletDiagnosticReport>> {
  const checks: DiagnosticCheck[] = [];

  // 1. Wallet availability
  const available = adapter.isAvailable();
  checks.push(
    available
      ? {
          name: "wallet_installed",
          status: "pass",
          finding: `${adapter.walletType} is available.`,
        }
      : {
          name: "wallet_installed",
          status: "fail",
          finding: `${adapter.walletType} is not available — the extension is not installed or this is not a browser environment.`,
          recommendation: `Install the ${adapter.walletType} extension and run in a browser.`,
        },
  );

  // 2. Network connectivity (only when a URL is supplied)
  if (options?.networkUrl) {
    const fetchFn =
      options.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!fetchFn) {
      checks.push({
        name: "network_connectivity",
        status: "skipped",
        finding: "No fetch implementation available to test network connectivity.",
        recommendation: "Provide options.fetchFn when running outside a browser.",
      });
    } else {
      try {
        const res = await fetchFn(options.networkUrl, { method: "GET" });
        checks.push(
          res.ok
            ? {
                name: "network_connectivity",
                status: "pass",
                finding: `Network endpoint reachable (HTTP ${res.status}).`,
              }
            : {
                name: "network_connectivity",
                status: "warn",
                finding: `Network endpoint returned HTTP ${res.status}.`,
                recommendation: "Verify the network URL and node health.",
              },
        );
      } catch (cause) {
        checks.push({
          name: "network_connectivity",
          status: "fail",
          finding: `Network endpoint unreachable: ${toMessage(cause)}`,
          recommendation: "Check your internet connection and the network URL.",
        });
      }
    }
  } else {
    checks.push({
      name: "network_connectivity",
      status: "skipped",
      finding: "No networkUrl provided — connectivity was not tested.",
    });
  }

  // 3. Extension responsiveness
  const probeConnection = options?.probeConnection ?? true;
  if (!available) {
    checks.push({
      name: "extension_responsive",
      status: "skipped",
      finding: "Skipped because the wallet is not available.",
    });
  } else if (!probeConnection) {
    checks.push({
      name: "extension_responsive",
      status: "skipped",
      finding: "Skipped because probeConnection was disabled.",
    });
  } else {
    const connectResult = await adapter.connect();
    if (connectResult.status === "ok") {
      checks.push({
        name: "extension_responsive",
        status: "pass",
        finding: "Wallet responded and returned a public key.",
      });
    } else {
      const code = connectResult.error.code;
      const recommendation =
        code === SorokitErrorCode.WALLET_SIGN_REJECTED ||
        code === SorokitErrorCode.WALLET_CONNECT_FAILED
          ? "The connection was rejected — approve the connection request in your wallet."
          : "Ensure the wallet extension is unlocked and responsive.";
      checks.push({
        name: "extension_responsive",
        status: "fail",
        finding: `Wallet did not connect: ${connectResult.error.message}`,
        recommendation,
      });
    }
  }

  const findings = checks.map((c) => c.finding);
  const recommendations = checks
    .map((c) => c.recommendation)
    .filter((r): r is string => r !== undefined);
  const healthy = checks.every(
    (c) => c.status === "pass" || c.status === "skipped",
  );

  return ok({
    walletType: adapter.walletType,
    healthy,
    checks,
    findings,
    recommendations,
  });
}
