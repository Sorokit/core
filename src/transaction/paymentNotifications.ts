/**
 * Payment notification subsystem.
 *
 * Lets applications subscribe a webhook endpoint (or an optional, decoupled
 * notification channel) to payment lifecycle events such as payment_received,
 * payment_sent, payment_failed, and payment_confirmed.
 *
 * Design goals (see fix.md):
 *  - Transport-agnostic delivery: the payload contract and dispatch logic do
 *    not depend on any particular HTTP client or channel implementation.
 *  - Non-blocking: dispatch never blocks (or throws into) the transaction
 *    processing path.
 *  - Bounded retries: exponential backoff with a hard cap and a configurable
 *    attempt limit so retry behavior cannot become an uncontrolled loop.
 *  - Idempotency: every payload carries a deterministic event ID derived from
 *    the payment identity so consumers can safely discard duplicate
 *    deliveries.
 *  - Clean error surfacing: registration and delivery failures are returned as
 *    structured `SorokitResult` errors.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep } from "../shared/utils";
import type { SorokitLogger } from "../shared/logger";

/**
 * Canonical payment lifecycle event types.
 */
export type PaymentNotificationEvent =
  | "payment_received"
  | "payment_sent"
  | "payment_failed"
  | "payment_confirmed";

/**
 * The full list of supported payment event types.
 */
export const PAYMENT_NOTIFICATION_EVENTS: readonly PaymentNotificationEvent[] = [
  "payment_received",
  "payment_sent",
  "payment_failed",
  "payment_confirmed",
];

/** Type guard for {@link PaymentNotificationEvent}. */
export function isPaymentNotificationEvent(
  value: unknown,
): value is PaymentNotificationEvent {
  return (
    typeof value === "string" &&
    (PAYMENT_NOTIFICATION_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Delivery options for a single webhook subscription.
 */
export interface PaymentWebhookOptions {
  /** Maximum number of retry attempts after the initial request (default: 3). */
  maxRetries?: number;
  /** Per-attempt request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /**
   * Optional list of notification channels to deliver to in addition to the
   * HTTP webhook. Channels are an independently decoupled abstraction so
   * additional transports (Slack, SMS, email, …) can be plugged in without
   * coupling them to the webhook delivery logic.
   */
  channels?: PaymentNotificationChannel[];
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

/**
 * Webhook payload delivered to a subscriber.
 *
 * Standardized so consumers can safely process duplicate deliveries: the
 * `eventId` is deterministic for a given (account, event, transactionId), so
 * redelivery of the same logical event is always identifiable.
 */
export interface PaymentWebhookPayload {
  /** Deterministic event identifier for idempotency / duplicate detection. */
  eventId: string;
  /** The payment lifecycle event that occurred. */
  event: PaymentNotificationEvent;
  /** ISO-8601 timestamp of when the event was emitted. */
  timestamp: string;
  /** The transaction this payment event relates to. */
  transactionId: string;
  /** The account associated with the payment. */
  account: string;
}

/** Input describing an emitted payment event. */
export interface PaymentNotificationInput {
  /** Transaction identifier the payment belongs to. */
  transactionId: string;
  /** Account associated with the payment. */
  account: string;
  /**
   * Optional explicit event ID. When omitted, one is derived deterministically
   * from the event identity so duplicate deliveries share the same ID.
   */
  eventId?: string;
  /**
   * Optional callback invoked whenever a notification delivery fails.
   */
  onDeliveryFailure?: PaymentDeliveryFailureCallback | undefined;
}

/**
 * A registered webhook subscription.
 */
export interface PaymentWebhookRegistration {
  /** URL to deliver webhook payloads to. */
  url: string;
  /** Payment events this subscription is interested in. */
  events: PaymentNotificationEvent[];
  /** Resolved delivery options. */
  options: Required<Omit<PaymentWebhookOptions, "channels">>;
}

/**
 * Decoupled notification channel abstraction.
 *
 * Applications may register channels to receive the same payload as webhook
 * subscribers. Implementing this interface is entirely independent of the
 * webhook delivery machinery, satisfying the "without coupling them to
 * webhook logic" requirement.
 */
export interface PaymentNotificationChannel {
  /** Human-readable channel name, used in error messages. */
  readonly name: string;
  /**
   * Deliver a payload through this channel.
   * Return `true` on success. Returning `false` (or throwing) counts as a
   * failed attempt and is retried like a failed webhook delivery.
   */
  deliver(payload: PaymentWebhookPayload): Promise<boolean>;
}

const webhookRegistry = new Map<string, PaymentWebhookRegistration>();
// WeakSet so a channel is eligible for garbage collection as soon as no
// other reference to it remains, instead of being pinned alive forever by
// this module-level registry (#842).
const channelRegistry = new WeakSet<PaymentNotificationChannel>();
// WeakSet has no iteration protocol, so channel delivery needs its own
// enumerable list. Each entry is a WeakRef, letting GC reclaim subscribers
// that are no longer referenced elsewhere; dead refs are pruned lazily.
const channelRefs: WeakRef<PaymentNotificationChannel>[] = [];

/** Registry key — one entry per (url, event) pair. */
function registrationKey(
  url: string,
  event: PaymentNotificationEvent,
): string {
  return `${url}::${event}`;
}

function validateUrl(url: string): SorokitResult<void> | undefined {
  if (typeof url !== "string" || url.length === 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Webhook URL must be a non-empty string",
    );
  }
  try {
    new URL(url);
  } catch {
    return err(SorokitErrorCode.INVALID_CONFIG, `Invalid webhook URL: ${url}`);
  }
  return undefined;
}

function isNonNegativeInteger(value: number, name: string): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateOptions(
  options: PaymentWebhookOptions | undefined,
): SorokitResult<Required<Omit<PaymentWebhookOptions, "channels">>> | undefined {
  if (options === undefined) {
    return ok({
      maxRetries: DEFAULT_MAX_RETRIES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!isNonNegativeInteger(maxRetries, "maxRetries")) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "maxRetries must be a non-negative integer",
    );
  }
  if (!isNonNegativeInteger(timeoutMs, "timeoutMs") || timeoutMs === 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "timeoutMs must be a positive integer",
    );
  }
  return ok({ maxRetries, timeoutMs });
}

/**
 * Register a webhook (and optional notification channels) for one or more
 * payment events.
 *
 * @param url     - URL to deliver webhook payloads to.
 * @param events  - Payment event types to subscribe to.
 * @param options - Delivery options (retries, timeout, extra channels).
 * @returns ok(void) on success, or a structured error on invalid input.
 *
 * @example
 * const result = registerPaymentWebhook(
 *   "https://example.com/payments",
 *   ["payment_received", "payment_failed"],
 *   { maxRetries: 5, timeoutMs: 5000 },
 * );
 */
export function registerPaymentWebhook(
  url: string,
  events: PaymentNotificationEvent[],
  options?: PaymentWebhookOptions,
): SorokitResult<void> {
  if (!Array.isArray(events) || events.length === 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "At least one payment event type must be provided",
    );
  }

  const normalized: PaymentNotificationEvent[] = [];
  for (const event of events) {
    if (!isPaymentNotificationEvent(event)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid payment event type: ${String(event)}. Must be one of: ${PAYMENT_NOTIFICATION_EVENTS.join(", ")}`,
      );
    }
    normalized.push(event);
  }

  const urlError = validateUrl(url);
  if (urlError) return urlError;

  const optionsResult = validateOptions(options);
  if (optionsResult && optionsResult.status === "error") return optionsResult;
  const resolvedOptions = optionsResult!.data;

  for (const channel of options?.channels ?? []) {
    if (!channel || typeof channel.deliver !== "function") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Notification channels must implement deliver(payload)",
      );
    }
    if (!channelRegistry.has(channel)) {
      channelRegistry.add(channel);
      channelRefs.push(new WeakRef(channel));
    }
  }

  const registration: PaymentWebhookRegistration = {
    url,
    events: normalized,
    options: resolvedOptions,
  };

  for (const event of normalized) {
    webhookRegistry.set(registrationKey(url, event), registration);
  }

  return ok(undefined);
}

/**
 * Remove a webhook subscription for a specific event.
 */
export function unregisterPaymentWebhook(
  url: string,
  event: PaymentNotificationEvent,
): SorokitResult<void> {
  if (!isPaymentNotificationEvent(event)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Invalid payment event type: ${String(event)}`,
    );
  }
  const key = registrationKey(url, event);
  if (!webhookRegistry.has(key)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `No webhook registered for event '${event}' at '${url}'`,
    );
  }
  webhookRegistry.delete(key);
  return ok(undefined);
}

/**
 * List all webhook subscriptions for a payment event type.
 */
export function listPaymentWebhooks(
  event: PaymentNotificationEvent,
): PaymentWebhookRegistration[] {
  if (!isPaymentNotificationEvent(event)) return [];
  const results: PaymentWebhookRegistration[] = [];
  for (const [key, registration] of webhookRegistry.entries()) {
    if (key.endsWith(`::${event}`) && !results.includes(registration)) {
      results.push(registration);
    }
  }
  return results;
}

/** Clear all registered webhook subscriptions. */
export function clearPaymentWebhooks(): void {
  webhookRegistry.clear();
  channelRefs.length = 0;
}

/**
 * Returns the currently live (not yet garbage-collected) notification
 * channels, pruning dead WeakRefs from the tracking list as it goes.
 */
function liveChannels(): PaymentNotificationChannel[] {
  const live: PaymentNotificationChannel[] = [];
  for (let i = channelRefs.length - 1; i >= 0; i--) {
    const channel = channelRefs[i]!.deref();
    if (channel === undefined) {
      channelRefs.splice(i, 1);
    } else {
      live.push(channel);
    }
  }
  return live;
}

/**
 * Observability/test helper: number of notification channels still
 * reachable (not yet garbage-collected).
 */
export function getRegisteredChannelCount(): number {
  return liveChannels().length;
}

/**
 * Deterministically derive an event ID from the payment identity so duplicate
 * deliveries of the same logical event carry the same identifier.
 *
 * FNV-1a (32-bit) over `transactionId | event | account`, hex-encoded.
 */
export function generatePaymentEventId(
  transactionId: string,
  event: PaymentNotificationEvent,
  account: string,
): string {
  const data = `${transactionId}|${event}|${account}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Resolve the event ID, applying caller-supplied override or the derived one. */
function resolveEventId(
  input: PaymentNotificationInput,
  event: PaymentNotificationEvent,
): string {
  return input.eventId ?? generatePaymentEventId(input.transactionId, event, input.account);
}

/**
 * Send a webhook payload with exponential backoff and a configurable retry
 * limit and timeout.
 *
 * @param registration - The subscription to deliver to.
 * @param payload      - Payload to deliver.
 * @returns ok(void) on success, or a structured error after the final attempt.
 */
async function sendPayloadWithRetry(
  registration: PaymentWebhookRegistration,
  payload: PaymentWebhookPayload,
): Promise<SorokitResult<void>> {
  const { url } = registration;
  const { maxRetries, timeoutMs } = registration.options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sorokit-Event": payload.event,
          "X-Sorokit-Event-Id": payload.eventId,
          "Idempotency-Key": payload.eventId,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return ok(undefined);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        // Exponential backoff (1s, 2s, 4s, …) capped at MAX_BACKOFF_MS so
        // retry behavior can never spin out of control.
        const delayMs = Math.min(
          DEFAULT_BACKOFF_MS * Math.pow(2, attempt),
          MAX_BACKOFF_MS,
        );
        await sleep(delayMs);
      }
    }
  }

  return err(
    SorokitErrorCode.NETWORK_ERROR,
    `Payment webhook delivery failed after ${maxRetries + 1} attempts to ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError,
  );
}

/**
 * Information describing a failed payment notification delivery.
 */
export interface PaymentDeliveryFailure {
  /** Webhook URL or notification channel name where delivery failed. */
  url: string;
  /** The payment event type that failed delivery. */
  event: PaymentNotificationEvent;
  /** Error that caused delivery failure. */
  error: unknown;
  /** The webhook payload that failed to deliver. */
  payload?: PaymentWebhookPayload | undefined;
}

/**
 * Callback invoked when a payment notification delivery fails.
 */
export type PaymentDeliveryFailureCallback = (
  failure: PaymentDeliveryFailure,
) => void | Promise<void>;

/**
 * Options for dispatching payment notifications.
 */
export interface DispatchPaymentNotificationOptions {
  /** Optional callback invoked for each delivery failure. */
  onDeliveryFailure?: PaymentDeliveryFailureCallback | undefined;
  /** Optional custom logger. Defaults to console.warn if not provided. */
  logger?: SorokitLogger | undefined;
}

export type DispatchPaymentNotificationHandler =
  | PaymentDeliveryFailureCallback
  | DispatchPaymentNotificationOptions;

/** Deliver a payload through any registered notification channels. */
async function deliverToChannels(
  payload: PaymentWebhookPayload,
  onChannelFailure?: (channelName: string, error: unknown) => void,
): Promise<SorokitResult<void>[]> {
  return Promise.all(
    liveChannels().map(async (channel) => {
      try {
        const delivered = await channel.deliver(payload);
        if (delivered) return ok(undefined);
        const error = new Error(
          `Notification channel '${channel.name}' rejected payload for event '${payload.event}'`,
        );
        onChannelFailure?.(channel.name, error);
        return err(
          SorokitErrorCode.NETWORK_ERROR,
          error.message,
          error,
        );
      } catch (error) {
        onChannelFailure?.(channel.name, error);
        return err(
          SorokitErrorCode.NETWORK_ERROR,
          `Notification channel '${channel.name}' failed for event '${payload.event}': ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }),
  );
}

/**
 * Trigger delivery of a payment notification to all matching subscribers and
 * wait for the results.
 *
 * Deliveries run concurrently and are reported independently so one failing
 * endpoint cannot mask another.
 *
 * @param event   - The payment event that occurred.
 * @param input   - Payment identity (transactionId, account, optional eventId, optional onDeliveryFailure).
 * @param options - Optional delivery failure callback or options object.
 * @returns One result per delivery target (ok or error).
 */
export async function triggerPaymentNotifications(
  event: PaymentNotificationEvent,
  input: PaymentNotificationInput,
  options?: DispatchPaymentNotificationHandler,
): Promise<SorokitResult<void>[]> {
  let failureCallback: PaymentDeliveryFailureCallback | undefined;
  let customLogger: SorokitLogger | undefined;

  if (typeof options === "function") {
    failureCallback = options;
  } else if (options && typeof options === "object") {
    failureCallback = options.onDeliveryFailure;
    customLogger = options.logger;
  }

  if (!failureCallback && input?.onDeliveryFailure) {
    failureCallback = input.onDeliveryFailure;
  }

  const notifyFailure = (
    url: string,
    error: unknown,
    payload?: PaymentWebhookPayload,
  ) => {
    const failure: PaymentDeliveryFailure = {
      url,
      event,
      error,
      ...(payload !== undefined ? { payload } : {}),
    };

    if (failureCallback) {
      try {
        const maybePromise = failureCallback(failure);
        if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
          (maybePromise as Promise<void>).catch(() => {});
        }
      } catch {
        // Callback errors must never surface into caller
      }
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    const logMessage = `Payment notification delivery failed for event '${String(event)}' to '${url}': ${errorMsg}`;
    const logMeta = {
      url,
      event,
      error,
      transactionId: input?.transactionId,
      account: input?.account,
      eventId: payload?.eventId,
    };

    if (customLogger) {
      customLogger.warn(logMessage, logMeta);
    } else {
      console.warn(`[sorokit] ${logMessage}`, logMeta);
    }
  };

  if (!isPaymentNotificationEvent(event)) {
    return [
      err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid payment event type: ${String(event)}`,
      ),
    ];
  }
  if (typeof input.transactionId !== "string" || input.transactionId.length === 0) {
    return [err(SorokitErrorCode.INVALID_CONFIG, "transactionId must be a non-empty string")];
  }
  if (typeof input.account !== "string" || input.account.length === 0) {
    return [err(SorokitErrorCode.INVALID_CONFIG, "account must be a non-empty string")];
  }

  const payload: PaymentWebhookPayload = {
    eventId: resolveEventId(input, event),
    event,
    timestamp: new Date().toISOString(),
    transactionId: input.transactionId,
    account: input.account,
  };

  const registrations = listPaymentWebhooks(event);
  const webhookResults = await Promise.all(
    registrations.map(async (registration) => {
      const result = await sendPayloadWithRetry(registration, payload);
      if (result.status === "error") {
        const error = result.error.cause ?? new Error(result.error.message);
        notifyFailure(registration.url, error, payload);
      }
      return result;
    }),
  );
  const channelResults = await deliverToChannels(payload, (channelName, error) => {
    notifyFailure(channelName, error, payload);
  });
  return [...webhookResults, ...channelResults];
}

/**
 * Fire-and-forget dispatch of a payment notification with error tracking.
 *
 * Never throws, never rejects, and never blocks transaction processing while
 * subscribers are being notified. Delivery failures are surfaced via an optional
 * `onDeliveryFailure` callback or logged at warn level with the webhook URL,
 * event type, and error.
 *
 * @param event   - The payment event that occurred.
 * @param input   - Payment identity (transactionId, account, optional eventId, optional onDeliveryFailure).
 * @param options - Optional failure callback or options object with callback/logger.
 */
export function dispatchPaymentNotification(
  event: PaymentNotificationEvent,
  input: PaymentNotificationInput,
  options?: DispatchPaymentNotificationHandler,
): Promise<void> {
  try {
    return triggerPaymentNotifications(event, input, options)
      .then(() => undefined)
      .catch(() => {
        // Swallow: notification delivery must never surface into the
        // transaction/payment processing flow.
      });
  } catch {
    // Defensive: even synchronous failures must not propagate.
    return Promise.resolve();
  }
}
