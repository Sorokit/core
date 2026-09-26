import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletAdapter, WalletState } from "./types";
import { WalletType } from "./types";

export type WalletConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface WalletStatus {
  status: WalletConnectionStatus;
  walletType: WalletType | null;
  publicKey: string | null;
  adapterName: string | null;
  truncatedAddress: string | null;
  error: string | null;
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
      return "Connecting to wallet";
    case "disconnected":
      return "No wallet connected";
    case "error":
      return `Wallet error: ${status.error}`;
  }
}

export function getStatusColorClass(status: WalletConnectionStatus): string {
  switch (status) {
    case "connected":
      return "sorokit-status-ok";
    case "connecting":
      return "sorokit-status-pending";
    case "disconnected":
      return "sorokit-status-off";
    case "error":
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
    return this._status.status === "connecting";
  }

  get isDisconnected(): boolean {
    return this._status.status === "disconnected";
  }

  get hasError(): boolean {
    return this._status.status === "error";
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

  async connect(adapter: WalletAdapter): Promise<SorokitResult<WalletState>> {
    this._setStatus({
      status: "connecting",
      walletType: adapter.walletType,
      adapterName: getAdapterName(adapter.walletType),
      error: null,
    });

    const result = await adapter.connect();

    if (result.status === "error") {
      this._setStatus({
        status: "error",
        publicKey: null,
        truncatedAddress: null,
        error: result.error.message,
      });
      return result;
    }

    const publicKey = result.data;
    this._setStatus({
      status: "connected",
      publicKey,
      truncatedAddress: truncatePublicKey(publicKey),
      error: null,
    });

    return ok({
      connected: true,
      publicKey,
      walletType: adapter.walletType,
    });
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
