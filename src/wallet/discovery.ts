import { SorokitResult } from '../shared/errors.js';

export interface WalletInfo {
    id: string;
    name: string;
    installed: boolean;
    recommended: boolean;
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

        return { success: true, data: wallets };
    } catch (e: any) {
        return { success: false, error: e };
    }
}
