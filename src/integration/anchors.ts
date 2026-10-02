import { StellarToml, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface AnchorAsset {
  code: string;
  issuer?: string;
}

export interface Sep10AuthOptions {
  accountId: string;
  /** Ask a wallet or secure signer to sign the verified challenge XDR. */
  signChallenge: (challengeXdr: string) => Promise<string>;
  networkPassphrase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AnchorRequestOptions {
  accountId?: string;
  signChallenge?: (challengeXdr: string) => Promise<string>;
  networkPassphrase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  amount?: string;
  type?: string;
  authToken?: string;
  params?: Record<string, string>;
}

export interface Sep24InteractiveResult {
  url: string;
  id: string;
}

interface AnchorToml {
  TRANSFER_SERVER?: string;
  TRANSFER_SERVER_SEP0024?: string;
  WEB_AUTH_ENDPOINT?: string;
  SIGNING_KEY?: string;
  NETWORK_PASSPHRASE?: string;
}

function asUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

async function loadToml(anchorUrl: string, timeoutMs: number): Promise<AnchorToml> {
  const url = asUrl(anchorUrl);
  if (!url) throw new Error("Anchor URL must use HTTPS.");
  return await StellarToml.Resolver.resolve(url.hostname, { timeout: timeoutMs }) as AnchorToml;
}

async function fetchJson<T>(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const body = await response.json() as T;
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Perform SEP-10 challenge authentication using a wallet-provided signer. */
export async function authenticateSep10(
  anchorUrl: string,
  options: Sep10AuthOptions,
): Promise<SorokitResult<string>> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    const toml = await loadToml(anchorUrl, timeoutMs);
    const endpoint = toml.WEB_AUTH_ENDPOINT ? asUrl(toml.WEB_AUTH_ENDPOINT) : null;
    if (!endpoint || !toml.SIGNING_KEY) {
      return err(SorokitErrorCode.INVALID_CONFIG, "Anchor stellar.toml must define WEB_AUTH_ENDPOINT and SIGNING_KEY.");
    }
    const networkPassphrase = options.networkPassphrase ?? toml.NETWORK_PASSPHRASE;
    if (!networkPassphrase) return err(SorokitErrorCode.INVALID_CONFIG, "Network passphrase is required for SEP-10.");

    const homeDomain = new URL(anchorUrl).hostname;
    const challengeUrl = new URL(endpoint);
    challengeUrl.searchParams.set("account", options.accountId);
    challengeUrl.searchParams.set("home_domain", homeDomain);
    const challengeResponse = await fetchJson<{ transaction?: string; error?: string }>(
      fetcher, challengeUrl, { method: "GET", headers: { Accept: "application/json" } }, timeoutMs,
    );
    if (!challengeResponse.response.ok || !challengeResponse.body.transaction) {
      throw new Error(challengeResponse.body.error ?? `SEP-10 challenge failed (${challengeResponse.response.status}).`);
    }

    const challengeXdr = challengeResponse.body.transaction;
    const challenge = WebAuth.readChallengeTx(
      challengeXdr, toml.SIGNING_KEY, networkPassphrase, homeDomain, homeDomain,
    );
    if (challenge.clientAccountID !== options.accountId || !WebAuth.verifyTxSignedBy(challenge.tx, toml.SIGNING_KEY)) {
      return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 challenge account or anchor signature is invalid.");
    }

    const signedXdr = await options.signChallenge(challengeXdr);
    const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
    // Ensure the wallet did not replace the verified challenge before submission.
    if (!signedTx.hash().equals(challenge.tx.hash())) {
      return err(SorokitErrorCode.INVALID_AUTH, "Signer returned a different transaction than the SEP-10 challenge.");
    }
    const payload = new URLSearchParams({ transaction: signedXdr });
    const authResponse = await fetchJson<{ token?: string; error?: string }>(
      fetcher, endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: payload,
      }, timeoutMs,
    );
    if (!authResponse.response.ok || !authResponse.body.token) {
      throw new Error(authResponse.body.error ?? `SEP-10 token request failed (${authResponse.response.status}).`);
    }
    return ok(authResponse.body.token);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-10 authentication failed.", cause);
  }
}

async function authorizedFetch(
  anchorUrl: string,
  endpoint: URL,
  options: AnchorRequestOptions,
  method: "GET" | "POST",
): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = new Headers({ Accept: "application/json" });
  if (options.authToken) headers.set("Authorization", `Bearer ${options.authToken}`);
  const body = new URLSearchParams();
  if (options.accountId) body.set("account", options.accountId);
  if (options.amount) body.set("amount", options.amount);
  if (options.type) body.set("type", options.type);
  for (const [key, value] of Object.entries(options.params ?? {})) body.set(key, value);

  const send = (token?: string) => {
    const requestHeaders = new Headers(headers);
    if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
    const url = new URL(endpoint);
    const init: RequestInit = { method, headers: requestHeaders };
    if (method === "GET") {
      for (const [key, value] of body) url.searchParams.set(key, value);
    } else {
      const form = new FormData();
      for (const [key, value] of body) form.set(key, value);
      // Let fetch set the multipart boundary; a hand-written Content-Type
      // would make the body invalid for SEP-24.
      init.body = form;
    }
    return fetchJson<unknown>(fetcher, url, init, timeoutMs);
  };

  let result = await send(options.authToken);
  if (result.response.status === 403 && !options.authToken && options.accountId && options.signChallenge) {
    const auth = await authenticateSep10(anchorUrl, {
      accountId: options.accountId,
      signChallenge: options.signChallenge,
      ...(options.networkPassphrase !== undefined ? { networkPassphrase: options.networkPassphrase } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (auth.status === "error") {
      const error = new Error(auth.error.message);
      (error as Error & { cause?: unknown }).cause = auth.error.cause;
      throw error;
    }
    result = await send(auth.data);
  }
  if (!result.response.ok) throw new Error(`Anchor request failed (${result.response.status}).`);
  return new Response(JSON.stringify(result.body), { status: result.response.status, headers: result.response.headers });
}

/** Start a SEP-6 deposit or withdrawal and return the anchor's transaction response. */
export async function initiateSep6Transfer(
  anchorUrl: string,
  asset: AnchorAsset,
  options: AnchorRequestOptions & { direction?: "deposit" | "withdraw" } = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  try {
    const toml = await loadToml(anchorUrl, options.timeoutMs ?? 15_000);
    const server = toml.TRANSFER_SERVER ? asUrl(toml.TRANSFER_SERVER) : null;
    if (!server) return err(SorokitErrorCode.INVALID_CONFIG, "Anchor has no valid TRANSFER_SERVER in stellar.toml.");
    const direction = options.direction ?? "deposit";
    const endpoint = new URL(direction, `${server.toString().replace(/\/$/, "")}/`);
    const response = await authorizedFetch(anchorUrl, endpoint, {
      ...options,
      params: { asset_code: asset.code, ...(asset.issuer ? { asset_issuer: asset.issuer } : {}), ...options.params },
    }, "GET");
    return ok(await response.json() as Record<string, unknown>);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-6 transfer request failed.", cause);
  }
}

/** Start a SEP-24 hosted interactive deposit or withdrawal. */
export async function initiateSep24Interactive(
  anchorUrl: string,
  asset: AnchorAsset,
  options: AnchorRequestOptions & { direction?: "deposit" | "withdraw" } = {},
): Promise<SorokitResult<Sep24InteractiveResult>> {
  try {
    const toml = await loadToml(anchorUrl, options.timeoutMs ?? 15_000);
    const server = toml.TRANSFER_SERVER_SEP0024 ? asUrl(toml.TRANSFER_SERVER_SEP0024) : null;
    if (!server) return err(SorokitErrorCode.INVALID_CONFIG, "Anchor has no valid TRANSFER_SERVER_SEP0024 in stellar.toml.");
    const direction = options.direction ?? "deposit";
    const endpoint = new URL(`transactions/${direction}/interactive`, `${server.toString().replace(/\/$/, "")}/`);
    const response = await authorizedFetch(anchorUrl, endpoint, {
      ...options,
      params: { asset_code: asset.code, ...(asset.issuer ? { asset_issuer: asset.issuer } : {}), ...options.params },
    }, "POST");
    const payload = await response.json() as { url?: string; id?: string; error?: string };
    if (typeof payload.url !== "string" || typeof payload.id !== "string") {
      return err(SorokitErrorCode.INVALID_CONFIG, payload.error ?? "SEP-24 response must include a URL and transaction ID.");
    }
    const interactiveUrl = asUrl(payload.url);
    if (!interactiveUrl) return err(SorokitErrorCode.INVALID_CONFIG, "Anchor returned a non-HTTPS interactive URL.");
    return ok({ url: interactiveUrl.toString(), id: payload.id });
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-24 interactive transfer failed.", cause);
  }
}

/** Query the status/details for a SEP-6 transaction. */
export async function getSep6TransactionStatus(
  anchorUrl: string,
  id: string,
  options: AnchorRequestOptions = {},
): Promise<SorokitResult<Record<string, unknown>>> {
  if (!id.trim()) return err(SorokitErrorCode.VALIDATION, "A transaction ID is required.");
  try {
    const toml = await loadToml(anchorUrl, options.timeoutMs ?? 15_000);
    const server = toml.TRANSFER_SERVER ? asUrl(toml.TRANSFER_SERVER) : null;
    if (!server) return err(SorokitErrorCode.INVALID_CONFIG, "Anchor has no valid TRANSFER_SERVER in stellar.toml.");
    const endpoint = new URL("transaction", `${server.toString().replace(/\/$/, "")}/`);
    const response = await authorizedFetch(anchorUrl, endpoint, { ...options, params: { id, ...options.params } }, "GET");
    return ok(await response.json() as Record<string, unknown>);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "SEP-6 transaction status lookup failed.", cause);
  }
}
