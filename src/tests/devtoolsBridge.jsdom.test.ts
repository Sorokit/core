// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { enableDevtoolsBridge, SOROKIT_DEVTOOLS_EVENT } from "../shared/devtoolsBridge";
import type { SorokitDevtoolsEventDetail } from "../shared/devtoolsBridge";
import { createLogger } from "../shared/logger";

describe("enableDevtoolsBridge", () => {
  it("dispatches a window CustomEvent for every log record written by a registered logger", () => {
    const disable = enableDevtoolsBridge();
    try {
      const listener = vi.fn();
      window.addEventListener(SOROKIT_DEVTOOLS_EVENT, listener);

      const logger = createLogger({ logLevel: "debug" });
      logger.info("account.get", { operation: "account.get", publicKey: "GABC" });

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<SorokitDevtoolsEventDetail>;
      expect(event.detail.record.level).toBe("info");
      expect(event.detail.record.message).toBe("account.get");
      expect(event.detail.record.context).toMatchObject({ publicKey: "GABC" });

      window.removeEventListener(SOROKIT_DEVTOOLS_EVENT, listener);
    } finally {
      disable();
    }
  });

  it("assigns increasing sequence numbers across multiple records", () => {
    const disable = enableDevtoolsBridge();
    try {
      const events: CustomEvent<SorokitDevtoolsEventDetail>[] = [];
      const listener = (e: Event) => events.push(e as CustomEvent<SorokitDevtoolsEventDetail>);
      window.addEventListener(SOROKIT_DEVTOOLS_EVENT, listener);

      const logger = createLogger({ logLevel: "debug" });
      logger.debug("op.one", {});
      logger.debug("op.two", {});

      expect(events).toHaveLength(2);
      expect(events[1]!.detail.seq).toBeGreaterThan(events[0]!.detail.seq);

      window.removeEventListener(SOROKIT_DEVTOOLS_EVENT, listener);
    } finally {
      disable();
    }
  });

  it("stops dispatching events after the returned unsubscribe function is called", () => {
    const disable = enableDevtoolsBridge();
    const listener = vi.fn();
    window.addEventListener(SOROKIT_DEVTOOLS_EVENT, listener);

    disable();

    const logger = createLogger({ logLevel: "debug" });
    logger.info("after.disable", {});

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SOROKIT_DEVTOOLS_EVENT, listener);
  });

  it("redacts sensitive fields the same way any other transport would receive them", () => {
    const disable = enableDevtoolsBridge();
    try {
      const listener = vi.fn();
      window.addEventListener(SOROKIT_DEVTOOLS_EVENT, listener);

      const logger = createLogger({ logLevel: "debug" });
      logger.info("wallet.sign", { secret: "S123SEED", publicKey: "GABC" });

      const event = listener.mock.calls[0][0] as CustomEvent<SorokitDevtoolsEventDetail>;
      expect(event.detail.record.context?.secret).toBe("[redacted]");
      expect(event.detail.record.context?.publicKey).toBe("GABC");

      window.removeEventListener(SOROKIT_DEVTOOLS_EVENT, listener);
    } finally {
      disable();
    }
  });

  it("does not fire for a logger built with a fully custom SorokitLogger (bypasses transports entirely)", () => {
    const disable = enableDevtoolsBridge();
    try {
      const listener = vi.fn();
      window.addEventListener(SOROKIT_DEVTOOLS_EVENT, listener);

      const customLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const logger = createLogger({ logLevel: "debug", logger: customLogger });
      logger.info("isolated", {});

      expect(listener).not.toHaveBeenCalled();
      expect(customLogger.info).toHaveBeenCalledTimes(1);

      window.removeEventListener(SOROKIT_DEVTOOLS_EVENT, listener);
    } finally {
      disable();
    }
  });
});
