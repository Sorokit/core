import { SorokitResult } from '../shared/errors.js';

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
        return { success: true, data: undefined };
    } catch (e: any) {
        return { success: false, error: e };
    }
}

export function loadWalletSession(): SorokitResult<WalletState | null> {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(SESSION_KEY);
            if (!raw) return { success: true, data: null };
            const state = JSON.parse(raw) as WalletState;
            if (Date.now() > state.expiresAt) {
                clearWalletSession();
                return { success: true, data: null };
            }
            return { success: true, data: state };
        }
        return { success: true, data: null };
    } catch (e: any) {
        return { success: false, error: e };
    }
}

export function clearWalletSession(): SorokitResult<void> {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.removeItem(SESSION_KEY);
        }
        return { success: true, data: undefined };
    } catch (e: any) {
        return { success: false, error: e };
    }
}
