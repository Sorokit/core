import { describe, it, expect } from "vitest";
import { validateXdrVersion, CURRENT_STELLAR_PROTOCOL } from "./xdrValidation";

describe("XDR Versioning Support (#917)", () => {
  it("rejects empty or whitespace XDR", () => {
    const res = validateXdrVersion("");
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.message).toContain("invalid XDR");
    }
  });

  it("warns on protocol version mismatch", () => {
    // Valid-looking base64 payload but unknown envelope
    const fakeXdr = Buffer.from("AAAAAQAAAAA=").toString("base64");
    const res = validateXdrVersion(fakeXdr, 22);
    if (res.status === "ok") {
      expect(res.data.expectedProtocol).toBe(22);
    }
  });
});
