import {
    type ApiFailure,
    type ApiResult,
    type HttpContract,
    parseSchema,
    type SchemaOutput,
    type StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";

/** Injectable subset of Fetch used by transport clients. */
export type FetchLike = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

/** Structured input understood by the default HTTP serializer. */
export interface HttpRequestInput {
    readonly params?: Readonly<Record<string, string | number>>;
    readonly query?: Readonly<
        Record<string, string | number | boolean | null | undefined>
    >;
    readonly body?: unknown;
}

/** Configuration shared by all requests from an HTTP client. */
export interface HttpClientOptions {
    readonly baseUrl: string;
    readonly fetch?: FetchLike;
    readonly headers?:
        | Readonly<Record<string, string>>
        | (() => Readonly<Record<string, string>>);
    readonly apiKey?: string;
    readonly apiKeyHeader?: string;
    readonly timeoutMs?: number;
}

/** Failure returned when a request cannot produce a valid contract result. */
export interface TransportFailureDetails {
    readonly kind:
        | "network"
        | "timeout"
        | "aborted"
        | "invalid-response"
        | "http";
    readonly status?: number;
    readonly cause?: unknown;
}

/** Per-request options. */
export interface RequestOptions {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
}

function failure(
    code: string,
    message: string,
    details: TransportFailureDetails,
): ApiFailure<TransportFailureDetails> {
    return { ok: false, error: { code, message, details } };
}

function buildPath(path: string, input: HttpRequestInput): string {
    let resolved = path;
    for (const [key, value] of Object.entries(input.params ?? {})) {
        resolved = resolved.replaceAll(
            `:${key}`,
            encodeURIComponent(String(value)),
        );
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined && value !== null) {
            query.set(key, String(value));
        }
    }
    const suffix = query.toString();
    return suffix ? `${resolved}?${suffix}` : resolved;
}

/** Typed Fetch client driven by runtime route contracts. */
export class HttpClient {
    private readonly fetchImplementation: FetchLike;

    constructor(private readonly options: HttpClientOptions) {
        this.fetchImplementation = options.fetch ?? globalThis.fetch;
    }

    /** Executes a contract request and validates success and error payloads. */
    async request<
        TInputSchema extends StandardSchemaV1,
        TOutputSchema extends StandardSchemaV1,
        TErrorSchema extends StandardSchemaV1,
    >(
        contract: HttpContract<TInputSchema, TOutputSchema, TErrorSchema>,
        input: SchemaOutput<TInputSchema>,
        requestOptions: RequestOptions = {},
    ): Promise<
        ApiResult<
            SchemaOutput<TOutputSchema>,
            SchemaOutput<TErrorSchema> | TransportFailureDetails
        >
    > {
        let parsedInput: SchemaOutput<TInputSchema>;
        try {
            parsedInput = (await parseSchema(
                contract.input,
                input,
                `${contract.id}.input`,
            )) as SchemaOutput<TInputSchema>;
        } catch (cause) {
            return failure("invalid-input", "Request input is invalid", {
                kind: "invalid-response",
                cause,
            });
        }
        const serialized = parsedInput as HttpRequestInput;
        const controller = new AbortController();
        const timeoutMs = this.options.timeoutMs ?? 10_000;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const abort = () => controller.abort(requestOptions.signal?.reason);
        requestOptions.signal?.addEventListener("abort", abort, { once: true });

        try {
            const baseHeaders =
                typeof this.options.headers === "function"
                    ? this.options.headers()
                    : (this.options.headers ?? {});
            const headers = new Headers({
                accept: "application/json",
                ...baseHeaders,
                ...requestOptions.headers,
            });
            if (serialized.body !== undefined) {
                headers.set("content-type", "application/json");
            }
            if (this.options.apiKey) {
                headers.set(
                    this.options.apiKeyHeader ?? "x-api-key",
                    this.options.apiKey,
                );
            }
            const response = await this.fetchImplementation(
                new URL(
                    buildPath(contract.path, serialized),
                    this.options.baseUrl,
                ),
                {
                    method: contract.method,
                    headers,
                    signal: controller.signal,
                    ...(serialized.body === undefined
                        ? {}
                        : { body: JSON.stringify(serialized.body) }),
                },
            );
            let payload: unknown;
            let jsonCause: unknown;
            try {
                payload = await response.json();
            } catch (cause) {
                jsonCause = cause;
            }
            if (!response.ok) {
                try {
                    if (
                        typeof payload !== "object" ||
                        payload === null ||
                        (payload as { ok?: unknown }).ok !== false
                    ) {
                        throw new Error("Invalid API failure envelope");
                    }
                    const envelopeError = (payload as { error?: unknown })
                        .error;
                    if (
                        typeof envelopeError !== "object" ||
                        envelopeError === null ||
                        typeof (envelopeError as { code?: unknown }).code !==
                            "string" ||
                        typeof (envelopeError as { message?: unknown })
                            .message !== "string"
                    ) {
                        throw new Error("Invalid API failure envelope");
                    }
                    const details = (await parseSchema(
                        contract.error,
                        (envelopeError as { details?: unknown }).details,
                        `${contract.id}.error`,
                    )) as SchemaOutput<TErrorSchema>;
                    return {
                        ok: false,
                        error: {
                            code: (envelopeError as { code: string }).code,
                            message: (envelopeError as { message: string })
                                .message,
                            details,
                        },
                    };
                } catch (cause) {
                    return failure(
                        "invalid-error-response",
                        "Server returned an invalid error payload",
                        {
                            kind: "invalid-response",
                            status: response.status,
                            cause: jsonCause ?? cause,
                        },
                    );
                }
            }
            try {
                if (
                    typeof payload !== "object" ||
                    payload === null ||
                    (payload as { ok?: unknown }).ok !== true ||
                    !("data" in payload)
                ) {
                    throw new Error("Invalid API success envelope");
                }
                return {
                    ok: true,
                    data: (await parseSchema(
                        contract.output,
                        (payload as { data: unknown }).data,
                        `${contract.id}.output`,
                    )) as SchemaOutput<TOutputSchema>,
                };
            } catch (cause) {
                return failure(
                    "invalid-response",
                    "Server returned an invalid response payload",
                    {
                        kind: "invalid-response",
                        status: response.status,
                        cause: jsonCause ?? cause,
                    },
                );
            }
        } catch (cause) {
            if (timedOut) {
                return failure("timeout", "Request timed out", {
                    kind: "timeout",
                    cause,
                });
            }
            if (controller.signal.aborted) {
                return failure("aborted", "Request was aborted", {
                    kind: "aborted",
                    cause,
                });
            }
            return failure("network-error", "Network request failed", {
                kind: "network",
                cause,
            });
        } finally {
            clearTimeout(timeout);
            requestOptions.signal?.removeEventListener("abort", abort);
        }
    }
}
