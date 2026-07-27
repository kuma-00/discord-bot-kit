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
import { createParser } from "eventsource-parser";
import type { FetchLike } from "./http.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ABORTED = Symbol("aborted");

interface SseStreamControls {
    readonly onId?: (id: string) => void;
    readonly onRetry?: (retryMs: number) => void;
}

/** Raw event parsed from an SSE stream. */
export interface ServerSentEvent {
    readonly id?: string;
    readonly event?: string;
    readonly data: string;
    readonly retry?: number;
}

async function* parseServerSentEventStream(
    chunks: AsyncIterable<string | Uint8Array>,
    controls?: SseStreamControls,
): AsyncGenerator<ServerSentEvent> {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const pending: ServerSentEvent[] = [];
    let atStreamStart = true;
    let lineBuffer = "";
    let frameRetryMs: number | undefined;
    let pendingFrameId: string | undefined;
    const parser = createParser({
        onEvent: (event) => {
            pending.push({
                data: event.data,
                ...(event.id === undefined ? {} : { id: event.id }),
                ...(event.event === undefined ? {} : { event: event.event }),
                ...(frameRetryMs === undefined ? {} : { retry: frameRetryMs }),
            });
        },
        onRetry: (retryMs) => {
            if (
                Number.isSafeInteger(retryMs) &&
                retryMs <= MAX_TIMER_DELAY_MS
            ) {
                frameRetryMs = retryMs;
                controls?.onRetry?.(retryMs);
            }
        },
    });
    const normalizeStreamStart = (text: string): string => {
        if (text.length === 0) return text;
        if (atStreamStart) {
            atStreamStart = false;
            return text.startsWith("\uFEFF") ? text.slice(1) : text;
        }
        return text;
    };
    const takeCompleteLines = (text: string): string[] => {
        lineBuffer += normalizeStreamStart(text);
        const lines: string[] = [];
        let start = 0;
        for (let index = 0; index < lineBuffer.length; index++) {
            const character = lineBuffer[index];
            if (character !== "\n" && character !== "\r") continue;
            if (character === "\r" && index === lineBuffer.length - 1) break;
            const terminatorLength =
                character === "\r" && lineBuffer[index + 1] === "\n" ? 2 : 1;
            lines.push(lineBuffer.slice(start, index + terminatorLength));
            index += terminatorLength - 1;
            start = index + 1;
        }
        lineBuffer = lineBuffer.slice(start);
        return lines;
    };
    const processProtocolLine = (lineWithTerminator: string) => {
        const line = lineWithTerminator.replace(/\r?\n$|\r$/, "");
        if (line === "") {
            if (pendingFrameId !== undefined) {
                controls?.onId?.(pendingFrameId);
                pendingFrameId = undefined;
            }
            return;
        }
        if (line.startsWith(":")) return;
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value =
            separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "id" && !value.includes("\0")) {
            pendingFrameId = value;
        }
    };
    const feedLine = (line: string) => {
        processProtocolLine(line);
        parser.feed(line);
        if (/^(?:\r\n|\r|\n)$/.test(line)) {
            frameRetryMs = undefined;
        }
    };
    const drainPending = (): ServerSentEvent[] => {
        const events = pending.splice(0);
        return events;
    };

    for await (const chunk of chunks) {
        const texts =
            typeof chunk === "string"
                ? [decoder.decode(), chunk]
                : [decoder.decode(chunk, { stream: true })];
        for (const text of texts) {
            for (const line of takeCompleteLines(text)) {
                feedLine(line);
                for (const event of drainPending()) {
                    yield event;
                }
            }
        }
    }
    for (const line of takeCompleteLines(decoder.decode())) {
        feedLine(line);
        for (const event of drainPending()) {
            yield event;
        }
    }
    if (lineBuffer !== "") {
        if (lineBuffer.endsWith("\r")) {
            feedLine(`${lineBuffer}\n`);
            for (const event of drainPending()) {
                yield event;
            }
        } else {
            processProtocolLine(lineBuffer);
            parser.feed(lineBuffer);
            parser.reset({ consume: true });
        }
    }
}

/** Incrementally parses arbitrary text chunks containing SSE events. */
export async function* parseServerSentEvents(
    chunks: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
    yield* parseServerSentEventStream(chunks);
}

async function* responseChunks(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    let completed = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
        cancellation ??= reader.cancel().catch(() => {
            // A failed cancellation will also reject any pending read.
        });
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
        while (true) {
            const result = await reader.read();
            if (signal.aborted) return;
            if (result.done) {
                completed = true;
                return;
            }
            yield result.value;
        }
    } finally {
        signal.removeEventListener("abort", cancel);
        if (!completed) cancel();
        await cancellation;
        reader.releaseLock();
    }
}

function waitForAbortableDelay(
    delayMs: number,
    signal: AbortSignal,
): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal.addEventListener("abort", finish, { once: true });
    });
}

async function awaitWithAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal,
): Promise<T | typeof ABORTED> {
    if (signal.aborted) {
        void operation.catch(() => {});
        return ABORTED;
    }
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<typeof ABORTED>((resolve) => {
        resolveAbort = () => resolve(ABORTED);
    });
    const abort = () => resolveAbort?.();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        signal.removeEventListener("abort", abort);
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
    /** Handles validated events serially; active event processing drains before closure. */
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
    /** Initial reconnection time. Defaults to 3000ms; maximum is 2147483647ms. */
    readonly retryMs?: number;
    /** Optional lower bound; maximum accepted value is 2147483647ms. */
    readonly minRetryMs?: number;
    /** Optional upper bound; maximum accepted value is 2147483647ms. */
    readonly maxRetryMs?: number;
    /** Enables non-standard full jitter. Disabled by default. */
    readonly jitter?: boolean;
    /** Random source returning a finite number from 0 through 1. */
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
        for (const [name, value] of [
            ["retryMs", options.retryMs],
            ["minRetryMs", options.minRetryMs],
            ["maxRetryMs", options.maxRetryMs],
        ] as const) {
            if (
                value !== undefined &&
                (!Number.isFinite(value) ||
                    value < 0 ||
                    value > MAX_TIMER_DELAY_MS)
            ) {
                throw new TypeError(
                    `SseSubscription ${name} must be between 0 and ${MAX_TIMER_DELAY_MS}`,
                );
            }
        }
        if (
            options.minRetryMs !== undefined &&
            options.maxRetryMs !== undefined &&
            options.maxRetryMs < options.minRetryMs
        ) {
            throw new TypeError(
                "SseSubscription maxRetryMs must be greater than or equal to minRetryMs",
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

    /**
     * Stops network activity and prevents another reconnect.
     *
     * Active event processing, including its error callback, finishes before
     * the start task closes, preserving serial delivery across a later restart.
     */
    stop(): void {
        this.controller?.abort();
    }

    private async run(signal: AbortSignal): Promise<void> {
        const fetchImplementation = this.options.fetch ?? globalThis.fetch;
        const clampRetry = (value: number): number =>
            Math.min(
                this.options.maxRetryMs ?? Number.POSITIVE_INFINITY,
                Math.max(
                    this.options.minRetryMs ?? Number.NEGATIVE_INFINITY,
                    value,
                ),
            );
        let reconnectDelayMs = clampRetry(this.options.retryMs ?? 3_000);
        const random = this.options.random ?? Math.random;
        let connected = false;
        try {
            while (!signal.aborted) {
                this.options.onStateChange?.(
                    connected ? "reconnecting" : "connecting",
                );
                if (signal.aborted) break;
                try {
                    const headers = new Headers({
                        accept: "text/event-stream",
                        ...this.options.headers,
                    });
                    if (this.lastEventId !== undefined) {
                        if (this.lastEventId === "") {
                            headers.delete("last-event-id");
                        } else {
                            headers.set("last-event-id", this.lastEventId);
                        }
                    }
                    const responsePromise = fetchImplementation(
                        this.options.url,
                        {
                            headers,
                            signal,
                        },
                    );
                    const response = await awaitWithAbort(
                        responsePromise,
                        signal,
                    );
                    if (response === ABORTED) {
                        void responsePromise
                            .then(async (lateResponse) => {
                                await lateResponse.body?.cancel();
                            })
                            .catch(() => {});
                        break;
                    }
                    if (signal.aborted) {
                        await response.body?.cancel().catch(() => {});
                        break;
                    }
                    if (response.status === 204) break;
                    if (response.status !== 200 || !response.body) {
                        await response.body?.cancel();
                        throw new Error(
                            `SSE connection failed: ${response.status}`,
                        );
                    }
                    const mediaType = response.headers
                        .get("content-type")
                        ?.split(";", 1)[0]
                        ?.trim()
                        .toLowerCase();
                    if (mediaType !== "text/event-stream") {
                        await response.body.cancel();
                        throw new Error(
                            "SSE connection failed: invalid content type",
                        );
                    }
                    try {
                        connected = true;
                        this.options.onStateChange?.("open");
                        for await (const event of parseServerSentEventStream(
                            responseChunks(response.body, signal),
                            {
                                onId: (id) => {
                                    if (!signal.aborted) {
                                        this.lastEventId = id;
                                    }
                                },
                                onRetry: (retryMs) => {
                                    if (!signal.aborted) {
                                        reconnectDelayMs = clampRetry(retryMs);
                                    }
                                },
                            },
                        )) {
                            if (signal.aborted) break;
                            let parsed: unknown;
                            try {
                                const raw = JSON.parse(event.data) as unknown;
                                parsed = this.options.contracts
                                    ? await this.options.contracts.parse(raw)
                                    : await parseEventEnvelope(
                                          this.options
                                              .contract as EventContract<
                                              TType,
                                              TVersion,
                                              TPayloadSchema
                                          >,
                                          raw,
                                      );
                            } catch (error) {
                                if (signal.aborted) break;
                                if (event.id !== undefined) {
                                    this.lastEventId = event.id;
                                }
                                await this.options.onEventError?.(error, event);
                                if (signal.aborted) break;
                                continue;
                            }
                            if (signal.aborted) break;
                            if (event.id !== undefined) {
                                this.lastEventId = event.id;
                            }
                            try {
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
                            if (signal.aborted) break;
                        }
                    } finally {
                        await response.body.cancel().catch(() => {});
                    }
                } catch {
                    if (signal.aborted) break;
                    this.options.onStateChange?.("error");
                }
                if (!signal.aborted) {
                    let delayMs = reconnectDelayMs;
                    if (this.options.jitter) {
                        const randomValue = random();
                        if (
                            !Number.isFinite(randomValue) ||
                            randomValue < 0 ||
                            randomValue > 1
                        ) {
                            throw new TypeError(
                                "SseSubscription random must return a finite number between 0 and 1",
                            );
                        }
                        delayMs = randomValue * reconnectDelayMs;
                    }
                    const wait = this.options.waitForRetry
                        ? this.options.waitForRetry(delayMs, signal)
                        : waitForAbortableDelay(delayMs, signal);
                    await awaitWithAbort(wait, signal);
                }
            }
        } finally {
            this.options.onStateChange?.("closed");
        }
    }
}
