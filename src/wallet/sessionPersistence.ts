import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface WalletState {
    accountId: string;
    connectedAt: number;
    expiresAt: number;
    network: string;
}

const SESSION_KEY = 'sorokit_wallet_session';

export function saveWalletSession(state: WalletState): SorokitResult<void> {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(state));
        }
        return ok(undefined);
    } catch (cause) {
        return err(
            SorokitErrorCode.WALLET_CONNECT_FAILED,
            cause instanceof Error ? cause.message : "Unable to save wallet session",
            cause,
        );
    }
}

export function loadWalletSession(): SorokitResult<WalletState | null> {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(SESSION_KEY);
            if (!raw) return ok(null);
            const state = JSON.parse(raw) as WalletState;
            if (Date.now() > state.expiresAt) {
                clearWalletSession();
                return ok(null);
            }
            return ok(state);
        }
        return ok(null);
    } catch (cause) {
        return err(
            SorokitErrorCode.WALLET_CONNECT_FAILED,
            cause instanceof Error ? cause.message : "Unable to load wallet session",
            cause,
        );
    }
}

export function clearWalletSession(): SorokitResult<void> {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.removeItem(SESSION_KEY);
        }
        return ok(undefined);
    } catch (cause) {
        return err(
            SorokitErrorCode.WALLET_CONNECT_FAILED,
            cause instanceof Error ? cause.message : "Unable to clear wallet session",
            cause,
        );
    }
}
