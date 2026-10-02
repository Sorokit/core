import type { SorokitClient, SorokitClientConfig } from "./client/createSorokitClient";
import type { SorokitResult } from "./shared/response";

/**
 * Load the full Sorokit client asynchronously from the lightweight core entry.
 * Soroban and anchor integration operations remain split and load on demand.
 */
export async function createSorokitClient(
  config: SorokitClientConfig,
): Promise<SorokitResult<SorokitClient>> {
  const clientModule = await import("./client/createSorokitClient");
  return clientModule.createSorokitClient(config);
}

export type { SorokitClient, SorokitClientConfig };
