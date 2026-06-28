import { bench, describe } from "vitest";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { estimateFee } from "../../transaction/estimateFee";
import { getAccount } from "../../account/getAccount";
import { simulateTransaction } from "../../soroban/simulateTransaction";
import { benchmarkBaselines } from "./benchmarkHarness";

function getBaseline(name: string) {
  const baseline = benchmarkBaselines[name];
  if (!baseline) {
    throw new Error(`No benchmark baseline found for ${name}`);
  }
  return baseline;
}

describe("performance benchmarks", () => {
  bench(
    "xdr parsing",
    () => {
      TransactionBuilder.fromXDR("AAAAAQAAAAA=", "Test SDF Network ; September 2015");
    },
    { iterations: getBaseline("xdrParsing").iterations },
  );

  bench(
    "fee calculation",
    async () => {
      await estimateFee(
        "https://rpc.testnet.stellar.org",
        "https://horizon.testnet.stellar.org",
        {
          network: "testnet",
          horizonUrl: "https://horizon.testnet.stellar.org",
          rpcUrl: "https://rpc.testnet.stellar.org",
          networkPassphrase: "Test SDF Network ; September 2015",
        },
        {
          kind: "payment",
          publicKey: "GB3N7LQ3X4PSM6V6Y4N2W4R3EJ7B3X6JDA4L2W2Y2D5F5VJ3L5MZQW",
          destination: "GDKP2X2U3F4R5J6Q7T8V9W0X1Y2Z3A4B5C6D7E8F9G0H1J2K3L4M5N6P7",
          amount: "1",
        },
      );
    },
    { iterations: getBaseline("feeCalculation").iterations },
  );

  bench(
    "account fetch",
    async () => {
      await getAccount(
        "https://horizon.testnet.stellar.org",
        "GB3N7LQ3X4PSM6V6Y4N2W4R3EJ7B3X6JDA4L2W2Y2D5F5VJ3L5MZQW",
      );
    },
    { iterations: getBaseline("accountFetch").iterations },
  );

  bench(
    "contract simulation",
    async () => {
      await simulateTransaction(
        "https://rpc.testnet.stellar.org",
        "Test SDF Network ; September 2015",
        "AAAAAQAAAAA=",
      );
    },
    { iterations: getBaseline("contractSimulation").iterations },
  );
});
