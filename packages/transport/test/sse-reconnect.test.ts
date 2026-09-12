import { describe, expect, test } from "bun:test";
import { defineEventContract } from "@kuma-00/bot-kit-contracts";
import { schema } from "../../../tests/schema.ts";
import {
    type FetchLike,
    type SseConnectionFailure,
    SseSubscription,
} from "../src/index.ts";
import {
    calculateRetryDelay,
    isRetryableStatus,
    parseRetryAfter,
    resolveReconnectOptions,
} from "../src/sse-retry.ts";

const payload = schema<{ value: string }>(
    (value): value is { value: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { value?: unknown }).value === "string",
);
const contract = defineEventContract({
    type: "Updated",
    version: 1,
    payload,
});

async function waitFor(condition: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index++) {
        if (condition()) return;
        await Bun.sleep(1);
    }
    throw new Error("condition was not reached");
}

async function terminalFailureFor(
    fetch: FetchLike,
): Promise<SseConnectionFailure> {
    let result: SseConnectionFailure | undefined;
    const subscription = new SseSubscription({
        url: "https://example.test/events",
        contract,
        reconnect: false,
        fetch,
        onEvent: () => {},
        onConnectionFailure: (failure) => {
            result = failure;
        },
    });
    subscription.start();
    await waitFor(() => subscription.readyState === 2);
    if (!result) throw new Error("connection failure was not reported");
    return result;
}

describe("SSE reconnect policy", () => {
    test("resolves defaults and applies hint priority without jittering Retry-After", () => {
        const options = resolveReconnectOptions(undefined);
        expect(options).toEqual({
            enabled: true,
            initialDelayMs: 3_000,
            maxDelayMs: 30_000,
            multiplier: 2,
            jitterRatio: 0.2,
        });
        expect(calculateRetryDelay(options, 4, 7_000, 1_500, 0)).toBe(1_500);
        expect(
            calculateRetryDelay(
                { ...options, jitterRatio: 0 },
                2,
                7_000,
                undefined,
                0.5,
            ),
        ).toBe(14_000);
    });

    test("parses Retry-After seconds and dates", () => {
        const now = Date.parse("2026-09-12T00:00:00.000Z");
        expect(parseRetryAfter("12", now)).toBe(12_000);
        expect(parseRetryAfter("Sat, 12 Sep 2026 00:00:03 GMT", now)).toBe(
            3_000,
        );
        expect(parseRetryAfter("invalid", now)).toBeUndefined();
    });

    test("classifies the retryable HTTP status allowlist", () => {
        expect([408, 425, 429, 500, 503, 599].every(isRetryableStatus)).toBe(
            true,
        );
        expect(
            [200, 204, 400, 401, 403, 404, 499, 600].some(isRetryableStatus),
        ).toBe(false);
    });

    test("separates network, abort, and invalid response failures", async () => {
        const network = new Error("offline");
        const aborted = new DOMException("interrupted", "AbortError");
        expect(
            await terminalFailureFor(async () => {
                throw network;
            }),
        ).toMatchObject({
            kind: "network",
            phase: "connect",
            cause: network,
            retrying: false,
        });
        expect(
            await terminalFailureFor(async () => {
                throw aborted;
            }),
        ).toMatchObject({
            kind: "aborted",
            phase: "connect",
            cause: aborted,
            retrying: false,
        });

        let cancellations = 0;
        const wrongContentType = await terminalFailureFor(
            async () =>
                new Response(
                    new ReadableStream({
                        cancel: () => {
                            cancellations++;
                        },
                    }),
                    { headers: { "content-type": "application/json" } },
                ),
        );
        expect(wrongContentType).toMatchObject({
            kind: "invalid-response",
            phase: "response",
            reason: "content-type",
            retrying: false,
        });
        await Bun.sleep(0);
        expect(cancellations).toBe(1);

        expect(
            await terminalFailureFor(
                async () =>
                    new Response(null, {
                        headers: { "content-type": "text/event-stream" },
                    }),
            ),
        ).toMatchObject({
            kind: "invalid-response",
            phase: "response",
            reason: "missing-body",
            retrying: false,
        });
    });

    test("closes without opening when the response body is already locked", async () => {
        const body = new ReadableStream<Uint8Array>();
        const response = new Response(body, {
            headers: { "content-type": "text/event-stream" },
        });
        response.body?.getReader();
        const failures: SseConnectionFailure[] = [];
        const states: string[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                return response;
            },
            onEvent: () => {},
            onConnectionFailure: (failure) => {
                failures.push(failure);
            },
            onStateChange: (state) => {
                states.push(state);
            },
        });

        subscription.start();
        await waitFor(() => subscription.readyState === 2);

        expect(states).toEqual(["connecting", "closed"]);
        expect(subscription.readyState).toBe(2);
        expect(fetches).toBe(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
            kind: "invalid-response",
            phase: "response",
            reason: "missing-body",
            status: 200,
            retrying: false,
            cause: expect.any(TypeError),
        });
    });

    test("cancels and releases the reader when stopped during open", async () => {
        let cancellations = 0;
        const stream = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancellations++;
                return new Promise<void>(() => {});
            },
        });
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: false,
            fetch: async () => {
                fetches++;
                if (fetches === 1) {
                    return new Response(stream, {
                        headers: { "content-type": "text/event-stream" },
                    });
                }
                return new Response(null, {
                    headers: { "content-type": "text/event-stream" },
                });
            },
            onEvent: () => {},
            onStateChange: (state) => {
                if (state === "open") subscription.stop();
            },
        });

        subscription.start();
        await waitFor(() => subscription.readyState === 2);
        await waitFor(() => cancellations === 1);

        expect(subscription.readyState).toBe(2);
        expect(cancellations).toBe(1);
        const reader = stream.getReader();
        reader.releaseLock();

        subscription.start();
        await waitFor(() => fetches === 2 && subscription.readyState === 2);
        expect(fetches).toBe(2);
        expect(cancellations).toBe(1);
    });

    test("classifies terminal HTTP responses and closes", async () => {
        const failures: SseConnectionFailure[] = [];
        const states: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => new Response(null, { status: 401 }),
            onEvent: () => {},
            onConnectionFailure: (failure) => {
                failures.push(failure);
            },
            onStateChange: (state) => {
                states.push(state);
            },
        });

        subscription.start();
        await waitFor(() => subscription.readyState === 2);

        expect(failures).toEqual([
            {
                kind: "http",
                phase: "response",
                attempt: 1,
                status: 401,
                retrying: false,
            },
        ]);
        expect(states).toEqual(["connecting", "closed"]);
    });

    test("uses SSE retry hints and forwards Last-Event-ID", async () => {
        const failures: SseConnectionFailure[] = [];
        const requests: Request[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: {
                initialDelayMs: 10_000,
                maxDelayMs: 10_000,
                jitterRatio: 0,
            },
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                fetches++;
                if (fetches === 1) {
                    return new Response(
                        "retry: 0\nid: cursor-1\nevent: ignored\ndata: x\n\n",
                        {
                            headers: {
                                "content-type": "text/event-stream",
                            },
                        },
                    );
                }
                return new Response(null, { status: 204 });
            },
            onEvent: () => {},
            onConnectionFailure: (failure) => {
                failures.push(failure);
            },
        });

        subscription.start();
        await waitFor(() => fetches === 2 && subscription.readyState === 2);

        expect(requests[0]?.headers.get("last-event-id")).toBeNull();
        expect(requests[1]?.headers.get("last-event-id")).toBe("cursor-1");
        expect(failures[0]).toEqual({
            kind: "eof",
            phase: "stream",
            attempt: 1,
            retrying: true,
            retryInMs: 0,
        });
        expect(failures[1]).toEqual({
            kind: "http",
            phase: "response",
            attempt: 2,
            status: 204,
            retrying: false,
        });
    });

    test("forwards cursor-only ids and clears them with an empty id", async () => {
        const requests: Request[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: {
                initialDelayMs: 0,
                maxDelayMs: 0,
                jitterRatio: 0,
            },
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                fetches++;
                if (fetches === 1) {
                    return new Response("id: cursor-only\r\n\r\n", {
                        headers: { "content-type": "text/event-stream" },
                    });
                }
                if (fetches === 2) {
                    return new Response("id:\r\n\r\n", {
                        headers: { "content-type": "text/event-stream" },
                    });
                }
                return new Response(null, { status: 204 });
            },
            onEvent: () => {},
        });

        subscription.start();
        await waitFor(() => fetches === 3 && subscription.readyState === 2);

        expect(requests[0]?.headers.get("last-event-id")).toBeNull();
        expect(requests[1]?.headers.get("last-event-id")).toBe("cursor-only");
        expect(requests[2]?.headers.get("last-event-id")).toBeNull();
    });

    test("tracks split CRLF cursor-only blocks and ignores NULL ids", async () => {
        const requests: Request[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: {
                initialDelayMs: 0,
                maxDelayMs: 0,
                jitterRatio: 0,
            },
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                fetches++;
                if (fetches === 1) {
                    let index = 0;
                    const chunks = ["id: split", "-cursor\r", "\n\r", "\n"];
                    return new Response(
                        new ReadableStream({
                            pull(controller) {
                                const chunk = chunks[index++];
                                if (chunk === undefined) controller.close();
                                else
                                    controller.enqueue(
                                        new TextEncoder().encode(chunk),
                                    );
                            },
                        }),
                        { headers: { "content-type": "text/event-stream" } },
                    );
                }
                if (fetches === 2) {
                    return new Response("id: bad\0cursor\r\n\r\n", {
                        headers: { "content-type": "text/event-stream" },
                    });
                }
                return new Response(null, { status: 204 });
            },
            onEvent: () => {},
        });

        subscription.start();
        await waitFor(() => fetches === 3 && subscription.readyState === 2);

        expect(requests[1]?.headers.get("last-event-id")).toBe("split-cursor");
        expect(requests[2]?.headers.get("last-event-id")).toBe("split-cursor");
    });

    test("discards an id from an unterminated block at EOF", async () => {
        const requests: Request[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                fetches++;
                return fetches === 1
                    ? new Response("id: not-dispatched", {
                          headers: { "content-type": "text/event-stream" },
                      })
                    : new Response(null, { status: 204 });
            },
            onEvent: () => {},
        });

        subscription.start();
        await waitFor(() => fetches === 2 && subscription.readyState === 2);

        expect(requests[1]?.headers.get("last-event-id")).toBeNull();
    });

    test("clears the cursor when manually restarted", async () => {
        const requests: Request[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: false,
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                fetches++;
                return fetches === 1
                    ? new Response("id: old-lifecycle\n\n", {
                          headers: { "content-type": "text/event-stream" },
                      })
                    : new Response(null, { status: 204 });
            },
            onEvent: () => {},
        });

        subscription.start();
        await waitFor(() => subscription.readyState === 2);
        subscription.start();
        await waitFor(() => fetches === 2 && subscription.readyState === 2);

        expect(requests[1]?.headers.get("last-event-id")).toBeNull();
    });

    test("retryNow skips only the pending reconnect delay", async () => {
        const failures: SseConnectionFailure[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            reconnect: {
                initialDelayMs: 60_000,
                maxDelayMs: 60_000,
                jitterRatio: 0,
            },
            fetch: async () => {
                fetches++;
                return new Response(null, {
                    status: fetches === 1 ? 503 : 403,
                });
            },
            onEvent: () => {},
            onConnectionFailure: (failure) => {
                failures.push(failure);
            },
        });

        subscription.start();
        await waitFor(() => failures.length === 1);
        subscription.retryNow();
        await waitFor(() => subscription.readyState === 2);

        expect(fetches).toBe(2);
        expect(failures[0]).toEqual({
            kind: "http",
            phase: "response",
            attempt: 1,
            status: 503,
            retrying: true,
            retryInMs: 60_000,
        });
        expect(failures[1]).toMatchObject({
            kind: "http",
            status: 403,
            retrying: false,
        });
    });

    test("stop aborts the active request without reporting a failure", async () => {
        let signal: AbortSignal | undefined;
        const failures: SseConnectionFailure[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) =>
                await new Promise<Response>((_resolve, reject) => {
                    signal = init?.signal ?? undefined;
                    signal?.addEventListener(
                        "abort",
                        () =>
                            reject(
                                new DOMException(
                                    "The operation was aborted",
                                    "AbortError",
                                ),
                            ),
                        { once: true },
                    );
                }),
            onEvent: () => {},
            onConnectionFailure: (failure) => {
                failures.push(failure);
            },
        });

        subscription.start();
        await waitFor(() => signal !== undefined);
        subscription.stop();
        await Bun.sleep(0);

        expect(signal?.aborted).toBe(true);
        expect(subscription.readyState).toBe(2);
        expect(failures).toEqual([]);
    });

    test("contains a late rejection from a fetch that ignores abort", async () => {
        let rejectFirst: ((cause: unknown) => void) | undefined;
        let fetches = 0;
        const first = new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on("unhandledRejection", onUnhandled);
        try {
            const subscription = new SseSubscription({
                url: "https://example.test/events",
                contract,
                reconnect: false,
                fetch: async () => {
                    fetches++;
                    return fetches === 1
                        ? first
                        : new Response(null, { status: 204 });
                },
                onEvent: () => {},
            });

            subscription.start();
            await waitFor(() => fetches === 1);
            subscription.stop();
            subscription.start();
            await waitFor(() => fetches === 2);
            const failure = new Error("late fetch failure");
            rejectFirst?.(failure);
            await Bun.sleep(0);

            expect(unhandled).toEqual([]);
            expect(subscription.readyState).toBe(2);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    test("rejects invalid parser buffer limits before fetching", () => {
        let fetches = 0;
        for (const maxBufferSize of [
            0,
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            1.5,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(
                () =>
                    new SseSubscription({
                        url: "https://example.test/events",
                        contract,
                        maxBufferSize,
                        fetch: async () => {
                            fetches++;
                            return new Response(null);
                        },
                        onEvent: () => {},
                    }),
            ).toThrow(TypeError);
        }
        expect(fetches).toBe(0);
    });

    test("closes once without reconnecting when the parser buffer is exceeded", async () => {
        const failures: SseConnectionFailure[] = [];
        let fetches = 0;
        let cancellations = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            maxBufferSize: 8,
            reconnect: {
                initialDelayMs: 0,
                maxDelayMs: 0,
                jitterRatio: 0,
            },
            fetch: async () => {
                fetches++;
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode("data: too-large"),
                            );
                        },
                        cancel() {
                            cancellations++;
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                );
            },
            onEvent: () => {},
            onConnectionFailure: (failure) => {
                failures.push(failure);
            },
        });

        subscription.start();
        await waitFor(() => subscription.readyState === 2);

        expect(fetches).toBe(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
            kind: "invalid-response",
            phase: "stream",
            reason: "stream-format",
            retrying: false,
        });
        expect(
            failures[0]?.kind === "invalid-response"
                ? failures[0].cause
                : undefined,
        ).toBeInstanceOf(Error);
        await waitFor(() => cancellations === 1);
        expect(cancellations).toBe(1);
    });

    test("delivers events within a custom buffer limit", async () => {
        const events: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            maxBufferSize: 1024,
            reconnect: false,
            fetch: async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `data: ${JSON.stringify({
                                        id: "event-1",
                                        type: "Updated",
                                        version: 1,
                                        occurredAt: "2026-09-12T00:00:00.000Z",
                                        payload: { value: "large enough" },
                                    })}\n\n`,
                                ),
                            );
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                ),
            onEvent: (event) => {
                events.push(event.id);
            },
        });

        subscription.start();
        await waitFor(() => events.length === 1);
        expect(events).toEqual(["event-1"]);
        subscription.stop();
    });

    test("ignores recoverable parser diagnostics and continues delivery", async () => {
        const events: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            maxBufferSize: 1024,
            reconnect: false,
            fetch: async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `unknown: ignored\nretry: invalid\ndata: ${JSON.stringify(
                                        {
                                            id: "event-2",
                                            type: "Updated",
                                            version: 1,
                                            occurredAt:
                                                "2026-09-12T00:00:00.000Z",
                                            payload: { value: "ok" },
                                        },
                                    )}\n\n`,
                                ),
                            );
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                ),
            onEvent: (event) => {
                events.push(event.id);
            },
        });

        subscription.start();
        await waitFor(() => events.length === 1);
        expect(events).toEqual(["event-2"]);
        subscription.stop();
    });
});
