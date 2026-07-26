import type { ApiFailure } from "@kuma-00/bot-kit-contracts";

/** Options for API key authentication. */
export interface ApiKeyAuthOptions {
    readonly apiKey: string;
    readonly header?: string;
}

/** Checks an API key without exposing the configured value. */
export function authenticateApiKey(
    request: Request,
    options: ApiKeyAuthOptions,
): ApiFailure | undefined {
    const supplied = request.headers.get(options.header ?? "x-api-key");
    if (supplied === options.apiKey) return undefined;
    return {
        ok: false,
        error: {
            code: "unauthorized",
            message: "Unauthorized",
        },
    };
}
