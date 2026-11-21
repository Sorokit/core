import { StrKey, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import type { Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
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

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_CHALLENGES = 128;
const pendingChallenges = new Map<string, ChallengeContext>();
let evictionTimer: ReturnType<typeof setTimeout> | null = null;

function stopEvictionTimer(): void {
  if (evictionTimer !== null) {
    clearTimeout(evictionTimer);
    evictionTimer = null;
  }
}

function scheduleEvictionTimer(now: number = Date.now()): void {
  stopEvictionTimer();
  if (pendingChallenges.size === 0) return;

  const oldest = pendingChallenges.values().next().value as ChallengeContext | undefined;
  if (!oldest) return;

  const delay = Math.max(0, oldest.expiresAt - now);
  evictionTimer = setTimeout(() => {
    evictionTimer = null;
    pruneExpiredChallenges(Date.now());
  }, delay);

  if (typeof evictionTimer.unref === "function") {
    evictionTimer.unref();
  }
}

/**
 * Proactively prune expired challenges from the pending map.
 * Because challenges are inserted chronologically with uniform TTL, the iteration order
 * matches chronological expiration order. The search exits early at O(K) on the first unexpired entry.
 *
 * @param now Timestamp in ms (defaults to Date.now()).
 * @returns Count of expired challenges evicted.
 */
export function pruneExpiredChallenges(now: number = Date.now()): number {
  let pruned = 0;
  for (const [key, context] of pendingChallenges) {
    if (context.expiresAt <= now) {
      pendingChallenges.delete(key);
      pruned++;
    } else {
      break;
    }
  }

  if (pendingChallenges.size === 0) {
    stopEvictionTimer();
  } else {
    scheduleEvictionTimer(now);
  }

  return pruned;
}

/**
 * Return current number of pending challenges in memory (for testing and observability).
 */
export function getPendingChallengesCount(): number {
  return pendingChallenges.size;
}

/**
 * Clear all pending challenges and stop any background eviction timer.
 */
export function clearPendingChallenges(): void {
  stopEvictionTimer();
  pendingChallenges.clear();
}

function tomlString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) return null;
  try {
    const encoded = segments[1]!.replace(/-/g, "+").replace(/_/g, "/");
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

  const stellarToml = tomlResult.data;
  const endpointValue = tomlString(stellarToml.WEB_AUTH_ENDPOINT);
  const signingKey = tomlString(stellarToml.SIGNING_KEY);
  const networkPassphrase = options.networkPassphrase ?? tomlString(stellarToml.NETWORK_PASSPHRASE);
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
    pruneExpiredChallenges(now);
    // Map.set preserves an existing key's insertion position. Delete first so
    // refreshing the same XDR keeps Map order aligned with its new expiresAt.
    pendingChallenges.delete(body.transaction);
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
    scheduleEvictionTimer(now);
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

  const now = options.now ?? Date.now();
  if (context.expiresAt <= now) {
    pruneExpiredChallenges(now);
    return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 challenge has expired.");
  }

  pruneExpiredChallenges(now);

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

/** Normalize a domain to the hostname used as `home_domain` in SEP-10. */
function normalizeSep10Domain(domain: string): string | null {
  if (typeof domain !== "string" || !domain.trim()) return null;
  try {
    const value = domain.trim();
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? new URL(value)
      : new URL(`https://${value}`);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Step 1 of the SEP-10 flow: fetch and validate a challenge transaction for a
 * Stellar account. The wallet signs the returned XDR before submitting it.
 */
export function getAuthChallenge(
  domain: string,
  publicKey: string,
  options: InitiateSep10AuthOptions = {},
): Promise<SorokitResult<string>> {
  return initiateSep10Auth(domain, publicKey, options);
}

/**
 * Steps 3 and 4 of the SEP-10 flow: locate the challenge that produced a
 * wallet-signed transaction, verify its signatures, and exchange it for a
 * token. The challenge is matched by transaction hash so callers only need to
 * keep the signed XDR returned by their wallet.
 */
export async function submitSignedChallenge(
  domain: string,
  signedXdr: string,
  options: { now?: number; timeoutMs?: number } = {},
): Promise<SorokitResult<AuthToken>> {
  const expectedDomain = normalizeSep10Domain(domain);
  if (!expectedDomain) {
    return err(SorokitErrorCode.INVALID_CONFIG, "SEP-10 domain must be a valid HTTPS domain.");
  }
  if (typeof signedXdr !== "string" || !signedXdr.trim()) {
    return err(SorokitErrorCode.INVALID_AUTH, "A signed challenge XDR is required.");
  }

  let matchingChallenge: string | undefined;
  for (const [challengeXdr, context] of pendingChallenges) {
    if (context.homeDomain.toLowerCase() !== expectedDomain) continue;
    try {
      const challenge = TransactionBuilder.fromXDR(
        challengeXdr,
        context.networkPassphrase,
      ) as Transaction | FeeBumpTransaction;
      const signed = TransactionBuilder.fromXDR(
        signedXdr,
        context.networkPassphrase,
      ) as Transaction | FeeBumpTransaction;
      if (challenge.hash().equals(signed.hash())) {
        matchingChallenge = challengeXdr;
        break;
      }
    } catch {
      // An unrelated passphrase or malformed XDR cannot match this challenge.
    }
  }

  if (!matchingChallenge) {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      "No matching SEP-10 challenge found for this domain and signed transaction.",
    );
  }
  return completeSep10Auth(matchingChallenge, signedXdr, options);
}

/**
 * Verify a SEP-10 JWT returned by an auth server. Signature verification is
 * performed by the server consuming the token, so this checks the structure,
 * required claims, expiry and SEP-10 subject format.
 */
export function verifyAuthToken(
  token: string,
  options: { now?: number } = {},
): SorokitResult<AuthToken> {
  const result = validateSep10Token(token, options.now);
  if (result.status === "error") return result;

  const subject = result.data.claims.sub;
  if (typeof subject !== "string" || !StrKey.isValidEd25519PublicKey(subject)) {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      "SEP-10 token must contain a valid Ed25519 public key in the sub claim.",
    );
  }
  const issuedAt = result.data.claims.iat;
  if (issuedAt !== undefined && (typeof issuedAt !== "number" || !Number.isFinite(issuedAt))) {
    return err(SorokitErrorCode.INVALID_AUTH, "SEP-10 token has an invalid iat claim.");
  }
  return result;
}
