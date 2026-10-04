/**
 * Wallet connection workflow runner.
 *
 * Drives any WalletAdapter through connect -> sign -> disconnect and reports
 * per-step outcomes. Works against the mocked SWK-backed adapters used in
 * this repo's own test suite (Freighter, xBull, Lobstr, Hana all share the
 * same SWKInstance-wrapping shape) and equally against a real extension
 * driven by a browser automation tool, via {@link createBrowserDrivenAdapter}.
 */

import { connectWallet } from "../../../wallet/connect";
import type { SignTransactionInput, WalletAdapter } from "../../../wallet/types";
import { WalletType } from "../../../wallet/types";
import { ok, err, SorokitErrorCode } from "../../../shared/response";
import type { SorokitResult } from "../../../shared/response";
import type { WorkflowResult, WorkflowStepResult } from "./types";

export interface WalletConnectionWorkflowOptions {
  adapter: WalletAdapter;
  signInput: SignTransactionInput;
}

async function timedStep(
  step: string,
  run: () => Promise<{ ok: boolean; detail?: string | null }>,
): Promise<WorkflowStepResult> {
  const started = Date.now();
  const outcome = await run();
  return {
    step,
    status: outcome.ok ? "ok" : "error",
    durationMs: Date.now() - started,
    ...(outcome.detail !== undefined && outcome.detail !== null
      ? { detail: outcome.detail }
      : {}),
  };
}

/**
 * Run the full connect -> sign -> disconnect workflow against a single adapter.
 * Stops early (remaining steps recorded as "skipped") once a step fails.
 */
export async function runWalletConnectionWorkflow(
  options: WalletConnectionWorkflowOptions,
): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  const workflow = `wallet-connection:${options.adapter.walletType}`;

  const connectStep = await timedStep("connect", async () => {
    const result = await connectWallet(options.adapter);
    return {
      ok: result.status === "ok",
      detail: result.status === "ok" ? result.data.publicKey : result.error.message,
    };
  });
  steps.push(connectStep);
  if (connectStep.status !== "ok") {
    steps.push({ step: "sign", status: "skipped", durationMs: 0 });
    steps.push({ step: "disconnect", status: "skipped", durationMs: 0 });
    return { workflow, ok: false, steps };
  }

  const signStep = await timedStep("sign", async () => {
    const result = await options.adapter.signTransaction(options.signInput);
    return { ok: result.status === "ok", detail: result.status === "ok" ? "signed" : result.error.message };
  });
  steps.push(signStep);

  const disconnectStep = await timedStep("disconnect", async () => {
    const result = await options.adapter.disconnect();
    return { ok: result.status === "ok", detail: result.status === "error" ? result.error.message : null };
  });
  steps.push(disconnectStep);

  return { workflow, ok: steps.every((s) => s.status === "ok"), steps };
}

/** Run the connection workflow against several adapters and report each independently. */
export async function runWalletConnectionWorkflowSuite(
  scenarios: WalletConnectionWorkflowOptions[],
): Promise<WorkflowResult[]> {
  const results: WorkflowResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runWalletConnectionWorkflow(scenario));
  }
  return results;
}

/**
 * Contract a browser-automation driver (Playwright, Puppeteer, or similar)
 * must satisfy to exercise a real installed wallet extension end to end.
 * sorokit-core never depends on a browser automation library directly —
 * the consumer's test suite implements this against whichever tool it uses
 * and hands the driver to {@link createBrowserDrivenAdapter}, which adapts
 * it into a standard WalletAdapter so it can run through
 * {@link runWalletConnectionWorkflow} like any other adapter.
 */
export interface BrowserWalletDriver {
  /** Human-readable label, e.g. "Freighter 5.2.1 / Chromium 124". */
  readonly label: string;
  /** Open the extension popup/UI and approve the connection request. */
  approveConnection(): Promise<string>;
  /** Approve a pending signature request in the extension UI and return the signed XDR. */
  approveSignature(input: SignTransactionInput): Promise<string>;
  /** Close the extension context opened for this session. */
  close(): Promise<void>;
}

/** Adapt a {@link BrowserWalletDriver} into a WalletAdapter runnable through the workflow framework. */
export function createBrowserDrivenAdapter(
  driver: BrowserWalletDriver,
  walletType: WalletType,
): WalletAdapter {
  return {
    walletType,
    isAvailable: () => true,
    async connect(): Promise<SorokitResult<string>> {
      try {
        return ok(await driver.approveConnection());
      } catch (cause) {
        return err(
          SorokitErrorCode.WALLET_CONNECT_FAILED,
          `${driver.label} connection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      }
    },
    async signTransaction(input: SignTransactionInput): Promise<SorokitResult<string>> {
      try {
        return ok(await driver.approveSignature(input));
      } catch (cause) {
        return err(
          SorokitErrorCode.WALLET_SIGN_FAILED,
          `${driver.label} signing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      }
    },
    async disconnect(): Promise<SorokitResult<undefined>> {
      try {
        await driver.close();
        return ok(undefined);
      } catch (cause) {
        return err(
          SorokitErrorCode.WALLET_CONNECT_FAILED,
          `${driver.label} close failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      }
    },
  };
}
