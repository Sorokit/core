import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";

/**
 * The result of a fee estimation.
 */
export interface FeeEstimate {
  /** Estimated fee in stroops (string to preserve precision) */
  fee: string;
  /** Estimated fee as a float for display convenience */
  feeFloat: number;
  /** Estimated fee in XLM (stroops / 10_000_000) */
  feeXlm: string;
  /** Base fee used as the floor (in stroops) */
  baseFee: string;
  /** Whether the estimate came from a simulation (true) or is just the base fee (false) */
  simulated: boolean;
}

/**
 * Input for fee estimation.
 * Provide either a pre-built XDR or a simple payment description.
 */
export type FeeEstimateInput =
  | {
      kind: "xdr";
      /** Pre-built unsigned transaction XDR to simulate */
      transactionXdr: string;
    }
  | {
      kind: "payment";
      /** Source account public key — used to build a sample transaction */
      publicKey: string;
      /** Destination account */
      destination: string;
      /** Amount in XLM or asset units */
      amount: string;
      /** Asset code — defaults to XLM */
      assetCode?: string;
      /** Asset issuer — required for non-native assets */
      assetIssuer?: string;
    };

/**
 * Estimate the fee for a transaction using Soroban RPC simulation.
 *
 * Two modes:
 * 1. Pass a pre-built `transactionXdr` — simulates it directly.
 * 2. Pass `publicKey`, `destination`, `amount` — builds a sample payment
 *    transaction and simulates that.
 *
 * Falls back to BASE_FEE if simulation is unavailable.
 *
 * @example
 * // From XDR
 * const result = await estimateFee(rpcUrl, horizonUrl, networkConfig, { transactionXdr: xdr });
 *
 * @example
 * // From payment params
 * const result = await estimateFee(rpcUrl, horizonUrl, networkConfig, {
 *   publicKey: "G...",
 *   destination: "G...",
 *   amount: "10",
 * });
 */
export async function estimateFee(
  rpcUrl: string,
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  input: FeeEstimateInput,
): Promise<SorokitResult<FeeEstimate>> {
  try {
    let xdr: string;

    if (input.kind === "xdr") {
      xdr = input.transactionXdr;
    } else {
      // Build a minimal sample payment transaction to simulate
      const { publicKey, destination, amount, assetCode, assetIssuer } = input;
      const horizonServer = new Horizon.Server(horizonUrl);
      const sourceAccount = await horizonServer.loadAccount(publicKey);

      let asset: Asset;
      if (!assetCode || assetCode.toUpperCase() === "XLM") {
        asset = Asset.native();
      } else {
        if (!assetIssuer) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Asset issuer is required for non-native asset: ${assetCode}`,
          );
        }
        asset = new Asset(assetCode, assetIssuer);
      }

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: networkConfig.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination,
            asset,
            amount,
          }),
        )
        .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
        .build();

      xdr = tx.toXDR();
    }

    // Simulate via Soroban RPC
    const rpc = new SorobanRpc.Server(rpcUrl);
    const tx = TransactionBuilder.fromXDR(xdr, networkConfig.networkPassphrase);
    const simResult = await rpc.simulateTransaction(tx);

    let feeStroops: number;
    let simulated = true;

    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      feeStroops = parseInt(simResult.minResourceFee ?? BASE_FEE, 10);
      // Add base fee on top of resource fee for total
      feeStroops += parseInt(BASE_FEE, 10);
    } else if (SorobanRpc.Api.isSimulationError(simResult)) {
      // Simulation failed — fall back to base fee
      feeStroops = parseInt(BASE_FEE, 10);
      simulated = false;
    } else {
      feeStroops = parseInt(BASE_FEE, 10);
      simulated = false;
    }

    const feeXlm = (feeStroops / 10_000_000).toFixed(7);

    return ok({
      fee: String(feeStroops),
      feeFloat: feeStroops,
      feeXlm,
      baseFee: BASE_FEE,
      simulated,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      `Fee estimation failed: ${toMessage(cause)}`,
      cause,
    );
  }
}
