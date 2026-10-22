import { describe, it, expect } from "vitest";
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";
import {
  generateSep10Nonce,
  generateSep10Challenge,
} from "../integration/sep10Auth";

describe("SEP-10 challenge generation & nonce randomization (#861)", () => {
  const serverKey = Keypair.random();
  const clientKey = Keypair.random();
  const homeDomain = "example.com";
  const networkPassphrase = Networks.TESTNET;

  it("generates cryptographically secure nonces of specified length", () => {
    const nonce1 = generateSep10Nonce();
    const nonce2 = generateSep10Nonce();

    expect(nonce1).toBeInstanceOf(Buffer);
    expect(nonce1.length).toBe(48); // 48 bytes per SEP-10
    expect(nonce2.length).toBe(48);
    expect(nonce1.equals(nonce2)).toBe(false); // Unique
  });

  it("generates unique challenge transactions preventing replay attacks", () => {
    const challenges = new Set<string>();
    const nonces = new Set<string>();

    for (let i = 0; i < 25; i++) {
      const res = generateSep10Challenge(serverKey, clientKey.publicKey(), homeDomain, {
        networkPassphrase,
      });

      expect(res.status).toBe("ok");
      if (res.status !== "ok") return;

      expect(challenges.has(res.data)).toBe(false);
      challenges.add(res.data);

      const parsed = WebAuth.readChallengeTx(
        res.data,
        serverKey.publicKey(),
        networkPassphrase,
        homeDomain,
        homeDomain,
      );

      // Verify the parsed challenge
      expect(parsed.clientAccountID).toBe(clientKey.publicKey());
      const op = parsed.tx.operations[0] as { value?: Buffer | string };
      const nonceStr = Buffer.isBuffer(op?.value)
        ? op.value.toString("base64")
        : String(op?.value);
      expect(nonces.has(nonceStr)).toBe(false);
      nonces.add(nonceStr);
    }

    expect(challenges.size).toBe(25);
    expect(nonces.size).toBe(25);
  });

  it("produces challenges verifiable by WebAuth.readChallengeTx and signed by server", () => {
    const res = generateSep10Challenge(serverKey, clientKey.publicKey(), homeDomain, {
      networkPassphrase,
      timeoutSec: 600,
    });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    const parsed = WebAuth.readChallengeTx(
      res.data,
      serverKey.publicKey(),
      networkPassphrase,
      homeDomain,
      homeDomain,
    );

    expect(parsed.clientAccountID).toBe(clientKey.publicKey());
    expect(WebAuth.verifyTxSignedBy(parsed.tx, serverKey.publicKey())).toBe(true);
  });

  it("rejects an invalid client public key", () => {
    const res = generateSep10Challenge(serverKey, "not-a-valid-key", homeDomain);
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.code).toBe("INVALID_ADDRESS");
    }
  });

  it("rejects an empty homeDomain", () => {
    const res = generateSep10Challenge(serverKey, clientKey.publicKey(), "");
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.code).toBe("INVALID_CONFIG");
    }
  });
});
