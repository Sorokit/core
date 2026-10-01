/**
 * E2E framework: complete wallet connection workflows for every supported
 * wallet type (Freighter, xBull, Lobstr, Hana), plus the browser-automation
 * adapter seam a Playwright/Puppeteer-backed driver plugs into.
 *
 * Runs offline against mocked SWK instances / a fake driver — no network or
 * real browser required — so it runs in every CI job, not just a nightly
 * live-network run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FreighterAdapter } from "../../wallet/adapters/freighter";
import { XBullAdapter } from "../../wallet/adapters/xbull";
import { LobstrAdapter } from "../../wallet/adapters/lobstr";
import { HanaAdapter } from "../../wallet/adapters/hana";
import { WalletType } from "../../wallet/types";
import type { SWKInstance, WalletAdapter, SignTransactionInput } from "../../wallet/types";
import {
  runWalletConnectionWorkflow,
  runWalletConnectionWorkflowSuite,
  createBrowserDrivenAdapter,
} from "./framework";
import type { BrowserWalletDriver } from "./framework";

const SIGN_INPUT: SignTransactionInput = {
  transactionXdr: "mock-unsigned-xdr",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function mockKit(publicKey: string): SWKInstance {
  return {
    getAddress: vi.fn().mockResolvedValue({ address: publicKey }),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: "mock-signed-xdr" }),
  } as unknown as SWKInstance;
}

const ADAPTER_FACTORIES: Array<{ walletType: WalletType; create: (kit: SWKInstance) => WalletAdapter }> = [
  { walletType: WalletType.FREIGHTER, create: (kit) => new FreighterAdapter(kit) },
  { walletType: WalletType.XBULL, create: (kit) => new XBullAdapter(kit) },
  { walletType: WalletType.LOBSTR, create: (kit) => new LobstrAdapter(kit) },
  { walletType: WalletType.HANA, create: (kit) => new HanaAdapter(kit) },
];

describe("E2E framework: wallet connection workflows", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { document: {} });
  });

  it.each(ADAPTER_FACTORIES)(
    "completes connect -> sign -> disconnect for $walletType",
    async ({ walletType, create }) => {
      const publicKey = `G${walletType}PUBLICKEY`;
      const adapter = create(mockKit(publicKey));

      const result = await runWalletConnectionWorkflow({ adapter, signInput: SIGN_INPUT });

      expect(result.ok).toBe(true);
      expect(result.workflow).toBe(`wallet-connection:${walletType}`);
      expect(result.steps.map((s) => s.step)).toEqual(["connect", "sign", "disconnect"]);
      expect(result.steps.every((s) => s.status === "ok")).toBe(true);
      expect(result.steps[0]?.detail).toBe(publicKey);
    },
  );

  it("runs every wallet type as a single suite and reports each independently", async () => {
    const results = await runWalletConnectionWorkflowSuite(
      ADAPTER_FACTORIES.map(({ walletType, create }) => ({
        adapter: create(mockKit(`G${walletType}PUBLICKEY`)),
        signInput: SIGN_INPUT,
      })),
    );

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.workflow)).toEqual(
      ADAPTER_FACTORIES.map(({ walletType }) => `wallet-connection:${walletType}`),
    );
  });

  it("stops early and skips remaining steps when connect fails", async () => {
    const failingKit = {
      getAddress: vi.fn().mockRejectedValue(new Error("extension locked")),
      signTransaction: vi.fn(),
    } as unknown as SWKInstance;
    const adapter = new FreighterAdapter(failingKit);

    const result = await runWalletConnectionWorkflow({ adapter, signInput: SIGN_INPUT });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[1]).toMatchObject({ step: "sign", status: "skipped" });
    expect(result.steps[2]).toMatchObject({ step: "disconnect", status: "skipped" });
    expect(failingKit.signTransaction).not.toHaveBeenCalled();
  });

  it("drives a browser-automation adapter (Playwright/Puppeteer seam) through the same workflow", async () => {
    const driver: BrowserWalletDriver = {
      label: "Freighter (fake browser driver)",
      approveConnection: vi.fn().mockResolvedValue("GBROWSERDRIVENPUBLICKEY"),
      approveSignature: vi.fn().mockResolvedValue("signed-by-browser-xdr"),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createBrowserDrivenAdapter(driver, WalletType.FREIGHTER);

    const result = await runWalletConnectionWorkflow({ adapter, signInput: SIGN_INPUT });

    expect(result.ok).toBe(true);
    expect(driver.approveConnection).toHaveBeenCalledOnce();
    expect(driver.approveSignature).toHaveBeenCalledWith(SIGN_INPUT);
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it("surfaces browser driver rejection as a WALLET_SIGN_FAILED step", async () => {
    const driver: BrowserWalletDriver = {
      label: "xBull (fake browser driver)",
      approveConnection: vi.fn().mockResolvedValue("GBROWSERDRIVENPUBLICKEY"),
      approveSignature: vi.fn().mockRejectedValue(new Error("user rejected in extension UI")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createBrowserDrivenAdapter(driver, WalletType.XBULL);

    const result = await runWalletConnectionWorkflow({ adapter, signInput: SIGN_INPUT });

    expect(result.ok).toBe(false);
    const signStep = result.steps.find((s) => s.step === "sign");
    expect(signStep?.status).toBe("error");
    expect(signStep?.detail).toContain("user rejected in extension UI");
  });
});
