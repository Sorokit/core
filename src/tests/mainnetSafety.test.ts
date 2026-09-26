import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Asset,
  Claimant,
  xdr,
} from "@stellar/stellar-sdk";
import {
  checkMainnetSafety,
  extractTransactionTotalXlm,
  isMainnetNetwork,
  DEFAULT_MAINNET_SAFETY_THRESHOLD_XLM,
  MAINNET_NETWORK_PASSPHRASE,
} from "../shared/mainnetSafety";
import { SorokitErrorCode } from "../shared/response";
import { createSorokitClient } from "../client/createSorokitClient";
import { submitTransaction } from "../transaction/submitTransaction";

const { horizonSubmit, horizonFactory, rpcSend } = vi.hoisted(() => ({
  horizonSubmit: vi.fn(),
  rpcSend: vi.fn(),
  horizonFactory: vi.fn(),
}));
vi.mock("../shared/serverFactory", async (importOriginal) => ({
  ...await importOriginal<typeof import("../shared/serverFactory")>(),
  createHorizonServer: horizonFactory,
  createSorobanServer: () => ({ sendTransaction: rpcSend, getTransaction: async () => ({ status: "SUCCESS" }) }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  rpcSend.mockResolvedValue({ status: "PENDING", hash: "rpc-hash" });
  horizonFactory.mockReturnValue({ submitTransaction: horizonSubmit });
  horizonSubmit.mockImplementation(async (tx) => ({
    hash: tx.hash().toString("hex"), ledger: 1,
    envelope_xdr: tx.toXDR(), result_xdr: "",
  }));
});

function createSignedPaymentXdr(
  amount: string,
  networkPassphrase: string = Networks.TESTNET,
): string {
  const keypair = Keypair.random();
  const tx = new TransactionBuilder(new Account(keypair.publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

function createSignedCreateAccountXdr(
  startingBalance: string,
  networkPassphrase: string = Networks.TESTNET,
): string {
  const keypair = Keypair.random();
  const tx = new TransactionBuilder(new Account(keypair.publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createAccount({
        destination: Keypair.random().publicKey(),
        startingBalance,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

describe("Mainnet Safety Guards (#577)", () => {
  describe("isMainnetNetwork", () => {
    it("returns true for Mainnet passphrase", () => {
      expect(isMainnetNetwork(MAINNET_NETWORK_PASSPHRASE)).toBe(true);
      expect(
        isMainnetNetwork("Public Global Stellar Network ; September 2015"),
      ).toBe(true);
    });

    it("returns false for Testnet, Futurenet, and custom passphrases", () => {
      expect(isMainnetNetwork(Networks.TESTNET)).toBe(false);
      expect(isMainnetNetwork(Networks.FUTURENET)).toBe(false);
      expect(isMainnetNetwork("Standalone Network")).toBe(false);
    });
  });

  describe("extractTransactionTotalXlm", () => {
    it("extracts XLM amount from payment operations", () => {
      const xdr = createSignedPaymentXdr("1500.5000000", MAINNET_NETWORK_PASSPHRASE);
      const total = extractTransactionTotalXlm(xdr, MAINNET_NETWORK_PASSPHRASE);
      expect(total).toBe(1500.5);
    });

    it("extracts XLM amount from createAccount operations", () => {
      const xdr = createSignedCreateAccountXdr("2500", MAINNET_NETWORK_PASSPHRASE);
      const total = extractTransactionTotalXlm(xdr, MAINNET_NETWORK_PASSPHRASE);
      expect(total).toBe(2500);
    });

    it("ignores non-native asset payments", () => {
      const keypair = Keypair.random();
      const customAsset = new Asset("USDC", Keypair.random().publicKey());
      const tx = new TransactionBuilder(new Account(keypair.publicKey(), "1"), {
        fee: BASE_FEE,
        networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: Keypair.random().publicKey(),
            asset: customAsset,
            amount: "10000.0000000",
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(keypair);
      const total = extractTransactionTotalXlm(
        tx.toXDR(),
        MAINNET_NETWORK_PASSPHRASE,
      );
      expect(total).toBe(0);
    });
  });

  describe("checkMainnetSafety", () => {
    it("allows transactions on Testnet regardless of amount", () => {
      const xdr = createSignedPaymentXdr("5000.0000000", Networks.TESTNET);
      const result = checkMainnetSafety(xdr, Networks.TESTNET);
      expect(result.status).toBe("ok");
    });

    it("allows transactions on Mainnet below default threshold (<= 1000 XLM)", () => {
      const xdr = createSignedPaymentXdr("500.0000000", MAINNET_NETWORK_PASSPHRASE);
      const result = checkMainnetSafety(xdr, MAINNET_NETWORK_PASSPHRASE);
      expect(result.status).toBe("ok");
    });

    it("returns MAINNET_SAFETY_LIMIT error when Mainnet transaction exceeds threshold without override", () => {
      const xdr = createSignedPaymentXdr("1500.0000000", MAINNET_NETWORK_PASSPHRASE);
      const result = checkMainnetSafety(xdr, MAINNET_NETWORK_PASSPHRASE);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.MAINNET_SAFETY_LIMIT);
        expect(result.error.message).toContain("Mainnet safety limit exceeded");
        expect(result.error.message).toContain("1500 XLM");
        expect(result.error.message).toContain("1000 XLM");
      }
    });

    it("allows transaction exceeding threshold when bypassMainnetSafety is true", () => {
      const xdr = createSignedPaymentXdr("5000.0000000", MAINNET_NETWORK_PASSPHRASE);
      const warnSpy = vi.fn();
      const customLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
      };

      const result = checkMainnetSafety(xdr, MAINNET_NETWORK_PASSPHRASE, {
        bypassMainnetSafety: true,
        logger: customLogger,
      });

      expect(result.status).toBe("ok");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("Mainnet Safety Warning");
    });

    it("honors custom threshold (e.g., 200 XLM)", () => {
      const xdr = createSignedPaymentXdr("300.0000000", MAINNET_NETWORK_PASSPHRASE);
      const result = checkMainnetSafety(xdr, MAINNET_NETWORK_PASSPHRASE, {
        mainnetSafetyThresholdXlm: 200,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.MAINNET_SAFETY_LIMIT);
        expect(result.error.message).toContain("200 XLM");
      }
    });
  });

  describe("submitTransaction Integration", () => {
    it("halts submission before Horizon when Mainnet transaction exceeds threshold", async () => {
      const xdr = createSignedPaymentXdr("2000.0000000", MAINNET_NETWORK_PASSPHRASE);

      const result = await submitTransaction(
        "https://horizon.stellar.org",
        MAINNET_NETWORK_PASSPHRASE,
        xdr,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.MAINNET_SAFETY_LIMIT);
      }
      expect(horizonFactory).not.toHaveBeenCalled();
      expect(horizonSubmit).not.toHaveBeenCalled();
    });

    it("proceeds past safety check when bypassMainnetSafety option is set", async () => {
      const xdr = createSignedPaymentXdr("2000.0000000", MAINNET_NETWORK_PASSPHRASE);

      const result = await submitTransaction(
        "https://invalid-horizon-url.test",
        MAINNET_NETWORK_PASSPHRASE,
        xdr,
        undefined,
        { bypassMainnetSafety: true },
      );

      expect(result.status).toBe("ok");
      expect(horizonSubmit).toHaveBeenCalledOnce();
    });
  });
});


describe("Mainnet safety regression coverage", () => {
  const source = Keypair.random();
  const destination = Keypair.random().publicKey();
  const credit = new Asset("USD", destination);
  const native = Asset.native();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  function build(operations: ReturnType<typeof Operation.payment>[]) {
    const builder = new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    });
    operations.forEach(op => builder.addOperation(op));
    const tx = builder.setTimeout(30).build();
    tx.sign(source);
    return tx;
  }
  function payment(amount: string) {
    return Operation.payment({ destination, asset: native, amount });
  }

  it.each([NaN, Infinity, -Infinity, -1, "1000"])("rejects invalid threshold %s", (threshold) => {
    const result = checkMainnetSafety(build([payment("2000")]).toXDR(), Networks.PUBLIC, {
      mainnetSafetyThresholdXlm: threshold as number, bypassMainnetSafety: true, logger,
    });
    expect(result).toMatchObject({ status: "error", error: { code: SorokitErrorCode.INVALID_CONFIG } });
  });

  it.each(["false", "true", 1, {}])("requires a literal true bypass: %s", (bypass) => {
    expect(checkMainnetSafety(build([payment("2000")]).toXDR(), Networks.PUBLIC, {
      bypassMainnetSafety: bypass as boolean, logger,
    })).toMatchObject({ status: "error", error: { code: SorokitErrorCode.MAINNET_SAFETY_LIMIT } });
  });

  it("allows an exact threshold total without warning and blocks one extra stroop", () => {
    const operations = [payment("999"), ...Array.from({ length: 10 }, () => payment("0.1"))];
    expect(checkMainnetSafety(build(operations).toXDR(), Networks.PUBLIC, { logger }).status).toBe("ok");
    expect(logger.warn).not.toHaveBeenCalled();
    operations.push(payment("0.0000001"));
    expect(checkMainnetSafety(build(operations).toXDR(), Networks.PUBLIC, { logger }))
      .toMatchObject({ status: "error", error: { code: SorokitErrorCode.MAINNET_SAFETY_LIMIT } });
  });

  it.each([0, 1e-8, 1e-7, 1.5e-7, 1e21])("compares custom threshold %s exactly", threshold => {
    const result = checkMainnetSafety(build([payment("0.0000001")]).toXDR(), Networks.PUBLIC, {
      mainnetSafetyThresholdXlm: threshold, logger,
    });
    expect(result.status).toBe(threshold < 1e-7 ? "error" : "ok");
  });

  it.each([Networks.TESTNET, Networks.FUTURENET, "Standalone Network", ` ${Networks.PUBLIC} `])(
    "skips safety checks for a non-mainnet passphrase %s", network => {
      expect(isMainnetNetwork(network)).toBe(false);
      expect(checkMainnetSafety("invalid", network, { logger }).status).toBe("ok");
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("rejects uninspectable mainnet envelopes", async () => {
    expect(() => extractTransactionTotalXlm("invalid", Networks.PUBLIC)).toThrow();
    expect(checkMainnetSafety("invalid", Networks.PUBLIC, { logger }))
      .toMatchObject({ status: "error", error: { code: SorokitErrorCode.XDR_INVALID } });
    expect((await submitTransaction("https://horizon.test", Networks.PUBLIC, "invalid")).status).toBe("error");
    expect(horizonFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["receive native destination", Operation.pathPaymentStrictReceive({ destination, sendAsset: credit, sendMax: "20", destAsset: native, destAmount: "1500" }), 1500],
    ["receive native source", Operation.pathPaymentStrictReceive({ destination, sendAsset: native, sendMax: "1600", destAsset: credit, destAmount: "20" }), 1600],
    ["send native source", Operation.pathPaymentStrictSend({ destination, sendAsset: native, sendAmount: "1700", destAsset: credit, destMin: "20" }), 1700],
    ["send native destination", Operation.pathPaymentStrictSend({ destination, sendAsset: credit, sendAmount: "20", destAsset: native, destMin: "1800" }), 1800],
    ["receive credit only", Operation.pathPaymentStrictReceive({ destination, sendAsset: credit, sendMax: "2000", destAsset: credit, destAmount: "1500" }), 0],
    ["send credit only", Operation.pathPaymentStrictSend({ destination, sendAsset: credit, sendAmount: "2000", destAsset: credit, destMin: "1500" }), 0],
    ["native claimable balance", Operation.createClaimableBalance({ asset: native, amount: "1900", claimants: [new Claimant(destination)] }), 1900],
    ["credit claimable balance", Operation.createClaimableBalance({ asset: credit, amount: "1900", claimants: [new Claimant(destination)] }), 0],
  ])("extracts and enforces %s", (_name, operation, expected) => {
    const xdr = build([operation]).toXDR();
    if (_name === "send native destination") {
      expect(() => extractTransactionTotalXlm(xdr, Networks.PUBLIC)).toThrow("Cannot bound native XLM");
    } else {
      expect(extractTransactionTotalXlm(xdr, Networks.PUBLIC)).toBe(expected);
    }
    expect(checkMainnetSafety(xdr, Networks.PUBLIC, { logger }).status).toBe(expected > 1000 ? "error" : "ok");
  });

  it("inspects fee-bump inner operations and logs source and operation count", () => {
    const inner = build([payment("900"), payment("900")]);
    const outer = TransactionBuilder.buildFeeBumpTransaction(Keypair.random().publicKey(), BASE_FEE, inner, Networks.PUBLIC);
    expect(checkMainnetSafety(outer.toXDR(), Networks.PUBLIC, { logger }).status).toBe("error");
    expect(checkMainnetSafety(outer.toXDR(), Networks.PUBLIC, { bypassMainnetSafety: true, logger }).status).toBe("ok");
    expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), {
      totalXlm: 1800, thresholdXlm: 1000, bypassMainnetSafety: true, unboundedOperations: [],
      operationCount: 2, sourceAccount: source.publicKey(),
    });
  });
});

describe("all operation families and public submission APIs", () => {
  const key = Keypair.random();
  const native = Asset.native();
  const credit = new Asset("USD", Keypair.random().publicKey());
  const destination = key.publicKey();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  function transaction(operation: ReturnType<typeof Operation.payment>, network = Networks.PUBLIC) {
    const tx = new TransactionBuilder(new Account(destination, "1"), {
      fee: BASE_FEE, networkPassphrase: network,
    }).addOperation(operation).setTimeout(30).build();
    tx.sign(key);
    return tx.toXDR();
  }

  it.each([
    ["sell", Operation.manageSellOffer({ selling: native, buying: credit, amount: "1001", price: "2" }), 1001],
    ["passive sell", Operation.createPassiveSellOffer({ selling: native, buying: credit, amount: "1001", price: "2" }), 1001],
    ["buy with XLM", Operation.manageBuyOffer({ selling: native, buying: credit, buyAmount: "501", price: { n: 2, d: 1 } }), 1002],
    ["buy XLM", Operation.manageBuyOffer({ selling: credit, buying: native, buyAmount: "1001", price: "2" }), 1001],
    ["credit-only offer", Operation.manageSellOffer({ selling: credit, buying: new Asset("EUR", destination), amount: "5000", price: "2" }), 0],
    ["deleted offer", Operation.manageSellOffer({ selling: credit, buying: native, amount: "0", price: "2", offerId: "1" }), 0],
    ["administrative operation", Operation.manageData({ name: "test", value: "value" }), 0],
    ["native path round trip", Operation.pathPaymentStrictReceive({ destination, sendAsset: native, sendMax: "1001", destAsset: native, destAmount: "10" }), 1001],
  ])("handles %s", (_name, operation, expected) => {
    const xdr = transaction(operation);
    expect(extractTransactionTotalXlm(xdr, Networks.PUBLIC)).toBe(expected);
    expect(checkMainnetSafety(xdr, Networks.PUBLIC, { logger }).status).toBe(expected > 1000 ? "error" : "ok");
  });

  it("inspects legacy v0 transaction envelopes", () => {
    const legacy = new xdr.TransactionV0({
      sourceAccountEd25519: key.rawPublicKey(), fee: 100,
      seqNum: xdr.SequenceNumber.fromString("2"), timeBounds: null,
      memo: xdr.Memo.memoNone(),
      operations: [Operation.payment({ destination, asset: native, amount: "2000" })],
      ext: new xdr.TransactionV0Ext(0),
    });
    const envelope = xdr.TransactionEnvelope.envelopeTypeTxV0(new xdr.TransactionV0Envelope({ tx: legacy, signatures: [] }));
    expect(checkMainnetSafety(envelope.toXDR("base64"), Networks.PUBLIC, { logger }))
      .toMatchObject({ status: "error", error: { code: SorokitErrorCode.MAINNET_SAFETY_LIMIT } });
  });

  it("rounds native offer ceilings up to the nearest stroop", () => {
    const xdr = transaction(Operation.manageBuyOffer({ selling: native, buying: credit, buyAmount: "3000.0000001", price: { n: 1, d: 3 } }));
    expect(checkMainnetSafety(xdr, Networks.PUBLIC, { logger }).status).toBe("error");
  });

  it.each([
    Operation.accountMerge({ destination }),
    Operation.claimClaimableBalance({ balanceId: "00000000" + "ab".repeat(32) }),
    Operation.liquidityPoolDeposit({ liquidityPoolId: "ab".repeat(32), maxAmountA: "10", maxAmountB: "20", minPrice: "1", maxPrice: "2" }),
    Operation.liquidityPoolWithdraw({ liquidityPoolId: "ab".repeat(32), amount: "10", minAmountA: "1", minAmountB: "1" }),
    Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from([0])), auth: [] }),
    Operation.manageSellOffer({ selling: credit, buying: native, amount: "1", price: "2" }),
    Operation.pathPaymentStrictSend({ destination, sendAsset: credit, sendAmount: "1", destAsset: native, destMin: "1" }),
  ])("requires confirmation when native exposure needs ledger state", operation => {
    const signed = transaction(operation);
    expect(checkMainnetSafety(signed, Networks.PUBLIC, { logger }))
      .toMatchObject({ status: "error", error: { code: SorokitErrorCode.MAINNET_SAFETY_LIMIT } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot be bounded"), expect.objectContaining({
      unboundedOperations: expect.any(Array), sourceAccount: destination, operationCount: 1,
    }));
    expect(checkMainnetSafety(signed, Networks.PUBLIC, { logger, bypassMainnetSafety: true }).status).toBe("ok");
    expect(checkMainnetSafety(signed, Networks.TESTNET, { logger }).status).toBe("ok");
  });

  it("supports the documented client alias, custom thresholds and per-call logger", async () => {
    const clientResult = createSorokitClient({ network: "mainnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") throw new Error("Client setup failed");
    const signed = transaction(Operation.payment({ destination, asset: native, amount: "600" }));
    const client = clientResult.data;
    const blocked = await client.transaction.submitTransaction(signed, { mainnetSafetyThresholdXlm: 500, logger });
    expect(blocked).toMatchObject({ status: "error", error: { code: SorokitErrorCode.MAINNET_SAFETY_LIMIT } });
    expect(horizonSubmit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect((await client.transaction.submitTransaction(signed, { mainnetSafetyThresholdXlm: 500, bypassMainnetSafety: true, logger })).status).toBe("ok");
    expect(horizonSubmit).toHaveBeenCalledOnce();
  });

  it("emits a Mainnet warning with default client logging settings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = createSorokitClient({ network: "mainnet" });
      if (result.status !== "ok") throw new Error("Client setup failed");
      await result.data.transaction.submit(transaction(Operation.payment({ destination, asset: native, amount: "2000" })));
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("guards Soroban RPC submission and accepts explicit confirmation", async () => {
    const signed = transaction(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from([0])), auth: [] }));
    const clientResult = createSorokitClient({ network: "mainnet", logger });
    if (clientResult.status !== "ok") throw new Error("Client setup failed");
    const client = clientResult.data;
    expect(await client.soroban.execute(signed, { intervalMs: 0 }))
      .toMatchObject({ status: "error", error: { code: SorokitErrorCode.MAINNET_SAFETY_LIMIT } });
    expect(rpcSend).not.toHaveBeenCalled();
    expect((await client.soroban.execute(signed, { intervalMs: 0 }, undefined, { bypassMainnetSafety: true })).status).toBe("ok");
    expect(rpcSend).toHaveBeenCalledOnce();
  });
});
