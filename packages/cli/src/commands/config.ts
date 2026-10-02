import { Command } from "commander";
import { getConfigPath, loadConfig, redactedConfig, saveConfig } from "../lib/config.js";
import type { NetworkName, SorokitCliConfig } from "../lib/config.js";
import { printResult, printError } from "../lib/output.js";

const VALID_NETWORKS: NetworkName[] = ["mainnet", "testnet", "futurenet"];
const VALID_KEYS = ["network", "secret", "horizonUrl", "rpcUrl"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

function isConfigKey(key: string): key is ConfigKey {
  return (VALID_KEYS as readonly string[]).includes(key);
}

export function registerConfigCommand(program: Command): void {
  program
    .command("config")
    .description("Show or set CLI configuration (network, secret key, endpoint overrides)")
    .option("--set <keyValue>", "set a config value, e.g. --set network=testnet")
    .option("--json", "output as JSON")
    .action((options: { set?: string; json?: boolean }) => {
      const json = Boolean(options.json);
      const config = loadConfig();

      if (!options.set) {
        printResult({ path: getConfigPath(), ...redactedConfig(config) }, json);
        return;
      }

      const eqIndex = options.set.indexOf("=");
      if (eqIndex === -1) {
        printError('Expected --set in the form key=value, e.g. --set network=testnet', json);
        process.exitCode = 1;
        return;
      }
      const key = options.set.slice(0, eqIndex);
      const value = options.set.slice(eqIndex + 1);

      if (!isConfigKey(key)) {
        printError(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`, json);
        process.exitCode = 1;
        return;
      }
      if (key === "network" && !VALID_NETWORKS.includes(value as NetworkName)) {
        printError(`Invalid network "${value}". Valid networks: ${VALID_NETWORKS.join(", ")}`, json);
        process.exitCode = 1;
        return;
      }

      const updated: SorokitCliConfig = { ...config, [key]: value };
      saveConfig(updated);
      printResult({ path: getConfigPath(), ...redactedConfig(updated) }, json);
    });
}
