import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { friendbotUrlFor, CliError } from "../lib/client.js";
import { printResult, printError } from "../lib/output.js";

export function registerFundCommand(program: Command): void {
  program
    .command("fund <address>")
    .description("Fund a testnet or futurenet account via Friendbot")
    .option("--json", "output as JSON")
    .action(async (address: string, options: { json?: boolean }) => {
      const json = Boolean(options.json);
      try {
        const config = loadConfig();
        const friendbotUrl = friendbotUrlFor(config.network);
        if (!friendbotUrl) {
          throw new CliError(
            `Friendbot funding is not available on "${config.network}" (mainnet has no faucet). ` +
              "Switch networks with `sorokit config --set network=testnet`.",
          );
        }

        const response = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(address)}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new CliError(
            `Friendbot request failed (HTTP ${response.status}): ${JSON.stringify(body)}`,
          );
        }
        printResult({ address, network: config.network, hash: body.hash ?? null }, json);
      } catch (cause) {
        printError(cause instanceof CliError ? cause.message : String(cause), json);
        process.exitCode = 1;
      }
    });
}
