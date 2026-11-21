import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, WalletState } from "./types";

const DISCONNECTED: WalletState = {
  connected: false,
  publicKey: null,
  walletType: null,
};

/**
 * Serializes ownership of a wallet adapter and invalidates stale operations.
 * A late connect result is never allowed to resurrect a disconnected session.
 */
export class WalletConnectionManager {
  private readonly adapter: WalletAdapter;
  private readonly cache: SorokitCache | undefined;
  private generation = 0;
  private current: WalletState = DISCONNECTED;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(adapter: WalletAdapter, cache?: SorokitCache) {
    this.adapter = adapter;
    this.cache = cache;
  }

  get state(): WalletState {
    return this.current;
  }

  async connect(): Promise<SorokitResult<WalletState>> {
    const generation = ++this.generation;
    this.current = { connected: false, publicKey: null, walletType: this.adapter.walletType };
    return this.enqueue(() => this.performConnect(generation));
  }

  async disconnect(): Promise<SorokitResult<WalletState>> {
    const generation = ++this.generation;
    this.current = DISCONNECTED;
    return this.enqueue(async () => {
      if (!this.adapter.isAvailable()) {
        return err(SorokitErrorCode.WALLET_BROWSER_ONLY, `${this.adapter.walletType} requires a browser environment.`);
      }
      const result = await this.adapter.disconnect();
      if (generation !== this.generation) return ok(this.current);
      if (result.status === "error") return result as SorokitResult<WalletState>;
      this.cache?.invalidate("wallet:state");
      return ok(DISCONNECTED);
    });
  }

  private enqueue<T>(operation: () => Promise<SorokitResult<T>>): Promise<SorokitResult<T>> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async performConnect(generation: number): Promise<SorokitResult<WalletState>> {
    if (!this.adapter.isAvailable()) {
      return err(SorokitErrorCode.WALLET_BROWSER_ONLY, `${this.adapter.walletType} requires a browser environment.`);
    }
    const result = await this.adapter.connect();
    if (generation !== this.generation) {
      if (result.status === "ok") await this.adapter.disconnect().catch(() => undefined);
      return err(SorokitErrorCode.WALLET_CONNECT_FAILED, "Wallet connection superseded by a newer lifecycle operation.");
    }
    if (result.status === "error") return result;
    const state: WalletState = { connected: true, publicKey: result.data, walletType: this.adapter.walletType };
    this.current = state;
    this.cache?.set("wallet:state", state);
    return ok(state);
  }
}
