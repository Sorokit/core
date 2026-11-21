import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  connectAlbedo,
  type AlbedoIntentProvider,
} from "../wallet/adapters/albedoAdapter";
import { SorokitErrorCode } from "../shared/response";

describe("Albedo web wallet adapter (#923)", () => {
  const validPublicKey = Keypair.random().publicKey();

  function createMockAlbedoProvider(
    overrides?: Partial<AlbedoIntentProvider>,
  ): AlbedoIntentProvider {
    return {
      publicKey: vi.fn(async () => ({
        pubkey: validPublicKey,
        session: "sess-1",
      })),
      tx: vi.fn(async (opts) => ({
        signed_envelope_xdr: `signed:${opts.xdr}`,
        tx_hash: "deadbeef1234",
        network: opts.network,
      })),
      signMessage: vi.fn(async (opts) => ({
        message: opts.message,
        pubkey: opts.pubkey ?? validPublicKey,
        message_signature: "sig-hex-998877",
      })),
      ...overrides,
    };
  }

  it("connects to Albedo, retrieves account, signs transactions, and signs messages", async () => {
    const provider = createMockAlbedoProvider();
    const connectRes = await connectAlbedo({
      provider,
      network: "testnet",
    });

    expect(connectRes.status).toBe("ok");
    if (connectRes.status !== "ok") return;

    const session = connectRes.data;
    const accountRes = await session.getAccount();
    expect(accountRes).toEqual({
      status: "ok",
      data: validPublicKey,
      error: null,
    });

    const txRes = await session.signTransaction("AAAAAgAAAABtestXdr==", {
      description: "Test payment",
    });
    expect(txRes.status).toBe("ok");
    if (txRes.status === "ok") {
      expect(txRes.data.signedXdr).toBe("signed:AAAAAgAAAABtestXdr==");
      expect(txRes.data.txHash).toBe("deadbeef1234");
      expect(txRes.data.network).toBe("testnet");
      expect(txRes.data.signerPublicKey).toBe(validPublicKey);
    }

    const msgRes = await session.signMessage("Authenticate with Sorokit");
    expect(msgRes.status).toBe("ok");
    if (msgRes.status === "ok") {
      expect(msgRes.data.message).toBe("Authenticate with Sorokit");
      expect(msgRes.data.publicKey).toBe(validPublicKey);
      expect(msgRes.data.messageSignature).toBe("sig-hex-998877");
    }
  });

  it("handles user rejection and invalid inputs gracefully with SorokitResult", async () => {
    const rejectingProvider = createMockAlbedoProvider({
      tx: vi.fn(async () => {
        throw new Error("User rejected action");
      }),
    });

    const connectRes = await connectAlbedo({ provider: rejectingProvider });
    expect(connectRes.status).toBe("ok");
    if (connectRes.status !== "ok") return;

    const session = connectRes.data;
    const emptyXdrRes = await session.signTransaction("   ");
    expect(emptyXdrRes.status).toBe("error");
    if (emptyXdrRes.status === "error") {
      expect(emptyXdrRes.error.code).toBe(SorokitErrorCode.XDR_INVALID);
    }

    const rejectedTx = await session.signTransaction("AAAAAgAAAABtestXdr==");
    expect(rejectedTx.status).toBe("error");
    if (rejectedTx.status === "error") {
      expect(rejectedTx.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    }

    const emptyMsg = await session.signMessage("");
    expect(emptyMsg.status).toBe("error");
  });
});
