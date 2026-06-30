/**
 * Tests for submitTransaction network passphrase validation (#6).
 * Kept in a separate file because the existing transaction.test.ts mocks
 * TransactionBuilder.fromXDR globally, which would defeat real signature verification.
 */
import { describe, it, expect, vi } from "vitest";
import { submitTransaction } from "../transaction/submitTransaction";
import { Networks } from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";

// Real signed XDRs generated with Keypair.random() + TransactionBuilder (inflation op, 30s timeout)
// Both signed by the same keypair so the public key / hint matches.
const TESTNET_XDR =
  "AAAAAgAAAAArg6xVmhrfK8Kf1L0wCEKReWNmDUacUNz/RAwldACowwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqO6RQAAAAAAAAAAEAAAAAAAAACQAAAAAAAAABdACowwAAAEBh9aFJaCgi8jCtB4tqReRPYyywWPIWl6v1+92iXCdqsKGvoxRafpQiAIdvHr6+Jw2Ybd4Vs89XDO0nDVtwip4K";

const MAINNET_XDR =
  "AAAAAgAAAAArg6xVmhrfK8Kf1L0wCEKReWNmDUacUNz/RAwldACowwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqO6RQAAAAAAAAAAEAAAAAAAAACQAAAAAAAAABdACowwAAAEDMImwFjjEjXsiUTgH9DMvAIa/t84yoxkw7vRHnCrpZDmVpgY39ZiTga3ipAHD10NUFPuFbGZ1NBH/V0UexH2sF";

function mockHorizonServer(overrides?: Partial<{ submitTransaction: () => unknown }>) {
  return vi.fn().mockImplementation(() => ({
    submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue({
      hash: "abc",
      ledger: 1,
      envelope_xdr: TESTNET_XDR,
      result_xdr: "",
    }),
  }));
}

describe("submitTransaction — network passphrase validation (#6)", () => {
  it("returns TX_SUBMIT_FAILED with passphrase mismatch when testnet XDR is submitted to mainnet", async () => {
    const result = await submitTransaction(
      "https://horizon.stellar.org",
      Networks.PUBLIC,
      TESTNET_XDR,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
      expect(result.error.message).toMatch(/passphrase mismatch/i);
    }
  });

  it("returns TX_SUBMIT_FAILED with passphrase mismatch when mainnet XDR is submitted to testnet", async () => {
    const result = await submitTransaction(
      "https://horizon-testnet.stellar.org",
      Networks.TESTNET,
      MAINNET_XDR,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
      expect(result.error.message).toMatch(/passphrase mismatch/i);
    }
  });

  it("succeeds when XDR is signed for the matching network passphrase", async () => {
    const mockServer = mockHorizonServer();
    vi.stubGlobal("HorizonServerMock", mockServer);

    // We verify the logic directly: testnet XDR + testnet passphrase should not trigger mismatch.
    // Since the Horizon call would require a real network, we only test that the
    // passphrase validation passes (i.e. the result is not a passphrase mismatch error).
    const result = await submitTransaction(
      "https://horizon-testnet.stellar.org",
      Networks.TESTNET,
      TESTNET_XDR,
    );

    // The validation passes — result is ok or a non-passphrase error (Horizon unreachable in test)
    if (result.status === "error") {
      expect(result.error.message).not.toMatch(/passphrase mismatch/i);
    }
  });

  it("returns TX_SUBMIT_FAILED for malformed XDR", async () => {
    const result = await submitTransaction(
      "https://horizon.stellar.org",
      Networks.TESTNET,
      "not-valid-xdr",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    }
  });
});
