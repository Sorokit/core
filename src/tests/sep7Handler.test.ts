import { describe, it, expect } from "vitest";
import {
  parseSep7Uri,
  validateSep7Uri,
  buildFromSep7Uri,
  generateSep7Uri,
} from "../integration/sep7Handler";
import { isOk, isErr } from "../shared/response";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Account,
  BASE_FEE,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";

describe("SEP-7 URI Scheme Handler (#602)", () => {
  const sampleKeypair = Keypair.random();
  const validDestination = sampleKeypair.publicKey();
  const sourceAccount = Keypair.random().publicKey();

  describe("parseSep7Uri", () => {
    it("should parse a valid pay URI with all parameters", () => {
      const uri = `web+stellar:pay?destination=${validDestination}&amount=100.50&asset_code=USDC&asset_issuer=${validDestination}&memo=Payment123&memo_type=text&msg=Thanks`;
      const result = parseSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.data.operation === "pay") {
        expect(result.data.destination).toBe(validDestination);
        expect(result.data.amount).toBe("100.50");
        expect(result.data.asset_code).toBe("USDC");
        expect(result.data.asset_issuer).toBe(validDestination);
        expect(result.data.memo).toBe("Payment123");
        expect(result.data.memo_type).toBe("text");
        expect(result.data.msg).toBe("Thanks");
      }
    });

    it("should parse stellar: scheme prefix and native payment", () => {
      const uri = `stellar:pay?destination=${validDestination}&amount=50`;
      const result = parseSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.data.operation === "pay") {
        expect(result.data.destination).toBe(validDestination);
        expect(result.data.amount).toBe("50");
        expect(result.data.asset_code).toBeUndefined();
      }
    });

    it("should parse tx URI with encoded XDR", () => {
      const account = new Account(sourceAccount, "1000");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: validDestination,
            asset: Asset.native(),
            amount: "10",
          }),
        )
        .setTimeout(30)
        .build();

      const xdr = tx.toXDR();
      const uri = `web+stellar:tx?xdr=${encodeURIComponent(xdr)}&pubkey=${sourceAccount}`;
      const result = parseSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.data.operation === "tx") {
        expect(result.data.xdr).toBe(xdr);
        expect(result.data.pubkey).toBe(sourceAccount);
      }
    });

    it("should parse change_trust URI", () => {
      const uri = `web+stellar:change_trust?asset_code=USDC&asset_issuer=${validDestination}&limit=50000`;
      const result = parseSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.data.operation === "change_trust") {
        expect(result.data.asset_code).toBe("USDC");
        expect(result.data.asset_issuer).toBe(validDestination);
        expect(result.data.limit).toBe("50000");
      }
    });

    it("should parse manage_offer URI", () => {
      const uri = `web+stellar:manage_offer?selling_asset_code=XLM&buying_asset_code=USDC&buying_asset_issuer=${validDestination}&amount=100&price=0.25`;
      const result = parseSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.data.operation === "manage_offer") {
        expect(result.data.amount).toBe("100");
        expect(result.data.price).toBe("0.25");
      }
    });

    it("should return error for invalid scheme or missing required parameters", () => {
      expect(isErr(parseSep7Uri("https://example.com/pay"))).toBe(true);
      expect(isErr(parseSep7Uri("web+stellar:pay"))).toBe(true);
      expect(isErr(parseSep7Uri("web+stellar:tx"))).toBe(true);
      expect(isErr(parseSep7Uri("web+stellar:unknown_op?dest=123"))).toBe(true);
    });
  });

  describe("validateSep7Uri", () => {
    it("should validate a correct pay URI", () => {
      const uri = `web+stellar:pay?destination=${validDestination}&amount=25`;
      const result = validateSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.data.valid).toBe(true);
        expect(result.data.errors.length).toBe(0);
      }
    });

    it("should report errors for invalid destination or negative amount", () => {
      const uri = `web+stellar:pay?destination=invalid_addr&amount=-10`;
      const result = validateSep7Uri(uri);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.data.valid).toBe(false);
        expect(result.data.errors.some((e) => e.includes("Invalid destination"))).toBe(true);
        expect(result.data.errors.some((e) => e.includes("Invalid amount"))).toBe(true);
      }
    });

    it("should validate callback parameter protocol", () => {
      const validCallback = `web+stellar:pay?destination=${validDestination}&callback=url:https%3A%2F%2Fexample.com%2Fcallback`;
      const valResult1 = validateSep7Uri(validCallback);
      expect(isOk(valResult1) && valResult1.data.valid).toBe(true);

      const invalidCallback = `web+stellar:pay?destination=${validDestination}&callback=https://example.com/callback`;
      const valResult2 = validateSep7Uri(invalidCallback);
      expect(isOk(valResult2) && valResult2.data.valid).toBe(false);
    });
  });

  describe("buildFromSep7Uri", () => {
    it("should build a Transaction from a pay URI", async () => {
      const uri = `web+stellar:pay?destination=${validDestination}&amount=15.75&memo=Invoice42&memo_type=text`;
      const result = await buildFromSep7Uri(uri, {
        sourceAccount,
        sequenceNumber: "100",
        networkPassphrase: Networks.TESTNET,
      });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        const tx = result.data as any;
        expect(tx.operations.length).toBe(1);
        expect(tx.operations[0].type).toBe("payment");
        expect(tx.operations[0].destination).toBe(validDestination);
        expect(tx.operations[0].amount).toBe("15.7500000");
        expect(tx.memo.value).toBe("Invoice42");
      }
    });

    it("should build a Transaction from a change_trust URI", async () => {
      const uri = `web+stellar:change_trust?asset_code=EURC&asset_issuer=${validDestination}&limit=100000`;
      const result = await buildFromSep7Uri(uri, {
        sourceAccount,
        sequenceNumber: "100",
        networkPassphrase: Networks.TESTNET,
      });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        const tx = result.data as any;
        expect(tx.operations[0].type).toBe("changeTrust");
        expect(tx.operations[0].line.code).toBe("EURC");
      }
    });

    it("should fail build when sourceAccount is missing", async () => {
      const uri = `web+stellar:pay?destination=${validDestination}&amount=10`;
      const result = await buildFromSep7Uri(uri);

      expect(isErr(result)).toBe(true);
    });
  });

  describe("generateSep7Uri", () => {
    it("should round-trip generate and parse SEP-7 pay URI", () => {
      const generated = generateSep7Uri({
        operation: "pay",
        destination: validDestination,
        amount: "42.00",
        msg: "Coffee",
      });

      expect(isOk(generated)).toBe(true);
      if (isOk(generated)) {
        const parsed = parseSep7Uri(generated.data);
        expect(isOk(parsed)).toBe(true);
        if (isOk(parsed) && parsed.data.operation === "pay") {
          expect(parsed.data.destination).toBe(validDestination);
          expect(parsed.data.amount).toBe("42.00");
          expect(parsed.data.msg).toBe("Coffee");
        }
      }
    });
  });
});
