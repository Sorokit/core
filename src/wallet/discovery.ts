import { StrKey } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { resolveFederatedAddress } from "../integration/federationResolver";

export interface WalletInfo {
    id: string;
    name: string;
    installed: boolean;
    recommended: boolean;
}

export interface LinkedAccount {
    domain: string;
    account: string;
    username?: string;
    memo?: string;
    memoType?: "id" | "text" | "hash" | "return";
}

export interface DiscoveryData {
    address: string;
    domain: string;
    username: string;
    stellarAddress: string;
    memo?: string;
    memoType?: "id" | "text" | "hash" | "return";
}

export interface WalletDiscoveryOptions {
    /** Abort network requests after this interval. Defaults to 10 seconds. */
    timeoutMs?: number;
    /** Set true only for local development federation servers. */
    allowHttp?: boolean;
}

export type DiscoverWalletOptions = WalletDiscoveryOptions;
export interface ListLinkedAccountsOptions {}
export type LinkWalletOptions = WalletDiscoveryOptions;

const linkedAccounts = new Map<string, LinkedAccount[]>();

function normalizeDomain(domain: string): string | null {
    const trimmed = domain.trim().toLowerCase();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("@")) return null;
    return trimmed;
}

export async function discoverAvailableWallets(): Promise<SorokitResult<WalletInfo[]>> {
    try {
        const isBrowser = typeof window !== 'undefined';
        const wallets: WalletInfo[] = [
            {
                id: 'freighter',
                name: 'Freighter',
                installed: isBrowser && 'freighter' in (window as any),
                recommended: true,
            },
            {
                id: 'xbull',
                name: 'xBull',
                installed: isBrowser && 'xbull' in (window as any),
                recommended: false,
            },
            {
                id: 'lobstr',
                name: 'Lobstr',
                installed: isBrowser && 'lobstr' in (window as any),
                recommended: false,
            }
        ];
        
        wallets.sort((a, b) => {
            if (a.installed && !b.installed) return -1;
            if (!a.installed && b.installed) return 1;
            if (a.recommended && !b.recommended) return -1;
            if (!a.recommended && b.recommended) return 1;
            return 0;
        });

        return ok(wallets);
    } catch (cause) {
        return err(
            SorokitErrorCode.WALLET_NOT_FOUND,
            cause instanceof Error ? cause.message : "Unable to discover wallets",
            cause,
        );
    }
}

/** Resolve a wallet address for a federated identity (username@domain). */
export async function discoverWallet(
    domain: string,
    username: string,
    options: WalletDiscoveryOptions = {},
): Promise<SorokitResult<DiscoveryData>> {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
        return err(SorokitErrorCode.INVALID_ADDRESS, "Expected a valid federation domain.");
    }
    const normalizedUsername = username.trim();
    if (!normalizedUsername || normalizedUsername.includes("@") || normalizedUsername.includes("*")) {
        return err(SorokitErrorCode.INVALID_ADDRESS, "Expected a valid federation username.");
    }

    const resolverOptions = {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.allowHttp !== undefined ? { allowHttp: options.allowHttp } : {}),
    };
    const resolved = await resolveFederatedAddress(`${normalizedUsername}*${normalizedDomain}`, resolverOptions);
    if (resolved.status === "error") return resolved;

    const data: DiscoveryData = {
        address: resolved.data.publicKey,
        domain: normalizedDomain,
        username: normalizedUsername,
        stellarAddress: resolved.data.stellarAddress,
        ...(resolved.data.memo !== undefined ? { memo: resolved.data.memo } : {}),
        ...(resolved.data.memoType !== undefined ? { memoType: resolved.data.memoType } : {}),
    };
    return ok(data);
}

/** List all accounts linked to a Stellar public key. */
export function listLinkedAccounts(publicKey: string, _options?: ListLinkedAccountsOptions): SorokitResult<LinkedAccount[]> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
        return err(SorokitErrorCode.INVALID_ADDRESS, "Expected a valid Stellar public key.");
    }
    const accounts = linkedAccounts.get(publicKey) ?? [];
    return ok(accounts.map((account) => ({ ...account })));
}

/** Establish a link between a Stellar public key and a federated domain. */
export async function linkWallet(
    publicKey: string,
    domain: string,
    options: WalletDiscoveryOptions = {},
): Promise<SorokitResult<LinkedAccount>> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
        return err(SorokitErrorCode.INVALID_ADDRESS, "Expected a valid Stellar public key.");
    }
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
        return err(SorokitErrorCode.INVALID_ADDRESS, "Expected a valid federation domain.");
    }

    const existing = linkedAccounts.get(publicKey) ?? [];
    const alreadyLinked = existing.find((account) => account.domain === normalizedDomain && account.account === publicKey);
    if (alreadyLinked) return ok({ ...alreadyLinked });

    const linked: LinkedAccount = {
        domain: normalizedDomain,
        account: publicKey,
    };
    existing.push(linked);
    linkedAccounts.set(publicKey, existing);
    return ok({ ...linked });
}

/** Clear stored account links, primarily for tests and long-running apps. */
export function clearLinkedAccounts(): void {
    linkedAccounts.clear();
}

/** Remove a linked federation account for a Stellar public key. */
export function unlinkWallet(publicKey: string, domain?: string): SorokitResult<LinkedAccount[]> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
        return err(SorokitErrorCode.INVALID_ADDRESS, "Expected a valid Stellar public key.");
    }
    const existing = linkedAccounts.get(publicKey) ?? [];
    const remaining = domain === undefined
        ? []
        : existing.filter((account) => account.domain !== domain.trim().toLowerCase());
    if (remaining.length > 0) linkedAccounts.set(publicKey, remaining);
    else linkedAccounts.delete(publicKey);
    return ok(remaining.map((account) => ({ ...account })));
}
