import { describe, it, expect, vi, beforeEach } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import { previewTransaction } from "../transaction/simulationPreview";
import { SorokitErrorCode, ok, err } from "../shared/response";
import type { AccountInfo } from "../account/types";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  fromXDR: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: mocks.fromXDR,
    },
  };
});

vi.mock("../account/getAccount", () => ({
  getAccount: vi.fn(),
}));

vi.mock("../soroban/simulateTransaction", () => ({
  simulateTransaction: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon.invalid";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const MOCK_XDR = "AAAAAQAAAAA=";

const SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const DESTINATION = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYFTRE6A6PIFLSUFZOO";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makeAccountInfo(balances: AccountInfo["balances"]): AccountInfo {
  return {
    publicKey: SOURCE,
    displayAddress: "GAAZI...CWNA",
    sequence: "1",
    subentryCount: 0,
    balances,
  };
}

function nativeBalance(balance: string) {
  return {
    assetType: "native" as const,
    assetCode: "XLM",
    assetIssuer: null,
    balance,
    balanceFloat: Number(balance),
  };
}

function makePaymentTx(overrides?: { fee?: number; amount?: string; destination?: string; source?: string }) {
  return {
    source: overrides?.source ?? SOURCE,
    fee: overrides?.fee ?? 100,
    operations: [
      {
        type: "payment",
        destination: overrides?.destination ?? DESTINATION,
        amount: overrides?.amount ?? "100",
        asset: Asset.native(),
      },
    ],
  };
}

function makeCreateAccountTx(overrides?: { startingBalance?: string; destination?: string }) {
  return {
    source: SOURCE,
    fee: 100,
    operations: [
      {
        type: "createAccount",
        destination: overrides?.destination ?? DESTINATION,
        startingBalance: overrides?.startingBalance ?? "5",
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("previewTransaction", () => {
  it("returns an error for a malformed transaction XDR", async () => {
    mocks.fromXDR.mockImplementation(() => {
      throw new Error("invalid XDR");
    });

    const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, "not-valid-xdr");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
    }
  });

  it("handles a FeeBumpTransaction by previewing the inner transaction", async () => {
    const { getAccount } = await import("../account/getAccount");
    const innerTx = makePaymentTx();
    mocks.fromXDR.mockReturnValue({ innerTransaction: innerTx });
    vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
      if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
      return ok(makeAccountInfo([]));
    });

    const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

    expect(result.status).toBe("ok");
  });

  describe("payment", () => {
    it("projects the source's decreased balance and destination's increased balance", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue(makePaymentTx({ amount: "100" }));
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
        if (publicKey === DESTINATION) return ok(makeAccountInfo([nativeBalance("50")]));
        return ok(makeAccountInfo([]));
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      expect(result.data.newBalance).toBe("900.0000000");
      const sourceEffect = result.data.effects.find((e) => e.account === SOURCE);
      const destEffect = result.data.effects.find((e) => e.account === DESTINATION);
      expect(sourceEffect?.before).toBe("1000");
      expect(sourceEffect?.after).toBe("900.0000000");
      expect(sourceEffect?.delta).toBe("-100.0000000");
      expect(destEffect?.before).toBe("50");
      expect(destEffect?.after).toBe("150.0000000");
      expect(destEffect?.delta).toBe("+100.0000000");
    });

    it("includes a human-readable 'Will send' summary line", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue(makePaymentTx({ amount: "42" }));
      vi.mocked(getAccount).mockResolvedValue(ok(makeAccountInfo([nativeBalance("1000")])));

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.summary.some((line) => line.includes(`Will send 42 XLM to ${DESTINATION}`))).toBe(true);
    });

    it("includes the fee in stroops in the summary", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 500 }));
      vi.mocked(getAccount).mockResolvedValue(ok(makeAccountInfo([nativeBalance("1000")])));

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.fee).toBe("500");
      expect(result.data.summary).toContain("Fee: 500 stroops");
    });

    it("treats a nonexistent destination account as a zero starting balance", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue(makePaymentTx({ amount: "10" }));
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
        return err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const destEffect = result.data.effects.find((e) => e.account === DESTINATION);
      expect(destEffect?.before).toBeNull();
      expect(destEffect?.after).toBe("10.0000000");
    });

    it("uses the payment operation's own source when set, not the transaction source", async () => {
      const { getAccount } = await import("../account/getAccount");
      const altSource = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYFTRE6A6PIFLSUFZOO";
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [
          { type: "payment", source: altSource, destination: SOURCE, amount: "10", asset: Asset.native() },
        ],
      });
      vi.mocked(getAccount).mockResolvedValue(ok(makeAccountInfo([nativeBalance("1000")])));

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.effects.find((e) => e.account === altSource)?.delta).toBe("-10.0000000");
    });

    it("nets multiple payments touching the same balance into a single effect", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [
          { type: "payment", destination: DESTINATION, amount: "100", asset: Asset.native() },
          { type: "payment", destination: DESTINATION, amount: "30", asset: Asset.native() },
        ],
      });
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
        return ok(makeAccountInfo([nativeBalance("0")]));
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const sourceEffects = result.data.effects.filter((e) => e.account === SOURCE);
      expect(sourceEffects).toHaveLength(1);
      expect(sourceEffects[0]?.delta).toBe("-130.0000000");
    });

    it("computes balance deltas for a non-native asset", async () => {
      const { getAccount } = await import("../account/getAccount");
      const usdc = new Asset("USDC", USDC_ISSUER);
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [{ type: "payment", destination: DESTINATION, amount: "25", asset: usdc }],
      });
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        const balances =
          publicKey === SOURCE
            ? [{ assetType: "credit_alphanum4" as const, assetCode: "USDC", assetIssuer: USDC_ISSUER, balance: "200", balanceFloat: 200 }]
            : [];
        return ok(makeAccountInfo(balances));
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const sourceEffect = result.data.effects.find((e) => e.account === SOURCE);
      expect(sourceEffect?.asset).toEqual({ code: "USDC", issuer: USDC_ISSUER });
      expect(sourceEffect?.after).toBe("175.0000000");
      // newBalance is XLM-only; a USDC-only payment shouldn't populate it.
      expect(result.data.newBalance).toBeNull();
    });
  });

  describe("createAccount", () => {
    it("projects the new account's starting balance and reports an account_created state change", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue(makeCreateAccountTx({ startingBalance: "5" }));
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
        return err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.stateChanges).toHaveLength(1);
      expect(result.data.stateChanges[0]?.type).toBe("account_created");
      const destEffect = result.data.effects.find((e) => e.account === DESTINATION);
      expect(destEffect?.before).toBeNull();
      expect(destEffect?.after).toBe("5.0000000");
    });
  });

  describe("changeTrust", () => {
    it("reports a trustline_created state change for a nonzero limit", async () => {
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [
          { type: "changeTrust", line: new Asset("USDC", USDC_ISSUER), limit: "1000" },
        ],
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.stateChanges).toHaveLength(1);
      expect(result.data.stateChanges[0]?.type).toBe("trustline_created");
    });

    it("reports a trustline_limit_changed (removal) state change for a zero limit", async () => {
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [
          { type: "changeTrust", line: new Asset("USDC", USDC_ISSUER), limit: "0" },
        ],
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.stateChanges[0]?.type).toBe("trustline_limit_changed");
    });
  });

  describe("pathPaymentStrictSend / pathPaymentStrictReceive", () => {
    it("projects worst-case deltas for pathPaymentStrictSend using sendAmount/destMin", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [
          {
            type: "pathPaymentStrictSend",
            sendAsset: Asset.native(),
            sendAmount: "50",
            destination: DESTINATION,
            destAsset: new Asset("USDC", USDC_ISSUER),
            destMin: "45",
          },
        ],
      });
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
        return ok(makeAccountInfo([]));
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const sourceEffect = result.data.effects.find((e) => e.account === SOURCE);
      const destEffect = result.data.effects.find((e) => e.account === DESTINATION);
      expect(sourceEffect?.delta).toBe("-50.0000000");
      expect(destEffect?.delta).toBe("+45.0000000");
    });

    it("projects worst-case deltas for pathPaymentStrictReceive using sendMax/destAmount", async () => {
      const { getAccount } = await import("../account/getAccount");
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [
          {
            type: "pathPaymentStrictReceive",
            sendAsset: Asset.native(),
            sendMax: "60",
            destination: DESTINATION,
            destAsset: new Asset("USDC", USDC_ISSUER),
            destAmount: "45",
          },
        ],
      });
      vi.mocked(getAccount).mockImplementation(async (_url, publicKey) => {
        if (publicKey === SOURCE) return ok(makeAccountInfo([nativeBalance("1000")]));
        return ok(makeAccountInfo([]));
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const sourceEffect = result.data.effects.find((e) => e.account === SOURCE);
      const destEffect = result.data.effects.find((e) => e.account === DESTINATION);
      expect(sourceEffect?.delta).toBe("-60.0000000");
      expect(destEffect?.delta).toBe("+45.0000000");
    });
  });

  describe("invokeHostFunction (Soroban)", () => {
    it("returns a validation error when rpcUrl is not provided", async () => {
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [{ type: "invokeHostFunction" }],
      });

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("rpcUrl");
      }
    });

    it("delegates to soroban.simulateTransaction and attaches the result when rpcUrl is provided", async () => {
      const { simulateTransaction } = await import("../soroban/simulateTransaction");
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [{ type: "invokeHostFunction" }],
      });
      vi.mocked(simulateTransaction).mockResolvedValue(
        ok({ success: true, fee: "1000" }),
      );

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR, {
        rpcUrl: "https://rpc.invalid",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.sorobanSimulation).toEqual({ success: true, fee: "1000" });
    });

    it("propagates a simulation error", async () => {
      const { simulateTransaction } = await import("../soroban/simulateTransaction");
      mocks.fromXDR.mockReturnValue({
        source: SOURCE,
        fee: 100,
        operations: [{ type: "invokeHostFunction" }],
      });
      vi.mocked(simulateTransaction).mockResolvedValue(
        err(SorokitErrorCode.TX_SIMULATE_FAILED, "simulation failed"),
      );

      const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR, {
        rpcUrl: "https://rpc.invalid",
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_SIMULATE_FAILED);
      }
    });
  });

  it("omits sorobanSimulation entirely for a classic-only transaction", async () => {
    const { getAccount } = await import("../account/getAccount");
    mocks.fromXDR.mockReturnValue(makePaymentTx());
    vi.mocked(getAccount).mockResolvedValue(ok(makeAccountInfo([nativeBalance("1000")])));

    const result = await previewTransaction(HORIZON_URL, NETWORK_PASSPHRASE, MOCK_XDR);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.sorobanSimulation).toBeUndefined();
  });
});
