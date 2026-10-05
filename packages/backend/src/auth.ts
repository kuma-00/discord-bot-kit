import {
    type AccessFailure,
    accessFailureStatus,
    createAccessFailure,
} from "@kuma-00/bot-kit-contracts";

/** Options for API key authentication. */
export interface ApiKeyAuthOptions {
    readonly apiKey: string;
    readonly header?: string;
}

/** Checks an API key without exposing the configured value. */
export function authenticateApiKey(
    request: Request,
    options: ApiKeyAuthOptions,
): AccessFailure | undefined {
    const supplied = request.headers.get(options.header ?? "x-api-key");
    if (supplied === options.apiKey) return undefined;
    return createAccessFailure("unauthorized");
}

/** Serializes a standard access failure using its code-assigned HTTP status. */
export function accessFailureResponse(failure: AccessFailure): Response {
    const error = failure?.error;
    if (
        failure?.ok !== false ||
        typeof error !== "object" ||
        error === null ||
        error.kind !== "access" ||
        (error.code !== "unauthorized" && error.code !== "forbidden") ||
        typeof error.message !== "string" ||
        "details" in error
    ) {
        throw new TypeError("Invalid access failure");
    }
    return Response.json(failure, {
        status: accessFailureStatus(error.code),
    });
}
