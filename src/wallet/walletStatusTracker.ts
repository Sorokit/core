import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletAdapter, WalletState } from "./types";
import { WalletType } from "./types";

import type { WalletConnectOptions, WalletConnectionProgress, WalletConnectionState } from "./types";
import { connectWallet } from "./connect";

export type WalletConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "failed"
  | "error";

export interface WalletStatus {
  status: WalletConnectionStatus;
  walletType: WalletType | null;
  publicKey: string | null;
  adapterName: string | null;
  truncatedAddress: string | null;
  error: string | null;
  attempt?: number;
  maxRetries?: number;
  isRetry?: boolean;
  isTimeout?: boolean;
}

export type WalletStatusListener = (status: WalletStatus) => void;

export type WalletStatusUnsubscribe = () => void;

export interface WalletStatusTrackerConfig {
  onStatusChange?: WalletStatusListener;
}

const ADAPTER_NAMES: Record<WalletType, string> = {
  [WalletType.FREIGHTER]: "Freighter",
  [WalletType.XBULL]: "xBull",
  [WalletType.LOBSTR]: "Lobstr",
  [WalletType.HANA]: "Hana",
  [WalletType.RABET]: "Rabet",
  [WalletType.WALLETCONNECT]: "WalletConnect",
  [WalletType.ALBEDO]: "Albedo",
};

export function getAdapterName(walletType: WalletType): string {
  return ADAPTER_NAMES[walletType] ?? walletType;
}

export function truncatePublicKey(publicKey: string, chars: number = 4): string {
  if (!publicKey || publicKey.length <= chars * 2 + 3) return publicKey;
  return `${publicKey.slice(0, chars)}...${publicKey.slice(-chars)}`;
}

export function getAriaLabel(status: WalletStatus): string {
  switch (status.status) {
    case "connected":
      return `Wallet connected: ${status.adapterName}, account ${status.truncatedAddress}`;
    case "connecting":
    case "authenticating":
      return "Connecting to wallet";
    case "disconnected":
      return "No wallet connected";
    case "error":
    case "failed":
      return `Wallet error: ${status.error}`;
  }
}

export function getStatusColorClass(status: WalletConnectionStatus): string {
  switch (status) {
    case "connected":
      return "sorokit-status-ok";
    case "connecting":
    case "authenticating":
      return "sorokit-status-pending";
    case "disconnected":
      return "sorokit-status-off";
    case "error":
    case "failed":
      return "sorokit-status-error";
  }
}

const INITIAL_STATUS: WalletStatus = {
  status: "disconnected",
  walletType: null,
  publicKey: null,
  adapterName: null,
  truncatedAddress: null,
  error: null,
};

export class WalletStatusTracker {
  private _status: WalletStatus = { ...INITIAL_STATUS };
  private _listeners: Set<WalletStatusListener> = new Set();

  constructor(config?: WalletStatusTrackerConfig) {
    if (config?.onStatusChange) {
      this._listeners.add(config.onStatusChange);
    }
  }

  get status(): WalletStatus {
    return { ...this._status };
  }

  get isConnected(): boolean {
    return this._status.status === "connected";
  }

  get isConnecting(): boolean {
    return this._status.status === "connecting" || this._status.status === "authenticating";
  }

  get isDisconnected(): boolean {
    return this._status.status === "disconnected";
  }

  get hasError(): boolean {
    return this._status.status === "error" || this._status.status === "failed";
  }

  subscribe(listener: WalletStatusListener): WalletStatusUnsubscribe {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _emit(): void {
    const status = this._status;
    for (const listener of this._listeners) {
      listener(status);
    }
  }

  private _setStatus(update: Partial<WalletStatus>): void {
    this._status = { ...this._status, ...update };
    this._emit();
  }

  async connect(
    adapter: WalletAdapter,
    options?: WalletConnectOptions,
  ): Promise<SorokitResult<WalletState>> {
    const combinedOptions: WalletConnectOptions = {
      ...options,
      onProgress: (progress: WalletConnectionProgress) => {
        const mappedStatus: WalletConnectionStatus =
          progress.state === "failed" ? "failed" : progress.state;

        this._setStatus({
          status: mappedStatus,
          walletType: progress.walletType,
          adapterName: progress.adapterName,
          attempt: progress.attempt,
          maxRetries: progress.maxRetries,
          isRetry: progress.isRetry,
          isTimeout: progress.isTimeout ?? false,
          error: progress.error ?? null,
          ...(progress.publicKey && {
            publicKey: progress.publicKey,
            truncatedAddress: truncatePublicKey(progress.publicKey),
          }),
        });

        if (options?.onProgress) {
          options.onProgress(progress);
        }
      },
    };

    const result = await connectWallet(adapter, combinedOptions);

    if (result.status === "error") {
      this._setStatus({
        status: "failed",
        publicKey: null,
        truncatedAddress: null,
        error: result.error.message,
      });
      return result;
    }

    const state = result.data;
    this._setStatus({
      publicKey: state.publicKey,
      truncatedAddress: state.publicKey ? truncatePublicKey(state.publicKey) : null,
      error: null,
    });

    return ok(state);
  }

  async disconnect(adapter: WalletAdapter): Promise<SorokitResult<void>> {
    this._setStatus({ status: "connecting" });
    const result = await adapter.disconnect();
    this._status = { ...INITIAL_STATUS };
    this._emit();
    return result;
  }

  setDisconnected(): void {
    this._status = { ...INITIAL_STATUS };
    this._emit();
  }

  setError(message: string): void {
    this._setStatus({
      status: "error",
      publicKey: null,
      truncatedAddress: null,
      error: message,
    });
  }

  restoreState(state: WalletState): void {
    if (state.connected && state.publicKey && state.walletType) {
      this._setStatus({
        status: "connected",
        walletType: state.walletType,
        publicKey: state.publicKey,
        adapterName: getAdapterName(state.walletType),
        truncatedAddress: truncatePublicKey(state.publicKey),
        error: null,
      });
    }
  }

  destroy(): void {
    this._listeners.clear();
    this._status = { ...INITIAL_STATUS };
  }
}
