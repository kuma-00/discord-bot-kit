import {
    type ApiFailure,
    type ApiResult,
    ContractValidationError,
    type EventContract,
    type EventEnvelope,
    type HttpContract,
    parseEventEnvelope,
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
            const payload = await response.json().catch(() => undefined);
            if (!response.ok) {
                try {
                    const data = (await parseSchema(
                        contract.error,
                        payload,
                        `${contract.id}.error`,
                    )) as SchemaOutput<TErrorSchema>;
                    return {
                        ok: false,
                        error: {
                            code: "http-error",
                            message: `HTTP ${response.status}`,
                            details: data,
                        },
                    };
                } catch (cause) {
                    return failure(
                        "invalid-error-response",
                        "Server returned an invalid error payload",
                        {
                            kind: "invalid-response",
                            status: response.status,
                            cause,
                        },
                    );
                }
            }
            try {
                return {
                    ok: true,
                    data: (await parseSchema(
                        contract.output,
                        payload,
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
                        cause,
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

/** Raw event parsed from an SSE stream. */
export interface ServerSentEvent {
    readonly id?: string;
    readonly event?: string;
    readonly data: string;
    readonly retry?: number;
}

/** Incrementally parses arbitrary text chunks containing SSE frames. */
export async function* parseServerSentEvents(
    chunks: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of chunks) {
        buffer +=
            typeof chunk === "string"
                ? chunk
                : decoder.decode(chunk, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event: {
                id?: string;
                event?: string;
                data: string[];
                retry?: number;
            } = { data: [] };
            for (const line of frame.split("\n")) {
                if (!line || line.startsWith(":")) continue;
                const separator = line.indexOf(":");
                const field = separator < 0 ? line : line.slice(0, separator);
                const value =
                    separator < 0
                        ? ""
                        : line.slice(separator + 1).replace(/^ /, "");
                if (field === "data") event.data.push(value);
                if (field === "id") event.id = value;
                if (field === "event") event.event = value;
                if (field === "retry" && /^\d+$/.test(value)) {
                    event.retry = Number(value);
                }
            }
            if (event.data.length > 0) {
                yield {
                    data: event.data.join("\n"),
                    ...(event.id === undefined ? {} : { id: event.id }),
                    ...(event.event === undefined
                        ? {}
                        : { event: event.event }),
                    ...(event.retry === undefined
                        ? {}
                        : { retry: event.retry }),
                };
            }
            boundary = buffer.indexOf("\n\n");
        }
    }
}

async function* responseChunks(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) return;
            yield result.value;
        }
    } finally {
        reader.releaseLock();
    }
}

/** Configuration for a reconnecting SSE subscription. */
export interface SseSubscriptionOptions<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
> {
    readonly url: string;
    readonly contract: EventContract<TType, TVersion, TPayloadSchema>;
    readonly onEvent: (
        event: EventEnvelope<TType, SchemaOutput<TPayloadSchema>>,
    ) => void | Promise<void>;
    readonly onStateChange?: (
        state: "connecting" | "open" | "reconnecting" | "closed" | "error",
    ) => void;
    readonly fetch?: FetchLike;
    readonly headers?: Readonly<Record<string, string>>;
    readonly minRetryMs?: number;
    readonly maxRetryMs?: number;
}

/** Reconnecting, abortable SSE subscription with runtime payload validation. */
export class SseSubscription<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
> {
    private controller: AbortController | undefined;
    private task: Promise<void> | undefined;
    private lastEventId: string | undefined;

    constructor(
        private readonly options: SseSubscriptionOptions<
            TType,
            TVersion,
            TPayloadSchema
        >,
    ) {}

    /** Starts the subscription. Repeated calls reuse the active task. */
    start(): Promise<void> {
        if (this.task) return this.task;
        this.controller = new AbortController();
        this.task = this.run(this.controller.signal).finally(() => {
            this.task = undefined;
            this.controller = undefined;
        });
        return this.task;
    }

    /** Stops the current connection and prevents another reconnect. */
    stop(): void {
        this.controller?.abort();
    }

    private async run(signal: AbortSignal): Promise<void> {
        const fetchImplementation = this.options.fetch ?? globalThis.fetch;
        let retryMs = this.options.minRetryMs ?? 500;
        const maxRetryMs = this.options.maxRetryMs ?? 10_000;
        let connected = false;
        while (!signal.aborted) {
            this.options.onStateChange?.(
                connected ? "reconnecting" : "connecting",
            );
            try {
                const headers = new Headers({
                    accept: "text/event-stream",
                    ...this.options.headers,
                });
                if (this.lastEventId) {
                    headers.set("last-event-id", this.lastEventId);
                }
                const response = await fetchImplementation(this.options.url, {
                    headers,
                    signal,
                });
                if (!response.ok || !response.body) {
                    throw new Error(
                        `SSE connection failed: ${response.status}`,
                    );
                }
                connected = true;
                this.options.onStateChange?.("open");
                for await (const event of parseServerSentEvents(
                    responseChunks(response.body),
                )) {
                    if (signal.aborted) break;
                    if (event.id !== undefined) this.lastEventId = event.id;
                    if (event.retry !== undefined) retryMs = event.retry;
                    const parsed = JSON.parse(event.data) as unknown;
                    await this.options.onEvent(
                        await parseEventEnvelope(this.options.contract, parsed),
                    );
                }
            } catch (error) {
                if (signal.aborted) break;
                this.options.onStateChange?.("error");
                if (
                    error instanceof ContractValidationError ||
                    error instanceof SyntaxError
                ) {
                    // Invalid individual events do not permanently close the stream.
                }
            }
            if (!signal.aborted) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, retryMs);
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        { once: true },
                    );
                });
                retryMs = Math.min(retryMs * 2, maxRetryMs);
            }
        }
        this.options.onStateChange?.("closed");
    }
}
