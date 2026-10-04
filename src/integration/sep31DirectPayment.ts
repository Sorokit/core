import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface DirectPaymentAsset {
  code: string;
  issuer?: string;
}

export interface DirectPaymentReceiver {
  account?: string;
  stellarAddress?: string;
  [key: string]: unknown;
}

export interface DirectPaymentQuoteRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  authToken?: string;
  accountId?: string;
  params?: Record<string, string>;
}

function normalizeServerUrl(serverUrl: string): URL {
  const value = serverUrl.trim();
  if (!value) throw new Error("A server URL is required.");
  return /^https?:\/\//i.test(value)
    ? new URL(value.endsWith("/") ? value : `${value}/`)
    : new URL(`https://${value}`);
}

async function fetchJson<T>(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const data = (await response.json()) as T;
    if (!response.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `Request failed with status ${response.status}.`;
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function resolveReceiverAddress(receiver: string | DirectPaymentReceiver): string {
  if (typeof receiver === "string") return receiver.trim();
  const address = receiver.stellarAddress ?? receiver.account;
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("A valid receiver address is required.");
  }
  return address.trim();
}

export async function quoteDirectPayment(
  serverUrl: string,
  sendingAsset: DirectPaymentAsset,
  receiver: string | DirectPaymentReceiver,
  options: DirectPaymentQuoteRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!sendingAsset?.code?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "A sending asset code is required.");
  }
  let receiverAddress: string;
  try {
    receiverAddress = resolveReceiverAddress(receiver);
  } catch (cause) {
    return err(SorokitErrorCode.VALIDATION, "A valid receiver address is required.", cause);
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep31/quote", base.toString());
    url.searchParams.set("asset_code", sendingAsset.code);
    if (sendingAsset.issuer) url.searchParams.set("asset_issuer", sendingAsset.issuer);
    url.searchParams.set("recipient", receiverAddress);
    if (options.accountId) url.searchParams.set("account", options.accountId);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "GET",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-31 direct payment quote failed.", cause);
  }
}

export async function sendDirectPayment(
  serverUrl: string,
  amount: string,
  receiver: string | DirectPaymentReceiver,
  options: DirectPaymentQuoteRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!amount?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "A payment amount is required.");
  }
  let receiverAddress: string;
  try {
    receiverAddress = resolveReceiverAddress(receiver);
  } catch (cause) {
    return err(SorokitErrorCode.VALIDATION, "A valid receiver address is required.", cause);
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep31/transactions", base.toString());
    url.searchParams.set("amount", amount);
    url.searchParams.set("recipient", receiverAddress);
    if (options.accountId) url.searchParams.set("account", options.accountId);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "POST",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-31 direct payment submission failed.", cause);
  }
}

export async function trackDirectPayment(
  serverUrl: string,
  txId: string,
  options: DirectPaymentQuoteRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!txId?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "A transaction ID is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep31/transactions", base.toString());
    url.searchParams.set("id", txId);
    if (options.accountId) url.searchParams.set("account", options.accountId);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "GET",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-31 direct payment tracking failed.", cause);
  }
}
