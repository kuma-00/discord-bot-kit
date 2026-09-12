import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { FetchLike } from "./http.ts";
import type {
    SseConnectionFailure,
    SseConnectionState,
    SseReconnectOptions,
} from "./sse.ts";
import {
    calculateRetryDelay,
    clampServerRetry,
    isRetryableStatus,
    parseRetryAfter,
    resolveReconnectOptions,
} from "./sse-retry.ts";

const DEFAULT_MAX_BUFFER_SIZE = 1_048_576;

export interface SseRuntime {
    readonly now: () => number;
    readonly random: () => number;
    readonly setTimeout: (
        callback: () => void,
        delayMs: number,
    ) => ReturnType<typeof setTimeout>;
    readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SseConnectionOptions {
    readonly url: string;
    readonly fetch?: FetchLike;
    readonly headers?: Readonly<Record<string, string>>;
    readonly withCredentials?: boolean;
    readonly reconnect?: false | SseReconnectOptions;
    readonly maxBufferSize?: number;
    readonly eventTypes: ReadonlySet<string>;
    readonly onEvent: (event: MessageEvent, lifecycle: number) => void;
    readonly onStateChange?: (
        state: SseConnectionState,
    ) => void | Promise<void>;
    readonly onConnectionFailure?: (
        failure: SseConnectionFailure,
    ) => void | Promise<void>;
}

type FailureWithoutDisposition =
    | Omit<
          Extract<SseConnectionFailure, { readonly kind: "network" }>,
          "retrying" | "retryInMs"
      >
    | Omit<
          Extract<SseConnectionFailure, { readonly kind: "aborted" }>,
          "retrying" | "retryInMs"
      >
    | Omit<
          Extract<SseConnectionFailure, { readonly kind: "eof" }>,
          "retrying" | "retryInMs"
      >
    | Omit<
          Extract<SseConnectionFailure, { readonly kind: "http" }>,
          "retrying" | "retryInMs"
      >
    | Omit<
          Extract<SseConnectionFailure, { readonly kind: "invalid-response" }>,
          "retrying" | "retryInMs"
      >;

type AttemptResult =
    | { readonly stopped: true }
    | {
          readonly stopped: false;
          readonly retryable: boolean;
          readonly retryAfterMs?: number;
          readonly failure: FailureWithoutDisposition;
      };

const DEFAULT_RUNTIME: SseRuntime = {
    now: Date.now,
    random: Math.random,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};

export class SseConnection {
    private readonly reconnect;
    private readonly maxBufferSize: number;
    private state: SseConnectionState = "closed";
    private active = false;
    private lifecycle = 0;
    private attempt = 0;
    private consecutiveFailures = 0;
    private serverRetryMs: number | undefined;
    private lastEventId: string | undefined;
    private activeController: AbortController | undefined;
    private activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    private lifecycleTask: Promise<void> = Promise.resolve();
    private retryWait:
        | {
              readonly handle: ReturnType<typeof setTimeout>;
              finish(proceed: boolean): void;
          }
        | undefined;

    constructor(
        private readonly options: SseConnectionOptions,
        private readonly runtime: SseRuntime = DEFAULT_RUNTIME,
    ) {
        this.reconnect = resolveReconnectOptions(options.reconnect);
        this.maxBufferSize = resolveMaxBufferSize(options.maxBufferSize);
    }

    get readyState(): number {
        if (this.state === "connecting") return 0;
        if (this.state === "open") return 1;
        return 2;
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        const lifecycle = ++this.lifecycle;
        this.attempt = 0;
        this.consecutiveFailures = 0;
        this.serverRetryMs = undefined;
        this.lastEventId = undefined;
        this.emitState("connecting");
        if (!this.isLifecycleCurrent(lifecycle)) return;

        const previous = this.lifecycleTask;
        const task = previous
            .catch(() => undefined)
            .then(async () => {
                if (this.isLifecycleCurrent(lifecycle)) {
                    await this.run(lifecycle);
                }
            });
        this.lifecycleTask = task;
        void task.catch(() => {
            // run contains expected failures. Keep a defensive rejection
            // boundary around lifecycle work started from this void API.
        });
    }

    stop(): void {
        this.active = false;
        this.lifecycle += 1;
        this.cancelRetry(false);
        this.activeController?.abort();
        const reader = this.activeReader;
        if (reader) void reader.cancel().catch(() => undefined);
        this.emitState("closed");
    }

    retryNow(): void {
        if (!this.active || !this.retryWait) return;
        this.cancelRetry(true);
    }

    isLifecycleCurrent(lifecycle: number): boolean {
        return this.active && lifecycle === this.lifecycle;
    }

    private async run(lifecycle: number): Promise<void> {
        while (this.isLifecycleCurrent(lifecycle)) {
            const result = await this.connectOnce(lifecycle);
            if (result.stopped || !this.isLifecycleCurrent(lifecycle)) return;

            this.consecutiveFailures += 1;
            const shouldRetry = this.reconnect.enabled && result.retryable;
            const retryInMs = shouldRetry
                ? calculateRetryDelay(
                      this.reconnect,
                      this.consecutiveFailures,
                      this.serverRetryMs,
                      result.retryAfterMs,
                      this.runtime.random(),
                  )
                : undefined;
            const failure = {
                ...result.failure,
                retrying: shouldRetry,
                ...(retryInMs === undefined ? {} : { retryInMs }),
            } as SseConnectionFailure;
            this.emitFailure(failure);
            if (!this.isLifecycleCurrent(lifecycle)) return;
            if (!shouldRetry || retryInMs === undefined) {
                this.active = false;
                this.emitState("closed");
                return;
            }
            this.emitState("connecting");
            if (!this.isLifecycleCurrent(lifecycle)) return;
            if (!(await this.waitForRetry(retryInMs, lifecycle))) return;
        }
    }

    private async connectOnce(lifecycle: number): Promise<AttemptResult> {
        const attempt = ++this.attempt;
        const controller = new AbortController();
        this.activeController = controller;
        let response: Response | undefined;
        try {
            response = await this.fetchResponse(controller);
        } catch (cause) {
            this.releaseController(controller);
            if (
                !this.isLifecycleCurrent(lifecycle) ||
                controller.signal.aborted
            ) {
                return { stopped: true };
            }
            const aborted = isAbortError(cause);
            return {
                stopped: false,
                retryable: true,
                failure: aborted
                    ? {
                          kind: "aborted",
                          phase: "connect",
                          attempt,
                          cause,
                      }
                    : {
                          kind: "network",
                          phase: "connect",
                          attempt,
                          cause,
                      },
            };
        }

        if (!response) {
            this.releaseController(controller);
            return { stopped: true };
        }

        if (!this.isLifecycleCurrent(lifecycle)) {
            discardResponse(response);
            this.releaseController(controller);
            return { stopped: true };
        }
        if (response.status !== 200) {
            discardResponse(response);
            this.releaseController(controller);
            const retryable = isRetryableStatus(response.status);
            const retryAfterMs = retryable
                ? parseRetryAfter(
                      response.headers.get("retry-after"),
                      this.runtime.now(),
                  )
                : undefined;
            return {
                stopped: false,
                retryable,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                failure: {
                    kind: "http",
                    phase: "response",
                    attempt,
                    status: response.status,
                },
            };
        }

        const contentType = response.headers.get("content-type");
        if (
            contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
            "text/event-stream"
        ) {
            discardResponse(response);
            this.releaseController(controller);
            return {
                stopped: false,
                retryable: false,
                failure: {
                    kind: "invalid-response",
                    phase: "response",
                    attempt,
                    status: response.status,
                    reason: "content-type",
                },
            };
        }
        if (!response.body || typeof response.body.getReader !== "function") {
            this.releaseController(controller);
            return {
                stopped: false,
                retryable: false,
                failure: {
                    kind: "invalid-response",
                    phase: "response",
                    attempt,
                    status: response.status,
                    reason: "missing-body",
                },
            };
        }

        let reader: ReadableStreamDefaultReader<Uint8Array>;
        try {
            reader = response.body.getReader();
        } catch (cause) {
            discardResponse(response);
            this.releaseController(controller);
            return {
                stopped: false,
                retryable: false,
                failure: {
                    kind: "invalid-response",
                    phase: "response",
                    attempt,
                    status: response.status,
                    reason: "missing-body",
                    cause,
                },
            };
        }

        this.activeReader = reader;
        this.consecutiveFailures = 0;
        this.emitState("open");
        if (!this.isLifecycleCurrent(lifecycle)) {
            if (this.activeReader === reader) this.activeReader = undefined;
            void reader.cancel().catch(() => undefined);
            this.releaseController(controller);
            try {
                reader.releaseLock();
            } catch {
                // A cancelled reader may already have released its lock.
            }
            return { stopped: true };
        }

        const parser = createParser({
            maxBufferSize: this.maxBufferSize,
            onError: (error) => {
                if (error.type === "max-buffer-size-exceeded") throw error;
            },
            onRetry: (value) => {
                if (!this.isLifecycleCurrent(lifecycle)) return;
                const retry = clampServerRetry(
                    value,
                    this.reconnect.maxDelayMs,
                );
                if (retry !== undefined) this.serverRetryMs = retry;
            },
            onEvent: (event) =>
                this.handleParsedEvent(event, response, lifecycle),
        });
        const cursorTracker = new SseCursorTracker(this.maxBufferSize, (id) => {
            if (this.isLifecycleCurrent(lifecycle)) {
                this.lastEventId = id;
            }
        });
        const decoder = new TextDecoder();
        try {
            while (this.isLifecycleCurrent(lifecycle)) {
                const chunk = await reader.read();
                if (!this.isLifecycleCurrent(lifecycle)) {
                    return { stopped: true };
                }
                if (chunk.done) {
                    const trailing = decoder.decode();
                    if (trailing) {
                        cursorTracker.feed(trailing);
                        parser.feed(trailing);
                    }
                    parser.reset();
                    return {
                        stopped: false,
                        retryable: true,
                        failure: {
                            kind: "eof",
                            phase: "stream",
                            attempt,
                        },
                    };
                }
                if (chunk.value) {
                    const text = decoder.decode(chunk.value, {
                        stream: true,
                    });
                    cursorTracker.feed(text);
                    parser.feed(text);
                }
            }
            return { stopped: true };
        } catch (cause) {
            if (!this.isLifecycleCurrent(lifecycle)) {
                return { stopped: true };
            }
            if (isParserFailure(cause)) {
                if (isMaxBufferFailure(cause)) {
                    void reader.cancel().catch(() => undefined);
                }
                return {
                    stopped: false,
                    retryable: false,
                    failure: {
                        kind: "invalid-response",
                        phase: "stream",
                        attempt,
                        status: response.status,
                        reason: "stream-format",
                        cause,
                    },
                };
            }
            const aborted = isAbortError(cause);
            return {
                stopped: false,
                retryable: true,
                failure: aborted
                    ? {
                          kind: "aborted",
                          phase: "stream",
                          attempt,
                          cause,
                      }
                    : {
                          kind: "network",
                          phase: "stream",
                          attempt,
                          cause,
                      },
            };
        } finally {
            if (this.activeReader === reader) this.activeReader = undefined;
            this.releaseController(controller);
            try {
                reader.releaseLock();
            } catch {
                // A cancelled reader may already have released its lock.
            }
        }
    }

    private fetchResponse(
        controller: AbortController,
    ): Promise<Response | undefined> {
        const fetch = this.options.fetch ?? globalThis.fetch;
        return new Promise<Response | undefined>((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
                if (settled) return;
                settled = true;
                controller.signal.removeEventListener("abort", onAbort);
                // The underlying FetchLike may ignore abort. Let the lifecycle
                // finish now; late results are handled by the promise handlers.
                resolve(undefined);
            };
            controller.signal.addEventListener("abort", onAbort, {
                once: true,
            });

            let result: Promise<Response>;
            try {
                result = Promise.resolve(
                    fetch(
                        this.options.url,
                        this.requestInit(controller.signal),
                    ),
                );
            } catch (cause) {
                controller.signal.removeEventListener("abort", onAbort);
                settled = true;
                reject(cause);
                return;
            }

            result.then(
                (response) => {
                    if (settled) {
                        discardResponse(response);
                        return;
                    }
                    settled = true;
                    controller.signal.removeEventListener("abort", onAbort);
                    resolve(response);
                },
                (cause) => {
                    if (settled) return;
                    settled = true;
                    controller.signal.removeEventListener("abort", onAbort);
                    reject(cause);
                },
            );
        });
    }

    private requestInit(signal: AbortSignal): RequestInit {
        const headers = new Headers(this.options.headers);
        headers.set("accept", "text/event-stream");
        if (this.lastEventId) {
            headers.set("last-event-id", this.lastEventId);
        } else {
            headers.delete("last-event-id");
        }
        return {
            headers,
            signal,
            cache: "no-store",
            redirect: "follow",
            ...(this.options.withCredentials === undefined
                ? {}
                : {
                      credentials: this.options.withCredentials
                          ? "include"
                          : "same-origin",
                  }),
        };
    }

    private releaseController(controller: AbortController): void {
        if (this.activeController === controller) {
            this.activeController = undefined;
        }
    }

    private handleParsedEvent(
        event: EventSourceMessage,
        response: Response,
        lifecycle: number,
    ): void {
        if (!this.isLifecycleCurrent(lifecycle)) return;
        if (event.id !== undefined) this.lastEventId = event.id || undefined;
        const type = event.event || "message";
        if (!this.options.eventTypes.has(type)) return;
        this.options.onEvent(
            new MessageEvent(type, {
                data: event.data,
                lastEventId: this.lastEventId ?? "",
                origin: responseOrigin(response, this.options.url),
            }),
            lifecycle,
        );
    }

    private waitForRetry(delayMs: number, lifecycle: number): Promise<boolean> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (proceed: boolean) => {
                if (settled) return;
                settled = true;
                if (this.retryWait?.handle === handle) {
                    this.retryWait = undefined;
                }
                resolve(proceed && this.isLifecycleCurrent(lifecycle));
            };
            const handle = this.runtime.setTimeout(() => finish(true), delayMs);
            this.retryWait = {
                handle,
                finish,
            };
            const unref = (handle as { unref?: () => void }).unref;
            unref?.call(handle);
        });
    }

    private cancelRetry(proceed: boolean): void {
        const wait = this.retryWait;
        if (!wait) return;
        this.runtime.clearTimeout(wait.handle);
        wait.finish(proceed);
    }

    private emitState(state: SseConnectionState): void {
        if (state === this.state) return;
        this.state = state;
        containObserver(this.options.onStateChange, state);
    }

    private emitFailure(failure: SseConnectionFailure): void {
        containObserver(this.options.onConnectionFailure, failure);
    }
}

function resolveMaxBufferSize(value: number | undefined): number {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(
            "SseSubscription maxBufferSize must be a positive safe integer",
        );
    }
    return value ?? DEFAULT_MAX_BUFFER_SIZE;
}

class SseCursorTracker {
    private readonly lineFragments: string[] = [];
    private lineLength = 0;
    private pendingId: string | undefined;
    private pendingCarriageReturn = false;

    constructor(
        private readonly maxBufferSize: number,
        private readonly onDispatch: (id: string | undefined) => void,
    ) {}

    feed(text: string): void {
        let fragmentStart = 0;
        for (let index = 0; index < text.length; index++) {
            const character = text[index];
            if (this.pendingCarriageReturn) {
                this.pendingCarriageReturn = false;
                if (character === "\n") {
                    fragmentStart = index + 1;
                    continue;
                }
            }
            if (character === "\r" || character === "\n") {
                this.appendFragment(text.slice(fragmentStart, index));
                this.dispatchLine();
                this.pendingCarriageReturn = character === "\r";
                fragmentStart = index + 1;
            }
        }
        this.appendFragment(text.slice(fragmentStart));
    }

    private dispatchLine(): void {
        if (this.lineLength === 0) {
            if (this.pendingId !== undefined) {
                this.onDispatch(this.pendingId || undefined);
            }
            this.pendingId = undefined;
            return;
        }

        const line = this.lineFragments.join("");
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        if (field === "id") {
            const value = separator === -1 ? "" : line.slice(separator + 1);
            if (!value.includes("\0")) {
                this.pendingId = value.startsWith(" ") ? value.slice(1) : value;
            }
        }
        this.lineFragments.length = 0;
        this.lineLength = 0;
    }

    private appendFragment(fragment: string): void {
        if (!fragment) return;
        this.lineFragments.push(fragment);
        this.lineLength += fragment.length;
        if (this.lineLength > this.maxBufferSize) {
            const error = new Error("SSE stream exceeded maxBufferSize");
            error.name = "ParseError";
            (error as Error & { type: string }).type =
                "max-buffer-size-exceeded";
            throw error;
        }
    }
}

function containObserver<T>(
    observer: ((value: T) => void | Promise<void>) | undefined,
    value: T,
): void {
    if (!observer) return;
    try {
        void Promise.resolve(observer(value)).catch(() => undefined);
    } catch {
        // Observers must not disrupt connection lifecycle.
    }
}

function isAbortError(cause: unknown): boolean {
    return (
        cause instanceof Error &&
        (cause.name === "AbortError" ||
            ("type" in cause && cause.type === "aborted"))
    );
}

function isParserFailure(cause: unknown): boolean {
    return (
        cause instanceof Error &&
        (cause.name === "ParseError" ||
            cause.message.startsWith("Cannot feed parser"))
    );
}

function isMaxBufferFailure(cause: unknown): boolean {
    return (
        cause instanceof Error &&
        "type" in cause &&
        cause.type === "max-buffer-size-exceeded"
    );
}

function responseOrigin(response: Response, fallbackUrl: string): string {
    try {
        return new URL(response.url || fallbackUrl).origin;
    } catch {
        return "";
    }
}

function discardResponse(response: Response): void {
    try {
        void response.body?.cancel().catch(() => undefined);
    } catch {
        // A custom Fetch response may expose an already-locked body.
    }
}
