import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";
import { signTransactionOffline } from "sorokit-core";
import { loadConfig } from "../lib/config.js";
import { buildClient, requireSecret, CliError } from "../lib/client.js";
import { printResult, printError } from "../lib/output.js";

export function registerPayCommand(program: Command): void {
  program
    .command("pay <destination> <amount>")
    .description("Send a native XLM payment from the configured account")
    .option("--secret <secret>", "override the configured secret key for this call")
    .option("--memo <memo>", "attach a text memo")
    .option("--json", "output as JSON")
    .action(
      async (
        destination: string,
        amount: string,
        options: { secret?: string; memo?: string; json?: boolean },
      ) => {
        const json = Boolean(options.json);
        try {
          const config = loadConfig();
          const secret = options.secret ?? requireSecret(config);
          const keypair = Keypair.fromSecret(secret);
          const client = buildClient(config);

          const buildResult = await client.transaction.buildPayment(keypair.publicKey(), {
            destination,
            amount,
            ...(options.memo ? { memo: options.memo } : {}),
          });
          if (buildResult.status === "error") {
            throw new CliError(`Failed to build payment: ${buildResult.error.message}`);
          }

          const signResult = signTransactionOffline(
            buildResult.data,
            secret,
            client.networkConfig.networkPassphrase,
          );
          if (signResult.status === "error") {
            throw new CliError(`Failed to sign payment: ${signResult.error.message}`);
          }

          const submitResult = await client.transaction.submit(signResult.data);
          if (submitResult.status === "error") {
            throw new CliError(`Failed to submit payment: ${submitResult.error.message}`);
          }

          printResult(submitResult.data, json);
        } catch (cause) {
          printError(cause instanceof CliError ? cause.message : String(cause), json);
          process.exitCode = 1;
        }
      },
    );
}
