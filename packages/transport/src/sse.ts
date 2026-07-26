import {
    type AnyEventContract,
    type EventContract,
    type EventEnvelope,
    type EventEnvelopeFor,
    type EventRegistry,
    parseEventEnvelope,
    type SchemaOutput,
    type StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";
import type { FetchLike } from "./http.ts";

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
    TContracts extends readonly AnyEventContract[] = readonly [],
> {
    readonly url: string;
    readonly contract?: EventContract<TType, TVersion, TPayloadSchema>;
    readonly contracts?: EventRegistry<TContracts>;
    readonly onEvent: (
        event: TContracts extends readonly []
            ? EventEnvelope<TType, SchemaOutput<TPayloadSchema>>
            : EventEnvelopeFor<TContracts[number]>,
    ) => void | Promise<void>;
    /** Receives a malformed or rejected individual event without reconnecting. */
    readonly onEventError?: (
        error: unknown,
        event: ServerSentEvent,
    ) => void | Promise<void>;
    readonly onStateChange?: (
        state: "connecting" | "open" | "reconnecting" | "closed" | "error",
    ) => void;
    readonly fetch?: FetchLike;
    readonly headers?: Readonly<Record<string, string>>;
    readonly minRetryMs?: number;
    readonly maxRetryMs?: number;
    /** Random source used for full-jitter reconnect delays. */
    readonly random?: () => number;
    /** Injectable reconnect wait, primarily for deterministic scheduling tests. */
    readonly waitForRetry?: (
        delayMs: number,
        signal: AbortSignal,
    ) => Promise<void>;
}

/** Reconnecting, abortable SSE subscription with runtime payload validation. */
export class SseSubscription<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
    TContracts extends readonly AnyEventContract[] = readonly [],
> {
    private controller: AbortController | undefined;
    private task: Promise<void> | undefined;
    private lastEventId: string | undefined;

    constructor(
        private readonly options: SseSubscriptionOptions<
            TType,
            TVersion,
            TPayloadSchema,
            TContracts
        >,
    ) {
        if (
            (options.contract === undefined) ===
            (options.contracts === undefined)
        ) {
            throw new TypeError(
                "SseSubscription requires exactly one of contract or contracts",
            );
        }
    }

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
        const minRetryMs = this.options.minRetryMs ?? 500;
        let retryMs = minRetryMs;
        const maxRetryMs = this.options.maxRetryMs ?? 10_000;
        const random = this.options.random ?? Math.random;
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
                retryMs = minRetryMs;
                this.options.onStateChange?.("open");
                for await (const event of parseServerSentEvents(
                    responseChunks(response.body),
                )) {
                    if (signal.aborted) break;
                    if (event.id !== undefined) this.lastEventId = event.id;
                    if (event.retry !== undefined) retryMs = event.retry;
                    try {
                        const raw = JSON.parse(event.data) as unknown;
                        const parsed = this.options.contracts
                            ? await this.options.contracts.parse(raw)
                            : await parseEventEnvelope(
                                  this.options.contract as EventContract<
                                      TType,
                                      TVersion,
                                      TPayloadSchema
                                  >,
                                  raw,
                              );
                        await this.options.onEvent(
                            parsed as TContracts extends readonly []
                                ? EventEnvelope<
                                      TType,
                                      SchemaOutput<TPayloadSchema>
                                  >
                                : EventEnvelopeFor<TContracts[number]>,
                        );
                    } catch (error) {
                        await this.options.onEventError?.(error, event);
                    }
                }
            } catch {
                if (signal.aborted) break;
                this.options.onStateChange?.("error");
            }
            if (!signal.aborted) {
                const delayMs = random() * retryMs;
                await (this.options.waitForRetry
                    ? this.options.waitForRetry(delayMs, signal)
                    : new Promise<void>((resolve) => {
                          const timer = setTimeout(resolve, delayMs);
                          signal.addEventListener(
                              "abort",
                              () => {
                                  clearTimeout(timer);
                                  resolve();
                              },
                              { once: true },
                          );
                      }));
                retryMs = Math.min(retryMs * 2, maxRetryMs);
            }
        }
        this.options.onStateChange?.("closed");
    }
}
