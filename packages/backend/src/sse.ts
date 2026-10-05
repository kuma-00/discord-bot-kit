/** Message accepted by the in-memory SSE event broker. */
export interface BrokerEvent {
    readonly id: string;
    readonly type?: string;
    readonly data: unknown;
    readonly retry?: number;
}

/** Configuration for heartbeat and response headers. */
export interface SseBrokerOptions {
    /** Interval in milliseconds from 1 through 2,147,483,647; omitted to disable heartbeats. */
    readonly heartbeatIntervalMs?: number;
    /** Additional response headers. The broker always sets the SSE content type. */
    readonly headers?: HeadersInit;
}

interface Subscriber {
    readonly scope?: string;
    controller?: ReadableStreamDefaultController<Uint8Array>;
    cleanup: () => void;
}

const encoder = new TextEncoder();
const HEARTBEAT = encoder.encode(": heartbeat\n\n");

function encodeSse(event: BrokerEvent): Uint8Array {
    const lines = [
        `id: ${event.id}`,
        ...(event.type ? [`event: ${event.type}`] : []),
        ...(event.retry === undefined ? [] : [`retry: ${event.retry}`]),
        ...JSON.stringify(event.data)
            .split("\n")
            .map((line) => `data: ${line}`),
        "",
        "",
    ];
    return encoder.encode(lines.join("\n"));
}

function validateScope(scope: unknown): asserts scope is string {
    if (typeof scope !== "string" || scope.trim().length === 0) {
        throw new TypeError("SSE scope must be a non-empty string");
    }
}

function responseHeaders(customHeaders?: HeadersInit): Headers {
    const headers = new Headers({
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
    });
    if (customHeaders) {
        new Headers(customHeaders).forEach((value, key) => {
            headers.set(key, value);
        });
    }
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return headers;
}

/**
 * In-memory SSE fan-out for one backend process. Global publishes reach every
 * active connection; scoped publishes reach only connections opened for the
 * exact scope key. This broker does not buffer or replay events.
 *
 * @example
 * ```ts
 * const broker = new SseEventBroker();
 * const response = broker.responseFor("guild:123", request.signal);
 * broker.publishTo("guild:123", { id: "1", data: { ready: true } });
 * ```
 */
export class SseEventBroker {
    private readonly subscribers = new Set<Subscriber>();
    private readonly scopedSubscribers = new Map<string, Set<Subscriber>>();
    private readonly heartbeatIntervalMs: number | undefined;
    private readonly headers: HeadersInit | undefined;

    /** Creates a broker with optional heartbeat and response-header settings. */
    constructor(options: SseBrokerOptions = {}) {
        if (
            options.heartbeatIntervalMs !== undefined &&
            (!Number.isSafeInteger(options.heartbeatIntervalMs) ||
                options.heartbeatIntervalMs <= 0 ||
                options.heartbeatIntervalMs > 2_147_483_647)
        ) {
            throw new TypeError(
                "heartbeatIntervalMs must be an integer from 1 through 2147483647",
            );
        }
        this.heartbeatIntervalMs = options.heartbeatIntervalMs;
        this.headers = options.headers;
    }

    /** Number of currently active response streams. */
    get subscriberCount(): number {
        return this.subscribers.size;
    }

    /** Number of scopes that currently have at least one active response stream. */
    get scopeCount(): number {
        return this.scopedSubscribers.size;
    }

    /** Publishes an event to every active scoped and unscoped connection. */
    publish(event: BrokerEvent): void {
        this.deliver(this.subscribers, encodeSse(event));
    }

    /** Publishes an event only to connections opened for the exact scope key. */
    publishTo(scope: string, event: BrokerEvent): void {
        validateScope(scope);
        const subscribers = this.scopedSubscribers.get(scope);
        if (subscribers) this.deliver(subscribers, encodeSse(event));
    }

    /** Opens an unscoped SSE response; global publishes reach this response. */
    response(signal?: AbortSignal): Response {
        return this.createResponse(undefined, signal);
    }

    /**
     * Opens an SSE response tied to an opaque, exact-match scope key. Scoped
     * publishes are isolated to that key; global publishes still reach it.
     *
     * @throws {TypeError} If scope is not a non-empty string after trimming.
     */
    responseFor(scope: string, signal?: AbortSignal): Response {
        validateScope(scope);
        return this.createResponse(scope, signal);
    }

    private deliver(subscribers: Set<Subscriber>, chunk: Uint8Array): void {
        for (const subscriber of [...subscribers]) {
            try {
                subscriber.controller?.enqueue(chunk);
            } catch {
                subscriber.cleanup();
            }
        }
    }

    private createResponse(
        scope: string | undefined,
        signal?: AbortSignal,
    ): Response {
        const headers = responseHeaders(this.headers);
        if (signal?.aborted) {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            });
            return new Response(stream, { headers });
        }

        const subscriber: Subscriber = {
            ...(scope === undefined ? {} : { scope }),
            cleanup: () => {},
        };
        let registered = false;
        let interval: ReturnType<typeof setInterval> | undefined;
        const abortListener = () => subscriber.cleanup();
        subscriber.cleanup = () => {
            if (!registered) {
                try {
                    subscriber.controller?.close();
                } catch {
                    // The stream may already be cancelled or errored.
                }
                return;
            }
            registered = false;
            this.subscribers.delete(subscriber);
            if (scope !== undefined) {
                const scoped = this.scopedSubscribers.get(scope);
                scoped?.delete(subscriber);
                if (scoped?.size === 0) this.scopedSubscribers.delete(scope);
            }
            signal?.removeEventListener("abort", abortListener);
            if (interval !== undefined) clearInterval(interval);
            try {
                subscriber.controller?.close();
            } catch {
                // The stream may already be cancelled or errored.
            }
        };

        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                subscriber.controller = controller;
                if (signal?.aborted) {
                    subscriber.cleanup();
                    return;
                }
                registered = true;
                this.subscribers.add(subscriber);
                if (scope !== undefined) {
                    let scoped = this.scopedSubscribers.get(scope);
                    if (!scoped) {
                        scoped = new Set();
                        this.scopedSubscribers.set(scope, scoped);
                    }
                    scoped.add(subscriber);
                }
                signal?.addEventListener("abort", abortListener, {
                    once: true,
                });
                if (this.heartbeatIntervalMs !== undefined) {
                    interval = setInterval(() => {
                        try {
                            controller.enqueue(HEARTBEAT);
                        } catch {
                            subscriber.cleanup();
                        }
                    }, this.heartbeatIntervalMs);
                }
            },
            cancel: () => subscriber.cleanup(),
        });
        return new Response(stream, { headers });
    }
}
