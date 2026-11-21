import { describe, it, expect } from "vitest";
import {
  buildSetDataEntryTransaction,
  buildDeleteDataEntryTransaction,
  setData,
  deleteData,
  validateDataEntryKey,
  validateDataEntryValue,
  getDataByteLength,
  MAX_DATA_ENTRY_KEY_BYTES,
  MAX_DATA_ENTRY_VALUE_BYTES,
} from "../transaction/dataEntry";
import { compose } from "../transaction/compose";
import { createSorokitClient } from "../client/createSorokitClient";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

const mockNetworkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const TEST_SOURCE_KEY = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

describe("DataEntry XDR limits validation (#762)", () => {
  describe("getDataByteLength", () => {
    it("computes exact byte length for standard ASCII strings", () => {
      expect(getDataByteLength("")).toBe(0);
      expect(getDataByteLength("hello")).toBe(5);
      expect(getDataByteLength("a".repeat(64))).toBe(64);
    });

    it("computes exact byte length for multi-byte UTF-8 strings", () => {
      // "🚀" is 2 code units in UTF-16, but 4 bytes in UTF-8
      expect("🚀".length).toBe(2);
      expect(getDataByteLength("🚀")).toBe(4);

      // 16 emojis = 64 bytes
      const emojis16 = "🚀".repeat(16);
      expect(emojis16.length).toBe(32);
      expect(getDataByteLength(emojis16)).toBe(64);

      // 17 emojis = 68 bytes
      const emojis17 = "🚀".repeat(17);
      expect(emojis17.length).toBe(34);
      expect(getDataByteLength(emojis17)).toBe(68);

      // CJK characters: 3 bytes each in UTF-8
      const cjk21 = "星".repeat(21);
      expect(getDataByteLength(cjk21)).toBe(63);
      const cjk22 = "星".repeat(22);
      expect(getDataByteLength(cjk22)).toBe(66);
    });

    it("computes exact byte length for binary Uint8Array payloads", () => {
      const u64 = new Uint8Array(64);
      expect(getDataByteLength(u64)).toBe(64);

      const u65 = new Uint8Array(65);
      expect(getDataByteLength(u65)).toBe(65);
    });

    it("computes exact byte length for Buffer payloads", () => {
      if (typeof Buffer !== "undefined") {
        const buf64 = Buffer.alloc(64);
        expect(getDataByteLength(buf64)).toBe(64);

        const buf100 = Buffer.alloc(100);
        expect(getDataByteLength(buf100)).toBe(100);
      }
    });
  });

  describe("validateDataEntryValue", () => {
    it("accepts null and undefined (deletion / clear)", () => {
      const resNull = validateDataEntryValue(null);
      expect(resNull.status).toBe("ok");
      expect(resNull.data).toBeNull();

      const resUndef = validateDataEntryValue(undefined);
      expect(resUndef.status).toBe("ok");
      expect(resUndef.data).toBeNull();
    });

    it("accepts empty string (0 bytes)", () => {
      const res = validateDataEntryValue("");
      expect(res.status).toBe("ok");
      expect(res.data).toBe("");
    });

    it("accepts ASCII strings up to 64 bytes", () => {
      const str64 = "a".repeat(64);
      const res = validateDataEntryValue(str64);
      expect(res.status).toBe("ok");
      expect(res.data).toBe(str64);
    });

    it("rejects ASCII strings exceeding 64 bytes with limit and actual size", () => {
      const str65 = "a".repeat(65);
      const res = validateDataEntryValue(str65);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(res.error.message).toContain("64 bytes");
        expect(res.error.message).toContain("actual: 65 bytes");
      }
    });

    it("rejects multi-byte UTF-8 string when byte count exceeds 64, even if character length < 64", () => {
      // 17 emojis: length is 34 (well below 64 characters), but byte size is 68 bytes
      const emojis17 = "🚀".repeat(17);
      expect(emojis17.length).toBe(34);

      const res = validateDataEntryValue(emojis17);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(res.error.message).toContain("64 bytes");
        expect(res.error.message).toContain("actual: 68 bytes");
      }
    });

    it("accepts multi-byte UTF-8 string when byte count is exactly 64 bytes", () => {
      // 16 emojis = 64 bytes
      const emojis16 = "🚀".repeat(16);
      const res = validateDataEntryValue(emojis16);
      expect(res.status).toBe("ok");
      expect(res.data).toBe(emojis16);
    });

    it("accepts Uint8Array of exactly 64 bytes", () => {
      const u64 = new Uint8Array(64);
      const res = validateDataEntryValue(u64);
      expect(res.status).toBe("ok");
      expect(res.data).toBe(u64);
    });

    it("rejects Uint8Array exceeding 64 bytes with exact byte size", () => {
      const u65 = new Uint8Array(65);
      const res = validateDataEntryValue(u65);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(res.error.message).toContain("64 bytes");
        expect(res.error.message).toContain("actual: 65 bytes");
      }
    });

    it("rejects Buffer exceeding 64 bytes with exact byte size", () => {
      if (typeof Buffer !== "undefined") {
        const buf75 = Buffer.alloc(75);
        const res = validateDataEntryValue(buf75);
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
          expect(res.error.message).toContain("64 bytes");
          expect(res.error.message).toContain("actual: 75 bytes");
        }
      }
    });
  });

  describe("validateDataEntryKey", () => {
    it("rejects empty or non-string keys", () => {
      const resEmpty = validateDataEntryKey("");
      expect(resEmpty.status).toBe("error");
      if (resEmpty.status === "error") {
        expect(resEmpty.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    });

    it("accepts keys up to 64 bytes", () => {
      const key64 = "k".repeat(64);
      const res = validateDataEntryKey(key64);
      expect(res.status).toBe("ok");
      expect(res.data).toBe(key64);
    });

    it("rejects keys exceeding 64 bytes with limit and actual size", () => {
      const key65 = "k".repeat(65);
      const res = validateDataEntryKey(key65);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(res.error.message).toContain("64 bytes");
        expect(res.error.message).toContain("actual: 65 bytes");
      }
    });
  });

  describe("buildSetDataEntryTransaction & setData", () => {
    it("rejects oversized string value early before making any network call", async () => {
      const oversizedValue = "v".repeat(65);
      const result = await buildSetDataEntryTransaction(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        "validKey",
        oversizedValue,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("64 bytes");
        expect(result.error.message).toContain("actual: 65 bytes");
      }
    });

    it("rejects oversized binary value early via setData alias", async () => {
      const oversizedBuffer = new Uint8Array(70);
      const result = await setData(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        "validKey",
        oversizedBuffer,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("64 bytes");
        expect(result.error.message).toContain("actual: 70 bytes");
      }
    });

    it("rejects oversized key early", async () => {
      const oversizedKey = "k".repeat(65);
      const result = await setData(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        oversizedKey,
        "validValue",
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("64 bytes");
        expect(result.error.message).toContain("actual: 65 bytes");
      }
    });

    it("builds valid XDR when value is exactly 64 bytes using sequenceNumber override", async () => {
      const valid64 = "x".repeat(64);
      const result = await buildSetDataEntryTransaction(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        "myConfigKey",
        valid64,
        { sequenceNumber: "100" },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(typeof result.data).toBe("string");
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("builds valid XDR when value is 64-byte Uint8Array using setData alias", async () => {
      const valid64Bytes = new Uint8Array(64);
      valid64Bytes.fill(42);
      const result = await setData(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        "binaryKey",
        valid64Bytes,
        { sequenceNumber: "100" },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(typeof result.data).toBe("string");
        expect(result.data.length).toBeGreaterThan(0);
      }
    });
  });

  describe("buildDeleteDataEntryTransaction & deleteData", () => {
    it("builds valid delete data transaction using sequenceNumber override", async () => {
      const result = await buildDeleteDataEntryTransaction(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        "keyToDelete",
        { sequenceNumber: "100" },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(typeof result.data).toBe("string");
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("deleteData alias functions identically to buildDeleteDataEntryTransaction", async () => {
      const result = await deleteData(
        mockNetworkConfig.horizonUrl,
        mockNetworkConfig,
        TEST_SOURCE_KEY,
        "keyToDelete",
        { sequenceNumber: "100" },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(typeof result.data).toBe("string");
        expect(result.data.length).toBeGreaterThan(0);
      }
    });
  });

  describe("compose builder integration", () => {
    it("fails compose build when addSetDataEntry receives an oversized value", async () => {
      const builder = compose(TEST_SOURCE_KEY, mockNetworkConfig, { sequenceNumber: "100" });
      builder.addSetDataEntry("key", "v".repeat(65));

      const result = await builder.build();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("64 bytes");
        expect(result.error.message).toContain("actual: 65 bytes");
      }
    });

    it("fails compose build when setData alias receives an oversized multi-byte UTF-8 value", async () => {
      const builder = compose(TEST_SOURCE_KEY, mockNetworkConfig, { sequenceNumber: "100" });
      builder.setData("key", "🚀".repeat(17)); // 68 bytes

      const result = await builder.build();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("64 bytes");
        expect(result.error.message).toContain("actual: 68 bytes");
      }
    });

    it("succeeds compose build when addSetDataEntry receives valid 64-byte value", async () => {
      const builder = compose(TEST_SOURCE_KEY, mockNetworkConfig, { sequenceNumber: "100" });
      builder.addSetDataEntry("configKey", "v".repeat(64));

      const result = await builder.build();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(typeof result.data).toBe("string");
      }
    });

    it("succeeds compose build with deleteData alias", async () => {
      const builder = compose(TEST_SOURCE_KEY, mockNetworkConfig, { sequenceNumber: "100" });
      builder.deleteData("configKey");

      const result = await builder.build();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(typeof result.data).toBe("string");
      }
    });
  });

  describe("client.transaction integration", () => {
    it("rejects oversized data value via client.transaction.setData early", async () => {
      const clientResult = createSorokitClient({ network: "testnet" });
      expect(clientResult.status).toBe("ok");
      if (clientResult.status !== "ok") return;

      const client = clientResult.data;
      const result = await client.transaction.setData(
        TEST_SOURCE_KEY,
        "key",
        "a".repeat(70),
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
        expect(result.error.message).toContain("64 bytes");
        expect(result.error.message).toContain("actual: 70 bytes");
      }
    });
  });
});
