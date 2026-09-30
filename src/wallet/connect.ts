import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, WalletState, WalletConnectOptions, WalletConnectionProgress } from "./types";
import { isUserRejection } from "../shared/errors";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;

function getAdapterDisplayName(walletType: string): string {
  const map: Record<string, string> = {
    FREIGHTER: "Freighter",
    XBULL: "xBull",
    LOBSTR: "Lobstr",
    HANA: "Hana",
    RABET: "Rabet",
    WALLETCONNECT: "WalletConnect",
    ALBEDO: "Albedo",
  };
  return map[walletType] ?? walletType;
}

function isNonRetryableError(code: string, message: string, cause?: unknown): boolean {
  if (code === SorokitErrorCode.WALLET_BROWSER_ONLY) return true;
  if (code === SorokitErrorCode.WALLET_SIGN_REJECTED) return true;
  if ((cause && isUserRejection(cause)) || (message && isUserRejection(message))) return true;
  if (message && (message.includes("Install") || message.includes("not installed") || message.includes("rejected"))) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect a wallet via its adapter and return the resolved `WalletState`.
 *
 * Supports connection progress updates, a default 30-second connection timeout,
 * and retries with exponential backoff for transient failures.
 *
 * @param adapter - The wallet adapter to connect through (e.g. `FreighterAdapter`).
 * @param cacheOrOptions - Optional SorokitCache instance or WalletConnectOptions configuration object.
 * @param options - WalletConnectOptions when second argument is cache.
 */
export async function connectWallet(
  adapter: WalletAdapter,
  cacheOrOptions?: SorokitCache | WalletConnectOptions,
  optionsArg?: WalletConnectOptions,
): Promise<SorokitResult<WalletState>> {
  let cache: SorokitCache | undefined;
  let options: WalletConnectOptions | undefined;

  if (cacheOrOptions && typeof (cacheOrOptions as any).get === "function") {
    cache = cacheOrOptions as SorokitCache;
    options = optionsArg;
  } else {
    options = cacheOrOptions as WalletConnectOptions | undefined;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const onProgress = options?.onProgress;

  const adapterName = getAdapterDisplayName(adapter.walletType);

  const notifyProgress = (
    state: WalletConnectionProgress["state"],
    attempt: number,
    isRetry: boolean,
    error?: string | null,
    isTimeout?: boolean,
    publicKey?: string | null,
  ) => {
    if (onProgress) {
      onProgress({
        state,
        walletType: adapter.walletType,
        adapterName,
        attempt,
        maxRetries,
        isRetry,
        ...(error !== undefined && { error }),
        ...(isTimeout !== undefined && { isTimeout }),
        ...(publicKey !== undefined && { publicKey }),
      });
    }
  };

  if (!adapter.isAvailable()) {
    const errorMsg = `Install the ${adapterName} extension and try again.`;
    notifyProgress("failed", 1, false, errorMsg, false);
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      errorMsg,
    );
  }

  let attempt = 0;
  let lastError: SorokitResult<WalletState> | null = null;

  while (attempt < maxRetries) {
    attempt++;
    const isRetry = attempt > 1;

    notifyProgress("connecting", attempt, isRetry);
    notifyProgress("authenticating", attempt, isRetry);

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const timeoutPromise = new Promise<SorokitResult<string>>((resolve) => {
      timerId = setTimeout(() => {
        timedOut = true;
        resolve(
          err(
            SorokitErrorCode.WALLET_CONNECT_FAILED,
            `The wallet connection timed out after ${Math.round(timeoutMs / 1000)} seconds. Make sure your wallet is open and try again.`,
          ),
        );
      }, timeoutMs);
    });

    try {
      const connectPromise = adapter.connect();
      const rawResult = await Promise.race([connectPromise, timeoutPromise]);

      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }

      if (rawResult.status === "error") {
        const errorMsg = rawResult.error.message;
        const isTimeout = timedOut || (errorMsg && errorMsg.includes("timed out"));
        lastError = rawResult as SorokitResult<WalletState>;

        if (isNonRetryableError(rawResult.error.code, errorMsg, rawResult.error.cause) || isTimeout) {
          notifyProgress("failed", attempt, isRetry, errorMsg, isTimeout);
          return rawResult as SorokitResult<WalletState>;
        }

        if (attempt >= maxRetries) {
          notifyProgress("failed", attempt, isRetry, errorMsg, false);
          return rawResult as SorokitResult<WalletState>;
        }

        // Delay for exponential backoff before next attempt
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }

      // Success path
      const publicKey = rawResult.data;
      if (!publicKey || typeof publicKey !== "string" || publicKey === "") {
        const emptyKeyMsg = `${adapterName} returned an empty public key. Make sure your wallet account is setup and try again.`;
        lastError = err(SorokitErrorCode.WALLET_CONNECT_FAILED, emptyKeyMsg);
        notifyProgress("failed", attempt, isRetry, emptyKeyMsg, false);
        return lastError;
      }

      const state: WalletState = {
        connected: true,
        publicKey,
        walletType: adapter.walletType,
      };

      if (cache) {
        cache.set("wallet:state", state);
      }

      notifyProgress("connected", attempt, isRetry, null, false, publicKey);
      return ok(state);
    } catch (cause) {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }

      const errorMsg = `${adapterName} connection failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      lastError = err(SorokitErrorCode.WALLET_CONNECT_FAILED, errorMsg, cause);

      if (attempt >= maxRetries) {
        notifyProgress("failed", attempt, isRetry, errorMsg, false);
        return lastError;
      }

      const delay = backoffMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  return (
    lastError ??
    err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      `Failed to connect to ${adapterName} after ${maxRetries} attempts.`,
    )
  );
}

