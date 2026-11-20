import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildFromSep7Uri,
  buildSep7SigningRedirect,
  createSep7SigningRedirect,
  encodeSep7TransactionXdr,
  generateSep7Uri,
  isValidSep7XdrBase64,
  parseSep7Uri,
  validateSep7CallbackUrl,
  validateSep7Uri,
} from "./sep7Handler";
import { isErr, isOk } from "../shared/response";

const source = Keypair.random();
const destination = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();

function transaction(operation: "payment" | "manageSellOffer" = "payment") {
  const builder = new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);

  if (operation === "payment") {
    builder.addOperation(
      Operation.payment({ destination, asset: Asset.native(), amount: "1" }),
    );
  } else {
    builder.addOperation(
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: new Asset("USDC", issuer),
        amount: "10",
        price: "1.5",
        offerId: "0",
      }),
    );
  }
  return builder.build();
}

describe("SEP-7 signing flow (#900)", () => {
  it("encodes transaction XDR as canonical base64", () => {
    for (const op of ["payment", "manageSellOffer"] as const) {
      const tx = transaction(op);
      const result = encodeSep7TransactionXdr(tx);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;

      expect(result.data).toBe(tx.toXDR());
      expect(isValidSep7XdrBase64(result.data)).toBe(true);
      expect(
        TransactionBuilder.fromXDR(result.data, Networks.TESTNET).hash().equals(tx.hash()),
      ).toBe(true);
    }
  });

  it.each(["not base64!", "AAAA*", "  AAAA", "AAAA%2B", "AB=="])(
    "rejects non-canonical XDR base64 %s",
    (xdr) => {
      expect(isValidSep7XdrBase64(xdr)).toBe(false);
    },
  );

  it("validates callback URLs before accepting them", () => {
    const valid = validateSep7CallbackUrl("url:https://example.com/callback?x=1");
    expect(valid.status).toBe("ok");
    if (valid.status === "ok") {
      expect(valid.data).toBe("https://example.com/callback?x=1");
    }

    const encoded = validateSep7CallbackUrl("url:https%3A%2F%2Fexample.com%2Fcb");
    expect(encoded.status).toBe("ok");

    for (const invalid of [
      "https://example.com/callback",
      "url:http://example.com/callback",
      "url:javascript:alert(1)",
      "url:/relative/path",
      "url:https://user:pass@example.com/callback",
      "url:https://",
      "url:https://example.com/%E0%A4%A",
    ]) {
      const result = validateSep7CallbackUrl(invalid);
      expect(result.status).toBe("error");
    }
  });

  it("creates a deeplink with a validated callback and round-trips it", async () => {
    const tx = transaction();
    const redirectResult = createSep7SigningRedirect(tx, {
      callback: "url:https://example.com/callback",
      pubkey: source.publicKey(),
      msg: "Approve payment",
      originDomain: "https://merchant.example.com",
      networkPassphrase: Networks.TESTNET,
    });

    expect(redirectResult.status).toBe("ok");
    if (redirectResult.status !== "ok") return;
    expect(redirectResult.data.callbackUrl).toBe("https://example.com/callback");
    expect(redirectResult.data.uri).toContain("web+stellar:tx?");

    const parseResult = parseSep7Uri(redirectResult.data.uri);
    expect(parseResult.status).toBe("ok");
    if (parseResult.status !== "ok") return;
    expect(parseResult.data.operation).toBe("tx");
    expect(parseResult.data.callback).toBe("url:https://example.com/callback");
    expect(parseResult.data.pubkey).toBe(source.publicKey());
    expect(parseResult.data.origin_domain).toBe("merchant.example.com");

    const validationResult = validateSep7Uri(redirectResult.data.uri);
    expect(isOk(validationResult) && validationResult.data.valid).toBe(true);

    const buildResult = await buildFromSep7Uri(redirectResult.data.uri);
    expect(buildResult.status).toBe("ok");
    if (buildResult.status === "ok") {
      expect(buildResult.data.hash().equals(tx.hash())).toBe(true);
    }
  });

  it("exposes the redirect builder under its alias", () => {
    expect(buildSep7SigningRedirect).toBe(createSep7SigningRedirect);
  });

  it("rejects unsafe callbacks in generated deeplinks", () => {
    const result = createSep7SigningRedirect(transaction(), {
      callback: "url:http://example.com/callback",
    });
    expect(result.status).toBe("error");
    if (isErr(result)) expect(result.error.message).toContain("HTTPS");
  });

  it("rejects invalid XDR and callbacks in validateSep7Uri", () => {
    const badXdr = validateSep7Uri(`web+stellar:tx?xdr=${encodeURIComponent("not base64!")}`);
    expect(isOk(badXdr) && !badXdr.data.valid).toBe(true);

    const undecodable = validateSep7Uri(
      `web+stellar:tx?xdr=${encodeURIComponent(Buffer.from("not a transaction").toString("base64"))}`,
    );
    expect(isOk(undecodable) && !undecodable.data.valid).toBe(true);

    const badCallback = validateSep7Uri(
      `web+stellar:pay?destination=${destination}&callback=url%3Ahttp%3A%2F%2Fexample.com%2Fcb`,
    );
    expect(isOk(badCallback) && !badCallback.data.valid).toBe(true);
  });

  it("refuses to generate a URI with invalid XDR or callback", () => {
    const badXdr = generateSep7Uri({ operation: "tx", xdr: "!!!!" });
    expect(isErr(badXdr)).toBe(true);

    const badCallback = generateSep7Uri({
      operation: "pay",
      destination,
      callback: "url:javascript:alert(1)",
    });
    expect(isErr(badCallback)).toBe(true);
  });
});
