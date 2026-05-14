/**
 * Re-exports the WalletAdapter contract from wallet/types.ts.
 * Adapters import from here for a stable, explicit path.
 */
export type {
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "../types";
