import { createSorokitClient } from "sorokit-core";
import type { SorokitCliConfig } from "./config.js";

export function buildClient(config: SorokitCliConfig) {
  const result = createSorokitClient({
    network: config.network,
    ...(config.horizonUrl ? { horizonUrl: config.horizonUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  });
  if (result.status === "error") {
    throw new CliError(`Failed to create sorokit client: ${result.error.message}`);
  }
  return result.data;
}

const FRIENDBOT_URLS: Record<string, string> = {
  testnet: "https://friendbot.stellar.org",
  futurenet: "https://friendbot-futurenet.stellar.org",
};

export function friendbotUrlFor(network: string): string | null {
  return FRIENDBOT_URLS[network] ?? null;
}

export class CliError extends Error {}

export function requireSecret(config: SorokitCliConfig): string {
  if (!config.secret) {
    throw new CliError(
      "No secret key configured. Run `sorokit config --set secret=S...` first, " +
        "or pass --secret S... directly to this command.",
    );
  }
  return config.secret;
}
