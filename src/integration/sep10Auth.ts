import { StrKey, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { fetchStellarToml } from "./sep1Toml";

export interface InitiateSep10AuthOptions {
  networkPassphrase?: string;
  homeDomain?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface AuthToken {
  token: string;
  expiresAt: number;
  claims: Record<string, unknown>;
}

interface ChallengeContext {
  endpoint: URL;
  publicKey: string;
  signingKey: string;
  networkPassphrase: string;
  homeDomain: string;
  fetcher: typeof fetch;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 128;
const pendingChallenges = new Map<string, ChallengeContext>();

function tomlString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) return null;
  try {
    const encoded = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? claims as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Validate the JWT structure and expiration. Signature verification is server-side. */
export function validateSep10Token(
  token: string,
  now: number = Date.now(),
): SorokitResult<AuthToken> {
  if (typeof token !== "string" || !token.trim()) {
    return err(SorokitErrorCode.INVALID_AUTH, "A SEP-10 token is required.");
  }
  const claims = decodeJwtClaims(token);
  const expiration = claims?.exp;
  if (!claims || typeof expiration !== "number" || !Number.isFinite(expiration)) {
    return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 token must be a JWT with a numeric exp claim.");
  }
  const expiresAt = expiration * 1000;
  if (expiresAt <= now) {
    return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 token has expired.");
  }
  return ok({ token, expiresAt, claims });
}

/** Request a SEP-10 challenge transaction for a Stellar public key. */
export async function initiateSep10Auth(
  serverUrl: string,
  publicKey: string,
  options: InitiateSep10AuthOptions = {},
): Promise<SorokitResult<string>> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "A valid Stellar public key is required.");
  }

  let homeDomain: string;
  try {
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(serverUrl)
      ? new URL(serverUrl)
      : new URL(`https://${serverUrl}`);
    if (normalized.protocol !== "https:" || normalized.pathname !== "/" || normalized.search || normalized.hash) {
      return err(SorokitErrorCode.INVALID_CONFIG, "SEP-10 server URL must be an HTTPS domain.");
    }
    homeDomain = options.homeDomain ?? normalized.hostname;
  } catch {
    return err(SorokitErrorCode.INVALID_CONFIG, "SEP-10 server URL must be a valid HTTPS domain.");
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (typeof fetcher !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return err(SorokitErrorCode.VALIDATION, "A fetch implementation and positive timeout are required.");
  }

  const tomlResult = await fetchStellarToml(homeDomain, { fetch: fetcher, timeoutMs });
  if (tomlResult.status === "error") return tomlResult;

  const endpointValue = tomlString(tomlResult.data.WEB_AUTH_ENDPOINT);
  const signingKey = tomlString(tomlResult.data.SIGNING_KEY);
  const networkPassphrase = options.networkPassphrase ?? tomlString(tomlResult.data.NETWORK_PASSPHRASE);
  if (!endpointValue || !signingKey || !networkPassphrase) {
    return err(SorokitErrorCode.INVALID_CONFIG, "stellar.toml must define WEB_AUTH_ENDPOINT, SIGNING_KEY, and NETWORK_PASSPHRASE.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
    if (endpoint.protocol !== "https:" || !StrKey.isValidEd25519PublicKey(signingKey)) {
      return err(SorokitErrorCode.INVALID_CONFIG, "SEP-10 endpoint and signing key must be valid HTTPS and Stellar values.");
    }
  } catch {
    return err(SorokitErrorCode.INVALID_CONFIG, "stellar.toml contains an invalid WEB_AUTH_ENDPOINT.");
  }

  const challengeUrl = new URL(endpoint);
  challengeUrl.searchParams.set("account", publicKey);
  challengeUrl.searchParams.set("home_domain", homeDomain);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(challengeUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.json() as { transaction?: unknown; error?: unknown };
    if (!response.ok || typeof body.transaction !== "string") {
      return err(SorokitErrorCode.INVALID_AUTH, typeof body.error === "string" ? body.error : `SEP-10 challenge request failed (${response.status}).`);
    }

    try {
      const challenge = WebAuth.readChallengeTx(
        body.transaction,
        signingKey,
        networkPassphrase,
        homeDomain,
        endpoint.hostname,
      );
      if (challenge.clientAccountID !== publicKey || !WebAuth.verifyTxSignedBy(challenge.tx, signingKey)) {
        return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 challenge account or server signature is invalid.");
      }
    } catch (cause) {
      return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 challenge transaction is invalid.", cause);
    }

    const now = Date.now();
    for (const [key, context] of pendingChallenges) {
      if (context.expiresAt <= now) pendingChallenges.delete(key);
    }
    if (pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = pendingChallenges.keys().next().value as string | undefined;
      if (oldest) pendingChallenges.delete(oldest);
    }
    pendingChallenges.set(body.transaction, {
      endpoint,
      publicKey,
      signingKey,
      networkPassphrase,
      homeDomain,
      fetcher,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
    return ok(body.transaction);
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "Failed to request SEP-10 challenge.", cause);
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the wallet-signed challenge, exchange it for a JWT, and check expiry. */
export async function completeSep10Auth(
  challengeXdr: string,
  signedChallengeXdr: string,
  options: { now?: number; timeoutMs?: number } = {},
): Promise<SorokitResult<AuthToken>> {
  const context = pendingChallenges.get(challengeXdr);
  if (!context) return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 challenge is unknown or has already been used.");
  pendingChallenges.delete(challengeXdr);
  if (context.expiresAt <= Date.now()) {
    return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 challenge has expired.");
  }

  try {
    const signed = TransactionBuilder.fromXDR(signedChallengeXdr, context.networkPassphrase) as Transaction;
    const original = WebAuth.readChallengeTx(
      challengeXdr,
      context.signingKey,
      context.networkPassphrase,
      context.homeDomain,
      context.endpoint.hostname,
    );
    if (
      !signed.hash().equals(original.tx.hash()) ||
      !WebAuth.verifyTxSignedBy(signed, context.publicKey) ||
      !WebAuth.verifyTxSignedBy(signed, context.signingKey)
    ) {
      return err(SorokitErrorCode.INVALID_AUTH, "Wallet signature does not match the verified SEP-10 challenge.");
    }

    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return err(SorokitErrorCode.VALIDATION, "Request timeout must be a positive finite number.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await context.fetcher(context.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ transaction: signedChallengeXdr }),
        signal: controller.signal,
      });
      const body = await response.json() as { token?: unknown; error?: unknown };
      if (!response.ok || typeof body.token !== "string") {
        return err(SorokitErrorCode.INVALID_AUTH, typeof body.error === "string" ? body.error : `SEP-10 token request failed (${response.status}).`);
      }
      return validateSep10Token(body.token, options.now);
    } finally {
      clearTimeout(timer);
    }
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "Failed to complete SEP-10 authentication.", cause);
  }
}