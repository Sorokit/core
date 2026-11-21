import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface Sep6FlowAsset {
  code: string;
  issuer?: string;
}

export interface Sep6FlowRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  authToken?: string;
  accountId?: string;
  amount?: string;
  params?: Record<string, string>;
}

function normalizeServerUrl(serverUrl: string): URL {
  const value = serverUrl.trim();
  if (!value) {
    throw new Error("A server URL is required.");
  }
  if (/^https?:\/\//i.test(value)) {
    return new URL(value.endsWith("/") ? value : `${value}/`);
  }
  return new URL(`https://${value}`);
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

function buildAssetParams(asset: Sep6FlowAsset): Record<string, string> {
  const params: Record<string, string> = { asset_code: asset.code };
  if (asset.issuer) params.asset_issuer = asset.issuer;
  return params;
}

function buildFlowUrl(baseUrl: URL, endpoint: string): URL {
  return new URL(endpoint, baseUrl.toString());
}

/**
 * Validates that a withdrawal amount string is a positive, finite number
 * before it ever reaches the network (issue #783). `options.amount` is a
 * plain string — this SDK does not parse it until the anchor does — so
 * `0`, `-100`, `"NaN"`, or any other non-numeric input previously reached
 * the anchor unchecked, wasting a round-trip on an error the SDK could
 * have caught locally.
 */
function validateWithdrawalAmount(amount: string | undefined): string | null {
  if (amount === undefined) return null; // amount is optional; absence is not invalid.
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return `Withdrawal amount must be a positive finite number, received "${amount}".`;
  }
  return null;
}

export async function initiateDeposit(
  serverUrl: string,
  asset: Sep6FlowAsset,
  options: Sep6FlowRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!asset?.code?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An asset code is required for deposit initiation.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = buildFlowUrl(base, "sep6/deposit");
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
        method: "GET",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-6 deposit initiation failed.", cause);
  }
}

export async function initiateWithdraw(
  serverUrl: string,
  asset: Sep6FlowAsset,
  options: Sep6FlowRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!asset?.code?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An asset code is required for withdrawal initiation.");
  }
  const amountError = validateWithdrawalAmount(options.amount);
  if (amountError) {
    return err(SorokitErrorCode.VALIDATION, amountError);
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = buildFlowUrl(base, "sep6/withdraw");
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
        method: "GET",
        headers: options.authToken ? { Authorization: `Bearer ${options.authToken}`, Accept: "application/json" } : { Accept: "application/json" },
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-6 withdrawal initiation failed.", cause);
  }
}

export async function trackTransaction(
  serverUrl: string,
  txId: string,
  options: Sep6FlowRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!txId?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "A transaction ID is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = buildFlowUrl(base, "sep6/transaction");
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
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-6 transaction tracking failed.", cause);
  }
}
