/**
 * Tests for the payment notification subsystem (fix.md).
 *
 * Covers successful delivery, retries (exponential backoff), configurable
 * timeouts, duplicate-delivery identification through event IDs, failed
 * endpoints surfacing errors, and decoupled notification channels.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerPaymentWebhook,
  unregisterPaymentWebhook,
  listPaymentWebhooks,
  clearPaymentWebhooks,
  triggerPaymentNotifications,
  dispatchPaymentNotification,
  generatePaymentEventId,
  isPaymentNotificationEvent,
  PAYMENT_NOTIFICATION_EVENTS,
  type PaymentNotificationChannel,
  type PaymentNotificationEvent,
} from "../transaction/paymentNotifications";

const SECRET_URL = "https://pay.example.com/webhook";

function okResponse(): Response {
  return { ok: true, status: 200, statusText: "OK" } as Response;
}

describe("paymentNotifications", () => {
  beforeEach(() => {
    clearPaymentWebhooks();
  });

  afterEach(() => {
    clearPaymentWebhooks();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("event types", () => {
    it("defines the supported payment events", () => {
      expect(PAYMENT_NOTIFICATION_EVENTS).toEqual([
        "payment_received",
        "payment_sent",
        "payment_failed",
        "payment_confirmed",
      ]);
    });

    it("guards payment event types", () => {
      expect(isPaymentNotificationEvent("payment_received")).toBe(true);
      expect(isPaymentNotificationEvent("payment_confirmed")).toBe(true);
      expect(isPaymentNotificationEvent("tx_confirmed")).toBe(false);
      expect(isPaymentNotificationEvent("payment_failed")).toBe(true);
    });
  });

  describe("registerPaymentWebhook", () => {
    it("registers a URL for multiple payment events", () => {
      const result = registerPaymentWebhook(SECRET_URL, [
        "payment_received",
        "payment_sent",
      ]);
      expect(result.status).toBe("ok");
      expect(listPaymentWebhooks("payment_received")).toHaveLength(1);
      expect(listPaymentWebhooks("payment_sent")).toHaveLength(1);
      expect(listPaymentWebhooks("payment_failed")).toHaveLength(0);
    });

    it("rejects an empty events array", () => {
      const result = registerPaymentWebhook(SECRET_URL, []);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_CONFIG");
    });

    it("rejects an invalid event type", () => {
      const result = registerPaymentWebhook(SECRET_URL, [
        "payment_invalid" as PaymentNotificationEvent,
      ]);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_CONFIG");
      expect(listPaymentWebhooks("payment_received")).toHaveLength(0);
    });

    it("rejects an invalid URL", () => {
      const result = registerPaymentWebhook("not-a-url", ["payment_received"]);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_CONFIG");
    });

    it("rejects an invalid maxRetries", () => {
      const result = registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        maxRetries: -1,
      });
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_CONFIG");
    });

    it("rejects an invalid timeoutMs", () => {
      const result = registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        timeoutMs: 0,
      });
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_CONFIG");
    });

    it("does not duplicate registrations for repeated events", () => {
      const result = registerPaymentWebhook(SECRET_URL, [
        "payment_received",
        "payment_received",
      ]);
      expect(result.status).toBe("ok");
      expect(listPaymentWebhooks("payment_received")).toHaveLength(1);
    });

    it("unregisters a specific event", () => {
      registerPaymentWebhook(SECRET_URL, ["payment_received", "payment_sent"]);
      const result = unregisterPaymentWebhook(SECRET_URL, "payment_received");
      expect(result.status).toBe("ok");
      expect(listPaymentWebhooks("payment_received")).toHaveLength(0);
      expect(listPaymentWebhooks("payment_sent")).toHaveLength(1);
    });

    it("fails to unregister a nonexistent webhook", () => {
      const result = unregisterPaymentWebhook(SECRET_URL, "payment_received");
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_CONFIG");
    });
  });

  describe("event IDs (idempotency)", () => {
    it("derives the same event ID for the same payment identity", () => {
      const a = generatePaymentEventId("tx-1", "payment_received", "GA001");
      const b = generatePaymentEventId("tx-1", "payment_received", "GA001");
      expect(a).toBe(b);
    });

    it("derives distinct event IDs for distinct payments", () => {
      const a = generatePaymentEventId("tx-1", "payment_received", "GA001");
      const b = generatePaymentEventId("tx-2", "payment_received", "GA001");
      const c = generatePaymentEventId("tx-1", "payment_sent", "GA001");
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
    });

    it("delivers identical event ID on duplicate deliveries", async () => {
      global.fetch = vi.fn(() => Promise.resolve(okResponse()));
      registerPaymentWebhook(SECRET_URL, ["payment_received"]);

      const input = {
        transactionId: "tx-dup",
        account: "GA001",
      };
      await triggerPaymentNotifications("payment_received", input);
      await triggerPaymentNotifications("payment_received", input);

      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(firstBody.eventId).toBe(secondBody.eventId);
      expect(firstBody.eventId).toBe(
        generatePaymentEventId("tx-dup", "payment_received", "GA001"),
      );
    });

    it("sends the event ID as an idempotency header", async () => {
      global.fetch = vi.fn(() => Promise.resolve(okResponse()));
      registerPaymentWebhook(SECRET_URL, ["payment_received"]);

      await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-h",
        account: "GA001",
      });

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
      const payload = JSON.parse(init.body);
      expect(init.headers["Idempotency-Key"]).toBe(payload.eventId);
      expect(init.headers["X-Sorokit-Event-Id"]).toBe(payload.eventId);
    });
  });

  describe("payload shape", () => {
    it("includes event ID, timestamp, transaction ID, account, and event type", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
      global.fetch = fetchMock as typeof fetch;
      registerPaymentWebhook(SECRET_URL, ["payment_confirmed"]);

      const results = await triggerPaymentNotifications("payment_confirmed", {
        transactionId: "tx-payload",
        account: "GA100",
      });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("ok");

      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      const payload = JSON.parse(init.body);
      expect(typeof payload.eventId).toBe("string");
      expect(payload.event).toBe("payment_confirmed");
      expect(typeof payload.timestamp).toBe("string");
      expect(new Date(payload.timestamp).toString()).not.toBe("Invalid Date");
      expect(payload.transactionId).toBe("tx-payload");
      expect(payload.account).toBe("GA100");
    });
  });

  describe("delivery", () => {
    it("successfully delivers to a healthy endpoint", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
      global.fetch = fetchMock as typeof fetch;
      registerPaymentWebhook(SECRET_URL, ["payment_received"]);

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-ok",
        account: "GA001",
      });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not deliver to endpoints not subscribed to the event", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
      global.fetch = fetchMock as typeof fetch;
      registerPaymentWebhook(SECRET_URL, ["payment_received"]);

      const results = await triggerPaymentNotifications("payment_sent", {
        transactionId: "tx-no",
        account: "GA001",
      });
      expect(results).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("retries (exponential backoff)", () => {
    it("retries a transient failure then succeeds", async () => {
      let attempts = 0;
      global.fetch = vi.fn(() => {
        attempts++;
        if (attempts < 3) return Promise.reject(new Error("flaky"));
        return Promise.resolve(okResponse());
      });
      registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        maxRetries: 3,
      });

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-retry",
        account: "GA001",
      });
      expect(results[0].status).toBe("ok");
      expect(attempts).toBe(3);
    });

    it("gives up after exhausting configured attempts", async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error("down")));
      registerPaymentWebhook(SECRET_URL, ["payment_failed"], {
        maxRetries: 2,
      });

      const results = await triggerPaymentNotifications("payment_failed", {
        transactionId: "tx-fail",
        account: "GA001",
      });
      expect(results[0].status).toBe("error");
      expect(results[0].error?.code).toBe("NETWORK_ERROR");
      expect((global.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3); // 1 + 2 retries
    }, 20000);
  });

  describe("timeout", () => {
    it("treats a slow endpoint as a failed attempt", async () => {
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error("timed out")), 50);
          }),
      );
      global.fetch = fetchMock as typeof fetch;
      registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        maxRetries: 0,
        timeoutMs: 5,
      });

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-timeout",
        account: "GA001",
      });
      expect(results[0].status).toBe("error");
      expect((global.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    }, 20000);
  });

  describe("failed endpoints", () => {
    it("surfaces an HTTP error for a failing endpoint", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({ ok: false, status: 500, statusText: "Internal" } as Response),
      );
      registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        maxRetries: 0,
      });

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-500",
        account: "GA001",
      });
      expect(results[0].status).toBe("error");
      expect(results[0].error?.code).toBe("NETWORK_ERROR");
    });

    it("reports one failing endpoint without masking another", async () => {
      const failingUrl = "https://fail.example.com/webhook";
      const goodUrl = "https://good.example.com/webhook";
      global.fetch = vi.fn((url: string) =>
        Promise.resolve(
          url === failingUrl
            ? ({ ok: false, status: 500 } as Response)
            : okResponse(),
        ),
      );
      registerPaymentWebhook(failingUrl, ["payment_received"], {
        maxRetries: 0,
      });
      registerPaymentWebhook(goodUrl, ["payment_received"], {
        maxRetries: 0,
      });

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-two",
        account: "GA001",
      });
      expect(results).toHaveLength(2);
      expect(results.some((r) => r.status === "error")).toBe(true);
      expect(results.some((r) => r.status === "ok")).toBe(true);
    });
  });

  describe("notification channels (decoupled)", () => {
    it("delivers to registered channels alongside webhooks", async () => {
      global.fetch = vi.fn(() => Promise.resolve(okResponse()));
      const channel: PaymentNotificationChannel = {
        name: "test-channel",
        deliver: vi.fn(() => Promise.resolve(true)),
      };
      registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        channels: [channel],
      });

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-channel",
        account: "GA001",
      });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "ok")).toBe(true);
      expect(channel.deliver).toHaveBeenCalledTimes(1);
    });

    it("surfaces channel failures without coupling to webhook logic", async () => {
      global.fetch = vi.fn(() => Promise.resolve(okResponse()));
      const channel: PaymentNotificationChannel = {
        name: "failing-channel",
        deliver: vi.fn(() => Promise.resolve(false)),
      };
      registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        channels: [channel],
      });

      const results = await triggerPaymentNotifications("payment_received", {
        transactionId: "tx-chanfail",
        account: "GA001",
      });
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe("ok"); // webhook ok
      expect(results[1].status).toBe("error"); // channel rejected
      expect(results[1].error?.code).toBe("NETWORK_ERROR");
    });
  });

  describe("dispatchPaymentNotification", () => {
    it("returns immediately without blocking on delivery", async () => {
      let resolveFetch: (value: Response) => void = () => undefined;
      global.fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      registerPaymentWebhook(SECRET_URL, ["payment_received"]);

      const before = Date.now();
      dispatchPaymentNotification("payment_received", {
        transactionId: "tx-fast",
        account: "GA001",
      });
      const elapsed = Date.now() - before;
      expect(elapsed).toBeLessThan(100);
      resolveFetch(okResponse());
    });

    it("swallows delivery failures without unhandled rejections", async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error("down")));
      registerPaymentWebhook(SECRET_URL, ["payment_received"], {
        maxRetries: 0,
      });

      expect(() =>
        dispatchPaymentNotification("payment_received", {
          transactionId: "tx-swallow",
          account: "GA001",
        }),
      ).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    }, 20000);

    it("is a no-op when nothing is subscribed", () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as typeof fetch;
      dispatchPaymentNotification("payment_received", {
        transactionId: "tx-noop",
        account: "GA001",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
