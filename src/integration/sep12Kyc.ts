import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface KycFieldDefinition {
  name: string;
  type?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface KycSubmissionInfo {
  [key: string]: unknown;
}

export interface KycRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  authToken?: string;
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

export async function getKycFields(
  serverUrl: string,
  account: string,
  options: KycRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!account?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An account identifier is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep12/fields", base.toString());
    url.searchParams.set("account", account);
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
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC field retrieval failed.", cause);
  }
}

export async function submitKycInfo(
  serverUrl: string,
  account: string,
  info: KycSubmissionInfo,
  options: KycRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!account?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An account identifier is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep12/customer", base.toString());
    url.searchParams.set("account", account);
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return err(SorokitErrorCode.INVALID_CONFIG, "A fetch implementation is required.");
    }
    const result = await fetchJson<Record<string, unknown>>(
      fetcher,
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
        },
        body: JSON.stringify(info),
      },
      options.timeoutMs ?? 15_000,
    );
    return ok(result);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC submission failed.", cause);
  }
}

export async function getKycStatus(
  serverUrl: string,
  account: string,
  options: KycRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!account?.trim()) {
    return err(SorokitErrorCode.VALIDATION, "An account identifier is required.");
  }
  try {
    const base = normalizeServerUrl(serverUrl);
    const url = new URL("sep12/status", base.toString());
    url.searchParams.set("account", account);
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
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-12 KYC status lookup failed.", cause);
  }
}
