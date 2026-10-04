import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface Sep24FlowAsset {
  code: string;
  issuer?: string;
}

export interface Sep24FlowRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  authToken?: string;
  accountId?: string;
  amount?: string;
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

export async function initiateInteractiveDeposit(
  serverUrl: string,
  asset: Sep24FlowAsset,
  options: Sep24FlowRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!asset?.code?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An asset code is required for interactive deposit initiation.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep24/deposit", base.toString());
    url.searchParams.set("asset_code", asset.code);
    if (asset.issuer) url.searchParams.set("asset_issuer", asset.issuer);
    if (options.accountId) url.searchParams.set("account", options.accountId);
    if (options.amount) url.searchParams.set("amount", options.amount);
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
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-24 deposit initiation failed.", cause);
  }
}

export async function initiateInteractiveWithdraw(
  serverUrl: string,
  asset: Sep24FlowAsset,
  options: Sep24FlowRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!asset?.code?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An asset code is required for interactive withdrawal initiation.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep24/withdraw", base.toString());
    url.searchParams.set("asset_code", asset.code);
    if (asset.issuer) url.searchParams.set("asset_issuer", asset.issuer);
    if (options.accountId) url.searchParams.set("account", options.accountId);
    if (options.amount) url.searchParams.set("amount", options.amount);
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
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-24 withdrawal initiation failed.", cause);
  }
}

export async function monitorTransaction(
  serverUrl: string,
  txId: string,
  options: Sep24FlowRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!txId?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "A transaction ID is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep24/transactions", base.toString());
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
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-24 transaction monitoring failed.", cause);
  }
}
