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
  /** State token to bind the interactive redirect to this initiation. */
  state?: string;
  /** Lifetime of the state token in milliseconds. */
  stateTtlMs?: number;
}

const pendingStates = new Map<string, { origin: string; expiresAt: number }>();

function createState(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(24);
  cryptoApi?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function attachState(result: Record<string, unknown>, base: URL, options: Sep24FlowRequestOptions): Record<string, unknown> {
  const state = options.state?.trim() || createState();
  if (!state) throw new Error("A non-empty SEP-24 state is required.");
  pendingStates.set(state, { origin: base.origin, expiresAt: Date.now() + (options.stateTtlMs ?? 10 * 60_000) });
  const redirectKey = typeof result.url === "string" ? "url" : typeof result.interactive_url === "string" ? "interactive_url" : undefined;
  if (redirectKey) {
    const redirect = new URL(result[redirectKey] as string);
    redirect.searchParams.set("state", state);
    result = { ...result, [redirectKey]: redirect.toString() };
  }
  return { ...result, state };
}

/** Validate and consume the one-time state returned by an interactive callback. */
export function validateInteractiveCallback(
  serverUrl: string,
  callbackUrl: string,
): SorokitResult<Record<string, string>> {
  try {
    const origin = normalizeServerUrl(serverUrl).origin;
    const callback = new URL(callbackUrl);
    const state = callback.searchParams.get("state");
    if (!state) return err(SorokitErrorCode.VALIDATION, "SEP-24 callback is missing its state token.");
    const pending = pendingStates.get(state);
    if (!pending || pending.origin !== origin || pending.expiresAt < Date.now()) {
      pendingStates.delete(state);
      return err(SorokitErrorCode.VALIDATION, "SEP-24 callback state is invalid or expired.");
    }
    pendingStates.delete(state);
    return ok(Object.fromEntries(callback.searchParams.entries()));
  } catch (cause) {
    return err(SorokitErrorCode.VALIDATION, "A valid SEP-24 callback URL is required.", cause);
  }
}

function withParams(url: URL, params?: Record<string, string>): void {
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
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
    withParams(url, options.params);
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
    return ok(attachState(result, base, options));
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
    withParams(url, options.params);
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
    return ok(attachState(result, base, options));
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
