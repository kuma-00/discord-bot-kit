import { describe, expect, test } from "bun:test";
import {
    createEventRegistry,
    defineEventContract,
    defineHttpContract,
    type StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";
import { schema } from "../../../tests/schema.ts";
import {
    HttpClient,
    parseServerSentEvents,
    SseSubscription,
} from "../src/index.ts";

const requestSchema = schema<{
    params: { id: string };
    query?: { active: boolean };
    body?: { name: string };
}>(
    (
        value,
    ): value is {
        params: { id: string };
        query?: { active: boolean };
        body?: { name: string };
    } => typeof value === "object" && value !== null && "params" in value,
);
const outputSchema = schema<{ id: string }>(
    (value): value is { id: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { id?: unknown }).id === "string",
);
const errorSchema = schema<{ reason: string }>(
    (value): value is { reason: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { reason?: unknown }).reason === "string",
);
const route = defineHttpContract({
    id: "update",
    method: "POST",
    path: "/items/:id",
    input: requestSchema,
    output: outputSchema,
    error: errorSchema,
});

describe("HttpClient", () => {
    test("serializes path, query, body, and API key", async () => {
        let captured: Request | undefined;
        const client = new HttpClient({
            baseUrl: "https://example.test",
            apiKey: "key",
            fetch: async (input, init) => {
                captured = new Request(input, init);
                return Response.json({ id: "42" });
            },
        });
        const result = await client.request(route, {
            params: { id: "42" },
            query: { active: true },
            body: { name: "test" },
        });
        expect(result).toEqual({ ok: true, data: { id: "42" } });
        expect(captured?.url).toBe("https://example.test/items/42?active=true");
        expect(captured?.headers.get("x-api-key")).toBe("key");
        expect(await captured?.json()).toEqual({ name: "test" });
    });

    test("returns typed HTTP and invalid-response failures", async () => {
        const typed = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async () => Response.json({ reason: "no" }, { status: 400 }),
        });
        expect(await typed.request(route, { params: { id: "1" } })).toEqual({
            ok: false,
            error: {
                code: "http-error",
                message: "HTTP 400",
                details: { reason: "no" },
            },
        });
        const invalid = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async () => Response.json({ unexpected: true }),
        });
        const result = await invalid.request(route, { params: { id: "1" } });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("invalid-response");
    });

    test("aborts timed out requests", async () => {
        const client = new HttpClient({
            baseUrl: "https://example.test",
            timeoutMs: 5,
            fetch: async (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    );
                }),
        });
        const result = await client.request(route, { params: { id: "1" } });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("timeout");
    });
});

describe("SSE", () => {
    const sseResponse = (
        body: BodyInit | null,
        init?: ResponseInit,
    ): Response => {
        const headers = new Headers(init?.headers);
        headers.set("content-type", "text/event-stream; charset=utf-8");
        return new Response(body, { ...init, headers });
    };

    test("parses frames split across arbitrary chunks", async () => {
        async function* chunks() {
            yield "id: 1\nretry: 5000\nevent: Up";
            yield 'dated\ndata: {"value":';
            yield '"ok"}\n\n';
        }
        const events = [];
        for await (const event of parseServerSentEvents(chunks())) {
            events.push(event);
        }
        expect(events).toEqual([
            {
                id: "1",
                event: "Updated",
                data: '{"value":"ok"}',
                retry: 5_000,
            },
        ]);
    });

    test("parses a CR-only frame ending at EOF", async () => {
        async function* chunks() {
            yield "data: ok\r\r";
        }
        const events = [];
        for await (const event of parseServerSentEvents(chunks())) {
            events.push(event);
        }
        expect(events).toEqual([{ data: "ok" }]);
    });

    test("strips only the logical stream's leading BOM across chunk types", async () => {
        async function* chunks() {
            const encoder = new TextEncoder();
            yield "\uFEFFdata: first\n\n";
            yield encoder.encode("\uFEFFdata: ignored\n\n");
            yield "data: second\n\n";
        }
        const events = [];
        for await (const event of parseServerSentEvents(chunks())) {
            events.push(event.data);
        }
        expect(events).toEqual(["first", "second"]);
    });

    test("validates delivered envelopes and can stop cleanly", async () => {
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
        let subscription:
            | SseSubscription<"Updated", 1, typeof payload>
            | undefined;
        const received: string[] = [];
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () =>
                sseResponse(
                    `id: 9\ndata: ${JSON.stringify({
                        id: "9",
                        type: "Updated",
                        version: 1,
                        occurredAt: "now",
                        payload: { value: "ok" },
                    })}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                ),
            onEvent: (event) => {
                received.push(event.payload.value);
                subscription?.stop();
            },
        });
        await subscription.start();
        expect(received).toEqual(["ok"]);
    });

    test("drops one invalid event and continues the same stream", async () => {
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
        const envelope = (id: string, value: string) =>
            JSON.stringify({
                id,
                type: "Updated",
                version: 1,
                occurredAt: "now",
                payload: { value },
            });
        const received: string[] = [];
        const errors: unknown[] = [];
        let fetches = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                return sseResponse(
                    `data: ${envelope("a", "A")}\n\ndata: invalid\n\ndata: ${envelope("b", "B")}\n\n`,
                );
            },
            onEvent: (event) => {
                received.push(event.payload.value);
                if (received.length === 2) subscription.stop();
            },
            onEventError: (error) => {
                errors.push(error);
            },
        });

        await subscription.start();
        expect(received).toEqual(["A", "B"]);
        expect(errors).toHaveLength(1);
        expect(fetches).toBe(1);
    });

    test("validates multiple event contracts and narrows by type", async () => {
        const textPayload = schema<{ value: string }>(
            (value): value is { value: string } =>
                typeof value === "object" &&
                value !== null &&
                typeof (value as { value?: unknown }).value === "string",
        );
        const countPayload = schema<{ count: number }>(
            (value): value is { count: number } =>
                typeof value === "object" &&
                value !== null &&
                typeof (value as { count?: unknown }).count === "number",
        );
        const contracts = createEventRegistry([
            defineEventContract({
                type: "player.updated",
                version: 1,
                payload: textPayload,
            }),
            defineEventContract({
                type: "queue.updated",
                version: 2,
                payload: countPayload,
            }),
        ]);
        const values: Array<string | number> = [];
        const errors: unknown[] = [];
        let subscription: SseSubscription<
            string,
            number,
            typeof textPayload,
            typeof contracts.contracts
        >;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contracts,
            fetch: async () =>
                sseResponse(
                    [
                        {
                            id: "1",
                            type: "player.updated",
                            version: 1,
                            occurredAt: "now",
                            payload: { value: "playing" },
                        },
                        {
                            id: "2",
                            type: "unknown",
                            version: 1,
                            occurredAt: "now",
                            payload: {},
                        },
                        {
                            id: "3",
                            type: "queue.updated",
                            version: 2,
                            occurredAt: "now",
                            payload: { count: 3 },
                        },
                    ]
                        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                        .join(""),
                ),
            onEvent: (event) => {
                if (event.type === "player.updated") {
                    values.push(event.payload.value);
                } else if (event.type === "queue.updated") {
                    values.push(event.payload.count);
                }
                if (values.length === 2) subscription.stop();
            },
            onEventError: (error) => {
                errors.push(error);
            },
        });

        await subscription.start();
        expect(values).toEqual(["playing", 3]);
        expect(errors).toHaveLength(1);
    });

    test("reports an empty data event as invalid JSON", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const errors: unknown[] = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse("data:\n\n"),
            waitForRetry: async () => {
                subscription.stop();
            },
            onEvent: () => {},
            onEventError: (error) => {
                errors.push(error);
            },
        });

        await subscription.start();
        expect(errors).toHaveLength(1);
    });

    test("uses the current retry time without exponential backoff", async () => {
        const payload = schema<{ value: string }>(
            (value): value is { value: string } =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const delays: number[] = [];
        let attempt = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            waitForRetry: async (delay) => {
                delays.push(delay);
                if (delays.length === 3) subscription.stop();
            },
            fetch: async () => {
                attempt++;
                if (attempt === 1) {
                    return sseResponse("retry: 5000\n\n");
                }
                throw new Error("offline");
            },
            onEvent: () => {},
        });

        await subscription.start();
        expect(delays).toEqual([5_000, 5_000, 5_000]);
    });

    test("applies a retry line ending at EOF without a newline", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const delays: number[] = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse("retry: 5000"),
            waitForRetry: async (delay) => {
                delays.push(delay);
                subscription.stop();
            },
            onEvent: () => {},
        });

        await subscription.start();
        expect(delays).toEqual([5_000]);
    });

    test("uses the default retry time before the server updates it", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const delays: number[] = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            waitForRetry: async (delay) => {
                delays.push(delay);
                subscription.stop();
            },
            fetch: async () => sseResponse(""),
            onEvent: () => {},
        });

        await subscription.start();
        expect(delays).toEqual([3_000]);
    });

    test("closes without reconnecting after HTTP 204", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                return new Response(null, { status: 204 });
            },
            waitForRetry: async () => {
                throw new Error("must not retry");
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        await subscription.start();
        expect(fetches).toBe(1);
        expect(states).toEqual(["connecting", "closed"]);
    });

    test("rejects and cancels non-200 HTTP responses", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const statuses = [201, 500];
        const states: string[] = [];
        let fetches = 0;
        let cancellations = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                const status = statuses[fetches];
                if (status === undefined) {
                    throw new Error("unexpected fetch");
                }
                fetches++;
                const body = new ReadableStream<Uint8Array>({
                    cancel: () => {
                        cancellations++;
                    },
                });
                return sseResponse(body, { status });
            },
            waitForRetry: async () => {
                if (fetches === statuses.length) subscription.stop();
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        await subscription.start();
        expect(fetches).toBe(2);
        expect(cancellations).toBe(2);
        expect(states).toEqual([
            "connecting",
            "error",
            "connecting",
            "error",
            "closed",
        ]);
    });

    test("reconnects without opening for missing and invalid content types", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let fetches = 0;
        let events = 0;
        let cancellations = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                const body = new ReadableStream<Uint8Array>({
                    cancel: () => {
                        cancellations++;
                    },
                });
                return new Response(
                    body,
                    fetches === 1
                        ? undefined
                        : { headers: { "content-type": "application/json" } },
                );
            },
            waitForRetry: async () => {
                if (fetches === 2) subscription.stop();
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {
                events++;
            },
        });

        await subscription.start();
        expect(fetches).toBe(2);
        expect(cancellations).toBe(2);
        expect(events).toBe(0);
        expect(states).toEqual([
            "connecting",
            "error",
            "connecting",
            "error",
            "closed",
        ]);
    });

    test("cancels an active response body when stopped", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let cancellations = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () =>
                sseResponse(
                    new ReadableStream<Uint8Array>({
                        cancel: () => {
                            cancellations++;
                        },
                    }),
                ),
            waitForRetry: async () => {
                throw new Error("must not retry");
            },
            onStateChange: (state) => {
                states.push(state);
                if (state === "open") subscription.stop();
            },
            onEvent: () => {},
        });

        await subscription.start();
        expect(cancellations).toBe(1);
        expect(states).toEqual(["connecting", "open", "closed"]);
    });

    test("cancels an accepted body when the open state hook fails", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let cancellations = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () =>
                sseResponse(
                    new ReadableStream<Uint8Array>({
                        cancel: () => {
                            cancellations++;
                        },
                    }),
                ),
            waitForRetry: async () => {
                subscription.stop();
            },
            onStateChange: (state) => {
                states.push(state);
                if (state === "open") throw new Error("hook failed");
            },
            onEvent: () => {},
        });

        await subscription.start();
        expect(cancellations).toBe(1);
        expect(states).toEqual(["connecting", "open", "error", "closed"]);
    });

    test("waits for an active event callback before allowing restart", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let cancellations = 0;
        let fetches = 0;
        let notifyEventStarted: (() => void) | undefined;
        let finishEvent: (() => void) | undefined;
        const eventStarted = new Promise<void>((resolve) => {
            notifyEventStarted = resolve;
        });
        const eventFinished = new Promise<void>((resolve) => {
            finishEvent = resolve;
        });
        const envelope = JSON.stringify({
            id: "1",
            type: "Updated",
            version: 1,
            occurredAt: "now",
            payload: {},
        });
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                if (fetches === 2) {
                    return new Response(null, { status: 204 });
                }
                return sseResponse(
                    new ReadableStream<Uint8Array>({
                        start: (controller) => {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `data: ${envelope}\n\n`,
                                ),
                            );
                        },
                        cancel: () => {
                            cancellations++;
                        },
                    }),
                );
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: async () => {
                notifyEventStarted?.();
                await eventFinished;
            },
        });

        const task = subscription.start();
        await eventStarted;
        subscription.stop();
        const repeatedStart = subscription.start();
        expect(repeatedStart).toBe(task);
        expect(states).toEqual(["connecting", "open"]);

        finishEvent?.();
        await task;

        expect(fetches).toBe(1);
        expect(cancellations).toBe(1);
        expect(states).toEqual(["connecting", "open", "closed"]);

        await subscription.start();
        expect(fetches).toBe(2);
        expect(states).toEqual([
            "connecting",
            "open",
            "closed",
            "connecting",
            "closed",
        ]);
    });

    test("does not start an event callback after stopping during validation", async () => {
        let notifyValidationStarted: (() => void) | undefined;
        let finishValidation: (() => void) | undefined;
        const validationStarted = new Promise<void>((resolve) => {
            notifyValidationStarted = resolve;
        });
        const validationFinished = new Promise<void>((resolve) => {
            finishValidation = resolve;
        });
        const payload: StandardSchemaV1<unknown, Record<string, never>> = {
            "~standard": {
                version: 1,
                vendor: "bot-kit-test",
                validate: async (value) => {
                    notifyValidationStarted?.();
                    await validationFinished;
                    return { value: value as Record<string, never> };
                },
            },
        };
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const envelope = JSON.stringify({
            id: "1",
            type: "Updated",
            version: 1,
            occurredAt: "now",
            payload: {},
        });
        const lastEventIds: Array<string | null> = [];
        const receivedEventIds: string[] = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) => {
                lastEventIds.push(
                    new Headers(init?.headers).get("last-event-id"),
                );
                fetches++;
                return fetches === 1
                    ? sseResponse(`id: 1\ndata: ${envelope}\n\n`)
                    : new Response(null, { status: 204 });
            },
            onEvent: (event) => {
                receivedEventIds.push(event.id);
            },
        });

        const task = subscription.start();
        await validationStarted;
        subscription.stop();
        finishValidation?.();
        await task;
        await subscription.start();

        expect(receivedEventIds).toEqual([]);
        expect(lastEventIds).toEqual([null, "1"]);
    });

    test("does not acknowledge a buffered event after stopping in a callback", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const firstEnvelope = JSON.stringify({
            id: "1",
            type: "Updated",
            version: 1,
            occurredAt: "now",
            payload: {},
        });
        const secondEnvelope = JSON.stringify({
            id: "2",
            type: "Updated",
            version: 1,
            occurredAt: "now",
            payload: {},
        });
        const lastEventIds: Array<string | null> = [];
        const receivedEventIds: string[] = [];
        let fetches = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) => {
                lastEventIds.push(
                    new Headers(init?.headers).get("last-event-id"),
                );
                fetches++;
                if (fetches === 2) {
                    return new Response(null, { status: 204 });
                }
                return sseResponse(
                    `id: 1\ndata: ${firstEnvelope}\n\nid: 2\ndata: ${secondEnvelope}\n\n`,
                );
            },
            onEvent: (event) => {
                receivedEventIds.push(event.id);
                subscription.stop();
            },
        });

        await subscription.start();
        await subscription.start();

        expect(receivedEventIds).toEqual(["1"]);
        expect(lastEventIds).toEqual([null, "1"]);
    });

    test("does not acknowledge an event stopped between reading and delivery", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const envelope = JSON.stringify({
            id: "1",
            type: "Updated",
            version: 1,
            occurredAt: "now",
            payload: {},
        });
        const lastEventIds: Array<string | null> = [];
        const receivedEventIds: string[] = [];
        let fetches = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) => {
                lastEventIds.push(
                    new Headers(init?.headers).get("last-event-id"),
                );
                fetches++;
                if (fetches === 2) {
                    return new Response(null, { status: 204 });
                }
                return sseResponse(
                    new ReadableStream<Uint8Array>(
                        {
                            pull: (controller) => {
                                controller.enqueue(
                                    new TextEncoder().encode(
                                        `id: 1\ndata: ${envelope}\n\n`,
                                    ),
                                );
                                subscription.stop();
                            },
                        },
                        { highWaterMark: 0 },
                    ),
                );
            },
            onEvent: (event) => {
                receivedEventIds.push(event.id);
            },
        });

        await subscription.start();
        await subscription.start();

        expect(receivedEventIds).toEqual([]);
        expect(lastEventIds).toEqual([null, null]);
    });

    test("does not open when stopped immediately after fetch resolves", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let cancellations = 0;
        let resolveFetch: ((response: Response) => void) | undefined;
        const fetchResponse = new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        });
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => fetchResponse,
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        const task = subscription.start();
        resolveFetch?.(
            sseResponse(
                new ReadableStream<Uint8Array>({
                    cancel: () => {
                        cancellations++;
                    },
                }),
            ),
        );
        subscription.stop();
        await task;

        expect(cancellations).toBe(1);
        expect(states).toEqual(["connecting", "closed"]);
    });

    test("does not fetch when stopped by a connection state hook", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let fetches = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                return new Response(null, { status: 204 });
            },
            onStateChange: (state) => {
                states.push(state);
                if (state === "connecting") subscription.stop();
            },
            onEvent: () => {},
        });

        await subscription.start();

        expect(fetches).toBe(0);
        expect(states).toEqual(["connecting", "closed"]);
    });

    test("does not open when stopped before fetch resolves", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let cancellations = 0;
        let resolveFetch: ((response: Response) => void) | undefined;
        const pendingResponse = new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        });
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => pendingResponse,
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        const task = subscription.start();
        subscription.stop();
        await task;

        expect(cancellations).toBe(0);
        expect(states).toEqual(["connecting", "closed"]);

        resolveFetch?.(
            sseResponse(
                new ReadableStream<Uint8Array>({
                    cancel: () => {
                        cancellations++;
                    },
                }),
            ),
        );
        await pendingResponse;
        await Promise.resolve();

        expect(cancellations).toBe(1);
    });

    test("cancels a response body when an event error hook fails", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let cancellations = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () =>
                sseResponse(
                    new ReadableStream<Uint8Array>({
                        start: (controller) => {
                            controller.enqueue(
                                new TextEncoder().encode("data: invalid\n\n"),
                            );
                        },
                        cancel: () => {
                            cancellations++;
                        },
                    }),
                ),
            waitForRetry: async () => {
                subscription.stop();
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
            onEventError: () => {
                throw new Error("hook failed");
            },
        });

        await subscription.start();
        expect(cancellations).toBe(1);
        expect(states).toEqual(["connecting", "open", "error", "closed"]);
    });

    test("stops while a custom retry wait ignores its signal", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        let notifyWaitStarted: (() => void) | undefined;
        const waitStarted = new Promise<void>((resolve) => {
            notifyWaitStarted = resolve;
        });
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(""),
            waitForRetry: async () => {
                notifyWaitStarted?.();
                await new Promise<void>(() => {});
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        const task = subscription.start();
        await waitStarted;
        subscription.stop();
        await task;

        expect(states).toEqual(["connecting", "open", "closed"]);
    });

    test("uses the latest server retry without default clamps", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const delays: number[] = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            waitForRetry: async (delay) => {
                delays.push(delay);
                subscription.stop();
            },
            fetch: async () =>
                sseResponse(
                    "retry: 5000\ndata: invalid\n\nretry: 600000\ndata: invalid\n\nretry: 2000\ndata: invalid\n\n",
                ),
            onEvent: () => {},
        });

        await subscription.start();
        expect(delays).toEqual([2_000]);
    });

    test("applies reconnect clamps only when explicitly configured", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const delays: number[] = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            maxRetryMs: 10_000,
            waitForRetry: async (delay) => {
                delays.push(delay);
                subscription.stop();
            },
            fetch: async () => sseResponse("retry: 600000\ndata: invalid\n\n"),
            onEvent: () => {},
        });

        await subscription.start();
        expect(delays).toEqual([10_000]);
    });

    test("applies full jitter only when explicitly enabled", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const delays: number[] = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            jitter: true,
            random: () => 0.5,
            waitForRetry: async (delay) => {
                delays.push(delay);
                subscription.stop();
            },
            fetch: async () => sseResponse("retry: 5000\ndata: invalid\n\n"),
            onEvent: () => {},
        });

        await subscription.start();
        expect(delays).toEqual([2_500]);
    });

    test("rejects an invalid jitter random value", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const states: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            jitter: true,
            random: () => 2,
            fetch: async () => sseResponse(""),
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        await expect(subscription.start()).rejects.toThrow(TypeError);
        expect(states).toEqual(["connecting", "open", "closed"]);
    });

    test("rejects invalid reconnect configuration", () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const create = (
            options: Partial<{
                retryMs: number;
                minRetryMs: number;
                maxRetryMs: number;
            }>,
        ) =>
            new SseSubscription({
                url: "https://example.test/events",
                contract,
                ...options,
                onEvent: () => {},
            });

        expect(() => create({ retryMs: -1 })).toThrow(TypeError);
        expect(() => create({ minRetryMs: -1 })).toThrow(TypeError);
        expect(() => create({ maxRetryMs: -1 })).toThrow(TypeError);
        expect(() => create({ retryMs: 2_147_483_648 })).toThrow(TypeError);
        expect(() => create({ minRetryMs: 2_147_483_648 })).toThrow(TypeError);
        expect(() => create({ maxRetryMs: 2_147_483_648 })).toThrow(TypeError);
        expect(() => create({ minRetryMs: 10_000, maxRetryMs: 500 })).toThrow(
            TypeError,
        );
    });

    test("acknowledges invalid event IDs before reconnecting", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const lastEventIds: Array<string | null> = [];
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) => {
                const headers = new Headers(init?.headers);
                lastEventIds.push(headers.get("last-event-id"));
                if (lastEventIds.length === 2) subscription.stop();
                return sseResponse("id: 123\ndata: invalid\n\n");
            },
            waitForRetry: async () => {},
            onEvent: () => {},
        });

        await subscription.start();
        expect(lastEventIds).toEqual([null, "123"]);
    });

    test("acknowledges an ID-only frame before reconnecting", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const lastEventIds: Array<string | null> = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) => {
                lastEventIds.push(
                    new Headers(init?.headers).get("last-event-id"),
                );
                fetches++;
                return fetches === 1
                    ? sseResponse("id: checkpoint\n\n")
                    : new Response(null, { status: 204 });
            },
            waitForRetry: async () => {},
            onEvent: () => {},
        });

        await subscription.start();
        expect(lastEventIds).toEqual([null, "checkpoint"]);
    });

    test("does not acknowledge an ID from an incomplete frame at EOF", async () => {
        const payload = schema<Record<string, never>>(
            (value): value is Record<string, never> =>
                typeof value === "object" && value !== null,
        );
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload,
        });
        const lastEventIds: Array<string | null> = [];
        let fetches = 0;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async (_input, init) => {
                lastEventIds.push(
                    new Headers(init?.headers).get("last-event-id"),
                );
                fetches++;
                return fetches === 1
                    ? sseResponse("id: incomplete\n")
                    : new Response(null, { status: 204 });
            },
            waitForRetry: async () => {},
            onEvent: () => {},
        });

        await subscription.start();
        expect(lastEventIds).toEqual([null, null]);
    });
});
