export { connectWallet } from "./connect";
export { disconnectWallet } from "./disconnect";
export { signTransaction } from "./signTransaction";
export { FreighterAdapter } from "./adapters/freighter";
export { XBullAdapter } from "./adapters/xbull";
export { LobstrAdapter } from "./adapters/lobstr";
export type {
  WalletType,
  WalletState,
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
  DiagnosticStatus,
  DiagnosticCheck,
  WalletDiagnosticReport,
  WalletDiagnosticOptions,
} from "./types";
export { WalletType as WalletTypeEnum } from "./types";

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared/errors";
import type {
  WalletState,
  WalletAdapter,
  DiagnosticCheck,
  WalletDiagnosticReport,
  WalletDiagnosticOptions,
} from "./types";

/**
 * Return a canonical disconnected WalletState wrapped in SorokitResult.
 * Use this to initialise wallet state in the UI layer.
 */
export function emptyWalletState(): SorokitResult<WalletState> {
  return ok({ connected: false, publicKey: null, walletType: null });
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
