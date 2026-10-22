import type { SorokitClient, SorokitClientConfig } from "./client/createSorokitClient";
import { toSorokitResult } from "./shared/response";
import type { SorokitResult } from "./shared/response";

/**
 * Lightweight entry point for the Sorokit SDK.
 *
 * ## Required opt-in configuration
 *
 * Creating a client does not implicitly enable optional subsystems:
 *
 * - Telemetry is inactive until `initTelemetry({ serviceName: "..." })` is
 *   called. Telemetry helpers intentionally no-op before initialization.
 * - Wallet operations require an adapter supplied to the wallet operation (or
 *   an explicit adapter registration through the wallet module); the client
 *   factory does not silently discover a wallet.
 * - Network-dependent operations require the corresponding Horizon/RPC URL
 *   and network passphrase in `network`.
 *
 * Every client factory and operation uses the same `SorokitResult<T>` envelope:
 * inspect `result.status === "ok"` before reading `result.data`; errors are
 * returned in `result.error` rather than thrown. For third-party callbacks or
 * legacy throwing helpers, use `toSorokitResult(() => operation())` at the
 * boundary to preserve that contract.
 */
export async function createSorokitClient(
  config: SorokitClientConfig,
): Promise<SorokitResult<SorokitClient>> {
  try {
    const clientModule = await import("./client/createSorokitClient");
    return clientModule.createSorokitClient(config);
  } catch (cause) {
    return toSorokitResult(() => {
      throw cause;
    });
  }
}

export type { SorokitClient, SorokitClientConfig };
