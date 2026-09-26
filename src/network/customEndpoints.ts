import { SorokitResult } from '../shared/errors.js';

export interface EndpointConfig {
    url: string;
    headers?: Record<string, string>;
}

export interface NetworkConfig {
    horizon?: EndpointConfig;
    rpc?: EndpointConfig;
}

export function createCustomEndpoint(config: EndpointConfig): SorokitResult<EndpointConfig> {
    try {
        const url = new URL(config.url);
        return {
            success: true,
            data: {
                url: url.toString(),
                headers: config.headers || {},
            }
        };
    } catch (e: any) {
        return { success: false, error: e };
    }
}

export function applyHeadersToFetch(config: EndpointConfig, init?: RequestInit): RequestInit {
    const headers = new Headers(init?.headers);
    if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
            headers.set(key, value);
        }
    }
    return { ...init, headers };
}
