import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

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
        return ok({
            url: url.toString(),
            headers: config.headers || {},
        });
    } catch (cause) {
        return err(
            SorokitErrorCode.INVALID_CONFIG,
            cause instanceof Error ? cause.message : "Invalid endpoint URL",
            cause,
        );
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
