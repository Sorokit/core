/**
 * Performance benchmarks for sorokit-core
 *
 * Baseline thresholds (measured on reference hardware, Node 20):
 *   XDR parsing          < 5ms per op
 *   fee calculation      < 1ms per op
 *   XDR validation       < 2ms per op
 *   address formatting   < 0.5ms per op
 *   result construction  < 0.1ms per op
 *
 * Acceptable regression threshold: 10% slower than baseline.
 * Run with: npm run bench
 */
import { bench, describe, vi } from "vitest";
import { ok, err, SorokitErrorCode, isOk, isErr } from "../../shared/response";
import { formatAddress, generateTraceId } from "../../shared/utils";
import { validateTransaction } from "../../transaction/validateTransaction";
import { createSorokitClient } from "../../client/createSorokitClient";

// ─── Mock stellar-sdk for pure benchmarks (no network I/O) ───────────────────

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    static fromXDR(_xdr: string, _passphrase: string) {
      return {
        fee: 100,
        networkPassphrase: "Test SDF Network ; September 2015",
        operations: [
          {
            type: "payment",
            destination: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
            amount: "10",
          },
        ],
      };
    }

    constructor(_source: unknown, _opts: unknown) {}
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return { toXDR: () => MOCK_XDR }; }
  }

  return {
    ...actual,
    TransactionBuilder: MockTransactionBuilder,
    StrKey: {
      ...actual.StrKey,
      isValidEd25519PublicKey: (key: string) => key.startsWith("G") && key.length === 56,
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_XDR = "AAAAAQAAAAA=";
const VALID_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

// ─── Benchmarks ───────────────────────────────────────────────────────────────

describe("result construction", () => {
  bench("ok() construction", () => {
    ok({ value: 42, name: "test" });
  });

  bench("err() construction", () => {
    err(SorokitErrorCode.TX_BUILD_FAILED, "Transaction build failed");
  });

  bench("isOk() type guard", () => {
    const result = ok("data");
    isOk(result);
  });

  bench("isErr() type guard", () => {
    const result = err(SorokitErrorCode.UNKNOWN, "error");
    isErr(result);
  });
});

describe("XDR parsing and validation", () => {
  bench("validateTransaction — valid XDR", () => {
    validateTransaction(MOCK_XDR, {
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });

  bench("validateTransaction — no rules", () => {
    validateTransaction(MOCK_XDR);
  });

  bench("validateTransaction — with custom rule", () => {
    validateTransaction(MOCK_XDR, {
      custom: [
        (ctx) => {
          if (ctx.fee < 100) {
            return { field: "fee", message: "too low", severity: "error" };
          }
          return null;
        },
      ],
    });
  });
});

describe("utility functions", () => {
  bench("formatAddress — default 4 chars", () => {
    formatAddress(VALID_PUBLIC_KEY);
  });

  bench("formatAddress — 6 chars", () => {
    formatAddress(VALID_PUBLIC_KEY, 6);
  });

  bench("generateTraceId", () => {
    generateTraceId();
  });
});

describe("client construction", () => {
  bench("createSorokitClient — testnet", () => {
    createSorokitClient({ network: "testnet" });
  });

  bench("createSorokitClient — mainnet with custom URLs", () => {
    createSorokitClient({
      network: "mainnet",
      horizonUrl: "https://horizon.stellar.org",
      rpcUrl: "https://soroban-rpc.stellar.org",
    });
  });
});

describe("fee calculation", () => {
  bench("fee arithmetic — stroops to XLM", () => {
    const stroops = 1100;
    void (stroops / 10_000_000).toFixed(7);
  });

  bench("fee arithmetic — batch of 100 calculations", () => {
    for (let i = 0; i < 100; i++) {
      const stroops = 100 + i * 10;
      void (stroops / 10_000_000).toFixed(7);
    }
  });
});
