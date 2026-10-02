import { describe, expect, it, beforeEach } from "vitest";
import {
  getAssetInfo,
  registerAsset,
  unregisterAsset,
  listKnownAssets,
  canonicalAssetId,
} from "../shared/assetRegistry";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("canonicalAssetId", () => {
  it("returns 'XLM' for a native asset", () => {
    expect(canonicalAssetId({ code: "XLM", issuer: null })).toBe("XLM");
  });

  it("returns 'CODE:ISSUER' for an issued asset", () => {
    expect(canonicalAssetId({ code: "USDC", issuer: USDC_ISSUER })).toBe(
      `USDC:${USDC_ISSUER}`,
    );
  });
});

describe("getAssetInfo — pre-populated assets", () => {
  it("returns metadata for native XLM", () => {
    const result = getAssetInfo({ code: "XLM", issuer: null });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.name).toBe("Stellar Lumens");
      expect(result.data.decimals).toBe(7);
      expect(result.data.issuer).toBeNull();
    }
  });

  it("returns metadata for the verified USDC issuer", () => {
    const result = getAssetInfo({ code: "USDC", issuer: USDC_ISSUER });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.name).toBe("USD Coin");
      expect(result.data.decimals).toBe(7);
    }
  });

  it("does not recognize a different issuer using the USDC code (anti-spoofing)", () => {
    const result = getAssetInfo({ code: "USDC", issuer: "GFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE" });
    expect(result.status).toBe("error");
  });
});

describe("getAssetInfo — missing assets", () => {
  it("returns an error for an asset with no registered metadata", () => {
    const result = getAssetInfo({ code: "UNKNOWNTOKEN", issuer: "GISSUER" });
    expect(result.status).toBe("error");
  });
});

describe("registerAsset / getAssetInfo round trip", () => {
  const custom = { code: "MYTOKEN", issuer: "GCUSTOMISSUERADDRESSFORTESTS0000000000000000000000000" };

  beforeEach(() => {
    unregisterAsset(custom);
  });

  it("registers a custom asset and makes it retrievable", () => {
    const registerResult = registerAsset(custom, {
      name: "My Token",
      decimals: 6,
    });
    expect(registerResult.status).toBe("ok");

    const lookup = getAssetInfo(custom);
    expect(lookup.status).toBe("ok");
    if (lookup.status === "ok") {
      expect(lookup.data.name).toBe("My Token");
      expect(lookup.data.decimals).toBe(6);
    }
  });

  it("includes an optional logo when provided", () => {
    registerAsset(custom, {
      name: "My Token",
      decimals: 6,
      logo: "https://example.com/logo.png",
    });
    const lookup = getAssetInfo(custom);
    if (lookup.status === "ok") {
      expect(lookup.data.logo).toBe("https://example.com/logo.png");
    }
  });

  it("allows overriding a built-in asset's metadata (e.g. attaching a logo to USDC)", () => {
    const usdc = { code: "USDC", issuer: USDC_ISSUER };
    const registerResult = registerAsset(usdc, {
      name: "USD Coin",
      decimals: 7,
      logo: "https://example.com/usdc.png",
    });
    expect(registerResult.status).toBe("ok");

    const lookup = getAssetInfo(usdc);
    if (lookup.status === "ok") {
      expect(lookup.data.logo).toBe("https://example.com/usdc.png");
    }

    unregisterAsset(usdc); // restore built-in state for other tests
  });

  it("rejects registration with an empty asset code", () => {
    const result = registerAsset({ code: "", issuer: null }, { name: "X", decimals: 7 });
    expect(result.status).toBe("error");
  });

  it("rejects registration with invalid decimals", () => {
    expect(
      registerAsset(custom, { name: "My Token", decimals: -1 }).status,
    ).toBe("error");
    expect(
      registerAsset(custom, { name: "My Token", decimals: 21 }).status,
    ).toBe("error");
  });

  it("rejects registration with an empty name", () => {
    const result = registerAsset(custom, { name: "", decimals: 6 });
    expect(result.status).toBe("error");
  });

  it("unregisterAsset removes a custom registration and reverts to 'not found'", () => {
    registerAsset(custom, { name: "My Token", decimals: 6 });
    expect(getAssetInfo(custom).status).toBe("ok");

    const removed = unregisterAsset(custom);
    expect(removed).toBe(true);
    expect(getAssetInfo(custom).status).toBe("error");
  });

  it("unregisterAsset returns false when nothing was registered", () => {
    expect(unregisterAsset(custom)).toBe(false);
  });
});

describe("listKnownAssets", () => {
  const custom = { code: "LISTTEST", issuer: "GLISTTESTISSUERADDRESS00000000000000000000000000000" };

  beforeEach(() => {
    unregisterAsset(custom);
  });

  it("includes the built-in assets", () => {
    const assets = listKnownAssets();
    expect(assets.some((a) => a.id === "XLM")).toBe(true);
    expect(assets.some((a) => a.code === "USDC")).toBe(true);
  });

  it("includes a custom-registered asset", () => {
    registerAsset(custom, { name: "List Test Token", decimals: 4 });
    const assets = listKnownAssets();
    expect(assets.some((a) => a.id === canonicalAssetId(custom))).toBe(true);
    unregisterAsset(custom);
  });
});
