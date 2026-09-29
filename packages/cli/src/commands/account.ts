import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { buildClient, CliError } from "../lib/client.js";
import { printResult, printError } from "../lib/output.js";

export function registerAccountCommand(program: Command): void {
  program
    .command("account <address>")
    .description("Show account info: sequence, subentry count, and balances")
    .option("--json", "output as JSON")
    .action(async (address: string, options: { json?: boolean }) => {
      const json = Boolean(options.json);
      try {
        const config = loadConfig();
        const client = buildClient(config);
        const result = await client.account.get(address);
        if (result.status === "error") {
          printError(result.error.message, json);
          process.exitCode = 1;
          return;
        }
        printResult(result.data, json);
      } catch (cause) {
        printError(cause instanceof CliError ? cause.message : String(cause), json);
        process.exitCode = 1;
      }
    });
}
