import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateSep10,
  clearFederationAddressCache,
  deriveKey,
  getSep6TransactionStatus,
  initiateSep24Interactive,
  initiateSep6Transfer,
  resolveFederatedAddress,
  rotateSecretKey,
  validateSecretKey,
  LAZY_MODULES,
  getLoadedModules,
  isLazyModuleName,
  isModuleLoaded,
  loadGovernance,
  loadModule,
  loadSoroban,
  preloadModules,
  resetLazyModules,
} from "./index";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #682 — on-demand module loading.

afterEach(() => {
  resetLazyModules();
  vi.unstubAllGlobals();
});

describe("loadModule", () => {
  it("lists the lazy-loadable modules", () => {
    expect([...LAZY_MODULES].sort()).toEqual(
      ["compliance", "governance", "integration", "keyManagement", "privacy", "soroban", "streaming"].sort(),
    );
    expect(isLazyModuleName("soroban")).toBe(true);
    expect(isLazyModuleName("wallet")).toBe(false);
    expect(isLazyModuleName("__proto__")).toBe(false);
  });

  it.each([
    ["soroban", "readContract"],
    ["integration", "resolveFederatedAddress"],
    ["governance", "getProposals"],
    ["keyManagement", "deriveKey"],
    ["compliance", "createAuditTrail"],
  ] as const)("loads %s via dynamic import and tracks it", async (name, member) => {
    expect(isModuleLoaded(name)).toBe(false);
    const res = await loadModule(name);
    expect(res.status).toBe("ok");
    expect(typeof (res.data as Record<string, unknown>)[member]).toBe("function");
    expect(isModuleLoaded(name)).toBe(true);
    expect(getLoadedModules()).toContain(name);
  });

  it("loads the streaming and privacy modules", async () => {
    for (const name of ["streaming", "privacy"] as const) {
      const res = await loadModule(name);
      expect(res.status).toBe("ok");
      expect(Object.keys(res.data!).length).toBeGreaterThan(0);
    }
  });

  it("returns the same module instance on repeat and concurrent loads", async () => {
    const [a, b] = await Promise.all([loadModule("soroban"), loadModule("soroban")]);
    const c = await loadModule("soroban");
    expect(a.data).toBe(b.data);
    expect(c.data).toBe(a.data);
    expect(getLoadedModules().filter((n) => n === "soroban")).toHaveLength(1);
  });

  it("records modules in load order", async () => {
    await loadModule("governance");
    await loadModule("compliance");
    expect(getLoadedModules()).toEqual(["governance", "compliance"]);
  });

  it("rejects unknown names with VALIDATION instead of throwing", async () => {
    const res = await loadModule("wallet" as never);
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("VALIDATION");
    expect(res.error?.message).toContain("soroban");
    expect(getLoadedModules()).toEqual([]);
  });

  it("preloads several modules, defaulting to all of them", async () => {
    const some = await preloadModules(["governance", "keyManagement"]);
    expect(some.data).toEqual(["governance", "keyManagement"]);
    expect(isModuleLoaded("soroban")).toBe(false);

    const all = await preloadModules();
    expect(all.status).toBe("ok");
    expect(getLoadedModules().sort()).toEqual([...LAZY_MODULES].sort());
  });

  it("preload reports an invalid entry", async () => {
    const res = await preloadModules(["governance", "nope" as never]);
    expect(res.error?.code).toBe("VALIDATION");
  });

  it("resetLazyModules clears tracking only", async () => {
    const first = await loadModule("governance");
    resetLazyModules();
    expect(isModuleLoaded("governance")).toBe(false);
    const again = await loadModule("governance");
    expect(again.data).toBe(first.data); // ES module cache still shared
  });
});

describe("named loaders (pre-#682 API)", () => {
  it("still resolve to the module and are tracked", async () => {
    const soroban = await loadSoroban();
    expect(typeof soroban.readContract).toBe("function");
    expect(isModuleLoaded("soroban")).toBe(true);
    const governance = await loadGovernance();
    expect(typeof governance.voteOnProposal).toBe("function");
  });

  it("are re-exported from the root entry point", () => {
    // Static check: src/index.ts cannot be loaded on main (see governance.test.ts).
    const rootSrc = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const lazyBlock = rootSrc.slice(0, rootSrc.indexOf('} from "./lazy";'));
    for (const name of ["loadSoroban", "loadModule", "preloadModules", "isModuleLoaded", "getLoadedModules", "LAZY_MODULES", "loadGovernance"]) {
      expect(lazyBlock).toContain(name);
    }
  });
});

describe("wrapper functions (moved unchanged from src/lazy.ts)", () => {
  it("delegate to the lazily imported implementations", async () => {
    // No real network: every HTTP attempt fails fast.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const asset = { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };

    expect((await resolveFederatedAddress("not-a-federation-address")).status).toBe("error");
    expect((await authenticateSep10("https://anchor.invalid", { account: "GBAD" } as never)).status).toBe("error");
    expect((await initiateSep6Transfer("https://anchor.invalid", asset as never)).status).toBe("error");
    expect((await initiateSep24Interactive("https://anchor.invalid", asset as never)).status).toBe("error");
    expect((await getSep6TransactionStatus("https://anchor.invalid", "tx-1")).status).toBe("error");
    expect((await validateSecretKey("not-a-secret")).status).toBe("error");
    expect((await rotateSecretKey({} as never)).status).toBe("error");
    const derived = await deriveKey(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(derived.status).toBe("ok");
    await expect(clearFederationAddressCache()).resolves.toBeUndefined();
  });
});
