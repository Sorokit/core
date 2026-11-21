import { describe, expect, it, vi } from "vitest";
import { compose } from "./compose";

const SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("compose memoization warnings", () => {
  it("warns when a memoized builder receives mutable account options", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    compose(SOURCE, "testnet", { memoize: true }).addSetOptions({ masterWeight: 1 });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("mutable operation"));
    warning.mockRestore();
  });

  it("allows deliberate opt-out of the warning", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    compose(SOURCE, "testnet", {
      memoize: true,
      warnOnMutableMemoized: false,
    }).addSetOptions({ signers: [] });

    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
