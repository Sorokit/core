import { readFileSync } from "node:fs";
import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";
import { signTransactionOffline } from "sorokit-core";
import { buildContractDeploy } from "sorokit-core/soroban";
import { loadConfig } from "../lib/config.js";
import { buildClient, requireSecret, CliError } from "../lib/client.js";
import { printResult, printError } from "../lib/output.js";

export function registerContractCommand(program: Command): void {
  const contract = program.command("contract").description("Soroban contract operations");

  contract
    .command("deploy <wasmPath>")
    .description("Deploy a compiled .wasm contract, signed by the configured account")
    .option("--secret <secret>", "override the configured secret key for this call")
    .option("--json", "output as JSON")
    .action(async (wasmPath: string, options: { secret?: string; json?: boolean }) => {
      const json = Boolean(options.json);
      try {
        const config = loadConfig();
        const secret = options.secret ?? requireSecret(config);
        const keypair = Keypair.fromSecret(secret);
        const client = buildClient(config);

        let wasmBuffer: Buffer;
        try {
          wasmBuffer = readFileSync(wasmPath);
        } catch (cause) {
          throw new CliError(`Could not read WASM file at "${wasmPath}": ${String(cause)}`);
        }

        const deployResult = await buildContractDeploy(wasmBuffer, keypair.publicKey(), {
          rpcUrl: client.networkConfig.rpcUrl,
          horizonUrl: client.networkConfig.horizonUrl,
          networkConfig: client.networkConfig,
        });
        if (deployResult.status === "error") {
          throw new CliError(`Failed to build deployment: ${deployResult.error.message}`);
        }

        const signResult = signTransactionOffline(
          deployResult.data.transactionXdr,
          secret,
          client.networkConfig.networkPassphrase,
        );
        if (signResult.status === "error") {
          throw new CliError(`Failed to sign deployment: ${signResult.error.message}`);
        }

        const submitResult = await client.transaction.submit(signResult.data);
        if (submitResult.status === "error") {
          throw new CliError(`Failed to submit deployment: ${submitResult.error.message}`);
        }

        printResult(
          {
            ...submitResult.data,
            note:
              "Deployment submitted. This CLI does not yet compute the resulting " +
              "contract ID locally — look it up by transaction hash via `sorokit tx <hash>` " +
              "or a block explorer.",
          },
          json,
        );
      } catch (cause) {
        printError(cause instanceof CliError ? cause.message : String(cause), json);
        process.exitCode = 1;
      }
    });
}
