export { connectWallet } from "./connect";
export { disconnectWallet } from "./disconnect";
export { signTransaction } from "./signTransaction";
export { FreighterAdapter } from "./adapters/freighter";
export { XBullAdapter } from "./adapters/xbull";
export { LobstrAdapter } from "./adapters/lobstr";
export type {
  WalletType,
  WalletState,
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "./types";
export { WalletType as WalletTypeEnum } from "./types";

import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletState } from "./types";

/**
 * Return a canonical disconnected WalletState wrapped in SorokitResult.
 * Use this to initialise wallet state in the UI layer.
 */
export function emptyWalletState(): SorokitResult<WalletState> {
  return ok({ connected: false, publicKey: null, walletType: null });
}
