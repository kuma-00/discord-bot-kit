import { describe, expect, test } from "bun:test";
import {
    createEventRegistry,
    defineEventContract,
    defineHttpContract,
} from "@kuma-00/bot-kit-contracts";
import { schema } from "../../../tests/schema.ts";
import { HttpClient, SseSubscription } from "../src/index.ts";

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
const optionalErrorSchema = schema<{ reason: string } | undefined>(
    (value): value is { reason: string } | undefined =>
        value === undefined ||
        (typeof value === "object" &&
            value !== null &&
            typeof (value as { reason?: unknown }).reason === "string"),
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
                return Response.json({ ok: true, data: { id: "42" } });
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
            fetch: async () =>
                Response.json(
                    {
                        ok: false,
                        error: {
                            code: "declined",
                            message: "No",
                            details: { reason: "no" },
                        },
                    },
                    { status: 400 },
                ),
        });
        expect(await typed.request(route, { params: { id: "1" } })).toEqual({
            ok: false,
            error: {
                code: "declined",
                message: "No",
                details: { reason: "no" },
            },
        });
        const invalid = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async () =>
                Response.json({ ok: true, data: { unexpected: true } }),
        });
        const result = await invalid.request(route, { params: { id: "1" } });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("invalid-response");
    });

    test("rejects malformed and mismatched API envelopes", async () => {
        const cases: Array<
            [string, Response, "invalid-response" | "invalid-error-response"]
        > = [
            [
                "malformed success JSON",
                new Response("not-json"),
                "invalid-response",
            ],
            [
                "invalid success envelope",
                Response.json({ ok: false, error: {} }),
                "invalid-response",
            ],
            [
                "invalid error envelope",
                Response.json({ ok: true, data: { id: "1" } }, { status: 400 }),
                "invalid-error-response",
            ],
            [
                "invalid error details",
                Response.json(
                    {
                        ok: false,
                        error: { code: "x", message: "X", details: {} },
                    },
                    { status: 400 },
                ),
                "invalid-error-response",
            ],
        ];
        for (const [, response, code] of cases) {
            const client = new HttpClient({
                baseUrl: "https://example.test",
                fetch: async () => response,
            });
            const result = await client.request(route, { params: { id: "1" } });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe(code);
                expect(result.error.details).toMatchObject({
                    kind: "invalid-response",
                    status: code === "invalid-error-response" ? 400 : 200,
                });
            }
        }
    });

    test("validates success data separately from its envelope", async () => {
        const client = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async () => Response.json({ ok: true, data: { id: 1 } }),
        });
        const result = await client.request(route, { params: { id: "1" } });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("invalid-response");
    });

    test("accepts failure envelopes without details when the contract allows undefined", async () => {
        const optionalRoute = defineHttpContract({
            ...route,
            error: optionalErrorSchema,
        });
        const client = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async () =>
                Response.json(
                    { ok: false, error: { code: "empty", message: "Empty" } },
                    { status: 400 },
                ),
        });
        expect(
            await client.request(optionalRoute, { params: { id: "1" } }),
        ).toEqual({
            ok: false,
            error: { code: "empty", message: "Empty", details: undefined },
        });
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

describe("SseSubscription", () => {
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
    const envelope = JSON.stringify({
        id: "event-1",
        type: "Updated",
        version: 1,
        occurredAt: "2026-07-27T00:00:00.000Z",
        payload: { value: "ok" },
    });
    const sseResponse = (body: string): Response =>
        new Response(body, {
            headers: { "content-type": "text/event-stream" },
        });

    test("validates standard message events and closes synchronously", async () => {
        const states: string[] = [];
        let resolveReceived: (() => void) | undefined;
        const received = new Promise<void>((resolve) => {
            resolveReceived = resolve;
        });
        const values: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(`data: ${envelope}\n\n`),
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: (event) => {
                values.push(event.payload.value);
                subscription.stop();
                resolveReceived?.();
            },
        });

        subscription.start();
        await received;

        expect(values).toEqual(["ok"]);
        expect(states).toEqual(["connecting", "open", "connecting", "closed"]);
        expect(subscription.readyState).toBe(2);
    });

    test("receives named events for registered contract types", async () => {
        const registry = createEventRegistry([contract] as const);
        let resolveReceived: (() => void) | undefined;
        const received = new Promise<void>((resolve) => {
            resolveReceived = resolve;
        });
        let subscription: SseSubscription<
            string,
            number,
            typeof payload,
            typeof registry.contracts
        >;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contracts: registry,
            fetch: async () =>
                sseResponse(`event: Updated\ndata: ${envelope}\n\n`),
            onEvent: () => {
                subscription.stop();
                resolveReceived?.();
            },
        });

        subscription.start();
        await received;
        expect(subscription.readyState).toBe(2);
    });

    test("separates open and error contracts from lifecycle events", async () => {
        const openContract = defineEventContract({
            type: "open",
            version: 1,
            payload,
        });
        const errorContract = defineEventContract({
            type: "error",
            version: 1,
            payload,
        });
        const registry = createEventRegistry([
            openContract,
            errorContract,
        ] as const);
        const openEnvelope = JSON.stringify({
            ...JSON.parse(envelope),
            type: "open",
        });
        const errorEnvelope = JSON.stringify({
            ...JSON.parse(envelope),
            type: "error",
        });
        const receivedTypes: string[] = [];
        const states: string[] = [];
        let resolveReceived: (() => void) | undefined;
        const received = new Promise<void>((resolve) => {
            resolveReceived = resolve;
        });
        let subscription: SseSubscription<
            string,
            number,
            typeof payload,
            typeof registry.contracts
        >;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contracts: registry,
            fetch: async () =>
                sseResponse(
                    `event: open\ndata: ${openEnvelope}\n\nevent: error\ndata: ${errorEnvelope}\n\n`,
                ),
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: (event) => {
                receivedTypes.push(event.type);
                if (receivedTypes.length === 2) {
                    subscription.stop();
                    resolveReceived?.();
                }
            },
        });

        subscription.start();
        await received;

        expect(receivedTypes).toEqual(["open", "error"]);
        expect(states).toEqual(["connecting", "open", "connecting", "closed"]);
    });

    test("adds custom headers without replacing EventSource headers", async () => {
        let captured: Request | undefined;
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            headers: { authorization: "Bearer token" },
            fetch: async (input, init) => {
                captured = new Request(input, init);
                return new Response(null, { status: 204 });
            },
            onEvent: () => {},
        });

        subscription.start();
        await Bun.sleep(0);

        expect(captured?.headers.get("accept")).toBe("text/event-stream");
        expect(captured?.headers.get("authorization")).toBe("Bearer token");
        expect(subscription.readyState).toBe(2);
    });

    test("reports individual event validation failures", async () => {
        let resolveRejected: (() => void) | undefined;
        const rejected = new Promise<void>((resolve) => {
            resolveRejected = resolve;
        });
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse("data: not-json\n\n"),
            onEvent: () => {},
            onEventError: (_error, event) => {
                expect(event.data).toBe("not-json");
                subscription.stop();
                resolveRejected?.();
            },
        });

        subscription.start();
        await rejected;
    });

    test("does not connect when stopped by the connecting state hook", async () => {
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

        subscription.start();
        await Bun.sleep(0);

        expect(fetches).toBe(0);
        expect(states).toEqual(["connecting", "closed"]);
        expect(subscription.readyState).toBe(2);
    });

    test("discards a connection stopped synchronously by custom fetch", async () => {
        const states: string[] = [];
        let fetches = 0;
        let subscription: SseSubscription<"Updated", 1, typeof payload>;
        subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => {
                fetches++;
                subscription.stop();
                return new Response(null, { status: 204 });
            },
            onStateChange: (state) => {
                states.push(state);
            },
            onEvent: () => {},
        });

        subscription.start();
        await Bun.sleep(0);

        expect(fetches).toBe(1);
        expect(states).toEqual(["connecting", "closed"]);
        expect(subscription.readyState).toBe(2);
    });

    test("contains rejected event callbacks and error handlers", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on("unhandledRejection", onUnhandled);
        try {
            let resolveReported: (() => void) | undefined;
            const reported = new Promise<void>((resolve) => {
                resolveReported = resolve;
            });
            const subscription = new SseSubscription({
                url: "https://example.test/events",
                contract,
                fetch: async () => sseResponse(`data: ${envelope}\n\n`),
                onEvent: async () => {
                    throw new Error("event failed");
                },
                onEventError: async () => {
                    resolveReported?.();
                    throw new Error("error handler failed");
                },
            });

            subscription.start();
            await reported;
            await Bun.sleep(0);
            subscription.stop();

            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    test("contains synchronous and asynchronous state callback failures", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on("unhandledRejection", onUnhandled);
        try {
            let resolveReceived: (() => void) | undefined;
            const received = new Promise<void>((resolve) => {
                resolveReceived = resolve;
            });
            const subscription = new SseSubscription({
                url: "https://example.test/events",
                contract,
                fetch: async () => sseResponse(`data: ${envelope}\n\n`),
                onStateChange: (state) => {
                    if (state === "connecting")
                        throw new Error("synchronous state failure");
                    return Promise.reject(
                        new Error("asynchronous state failure"),
                    );
                },
                onEvent: () => {
                    subscription.stop();
                    resolveReceived?.();
                },
            });

            subscription.start();
            await received;
            await Bun.sleep(0);

            expect(unhandled).toEqual([]);
            expect(subscription.readyState).toBe(2);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    test("reports an event callback failure after the callback stops delivery", async () => {
        let resolveReported: (() => void) | undefined;
        const reported = new Promise<void>((resolve) => {
            resolveReported = resolve;
        });
        const errors: unknown[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(`data: ${envelope}\n\n`),
            onEvent: () => {
                subscription.stop();
                throw new Error("event failed after stop");
            },
            onEventError: (error) => {
                errors.push(error);
                resolveReported?.();
            },
        });

        subscription.start();
        await reported;

        expect(errors).toHaveLength(1);
        expect(subscription.readyState).toBe(2);
    });

    test("does not deliver an event from a stopped subscription generation", async () => {
        let resolveValidationStarted: (() => void) | undefined;
        const validationStarted = new Promise<void>((resolve) => {
            resolveValidationStarted = resolve;
        });
        let resolveValidation: (() => void) | undefined;
        const validation = new Promise<void>((resolve) => {
            resolveValidation = resolve;
        });
        const asyncPayload = {
            "~standard": {
                version: 1 as const,
                vendor: "bot-kit-test",
                validate: async (value: unknown) => {
                    resolveValidationStarted?.();
                    await validation;
                    return {
                        value: value as { value: string },
                    };
                },
            },
        };
        const asyncContract = defineEventContract({
            type: "Updated",
            version: 1,
            payload: asyncPayload,
        });
        let fetches = 0;
        const delivered: string[] = [];
        const errors: unknown[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract: asyncContract,
            fetch: async () => {
                fetches++;
                return fetches === 1
                    ? sseResponse(`data: ${envelope}\n\n`)
                    : new Response(null, { status: 204 });
            },
            onEvent: (event) => {
                delivered.push(event.payload.value);
            },
            onEventError: (error) => {
                errors.push(error);
            },
        });

        subscription.start();
        await validationStarted;
        subscription.stop();
        subscription.start();
        resolveValidation?.();
        await Bun.sleep(0);

        expect(fetches).toBe(2);
        expect(delivered).toEqual([]);
        expect(errors).toEqual([]);
        subscription.stop();
    });

    test("serializes application delivery in receive order", async () => {
        const body = ["A", "B", "C"]
            .map(
                (value) =>
                    `data: ${JSON.stringify({
                        ...JSON.parse(envelope),
                        id: value,
                        payload: { value },
                    })}\n\n`,
            )
            .join("");
        let releaseA: (() => void) | undefined;
        const aGate = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        let resolveStartedA: (() => void) | undefined;
        const startedA = new Promise<void>((resolve) => {
            resolveStartedA = resolve;
        });
        let resolveCompleted: (() => void) | undefined;
        const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
        });
        const order: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(body),
            onEvent: async (event) => {
                const value = event.payload.value;
                order.push(`${value} start`);
                if (value === "A") {
                    resolveStartedA?.();
                    await aGate;
                }
                order.push(`${value} end`);
                if (value === "C") {
                    subscription.stop();
                    resolveCompleted?.();
                }
            },
        });

        subscription.start();
        await startedA;
        await Bun.sleep(0);
        expect(order).toEqual(["A start"]);
        releaseA?.();
        await completed;

        expect(order).toEqual([
            "A start",
            "A end",
            "B start",
            "B end",
            "C start",
            "C end",
        ]);
    });

    test("continues serial delivery after validation failure", async () => {
        const valid = (value: string) =>
            JSON.stringify({
                ...JSON.parse(envelope),
                id: value,
                payload: { value },
            });
        const body = `data: ${valid("A")}\n\ndata: not-json\n\ndata: ${valid("C")}\n\n`;
        let resolveCompleted: (() => void) | undefined;
        const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
        });
        const order: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(body),
            onEvent: (event) => {
                order.push(`event ${event.payload.value}`);
                if (event.payload.value === "C") {
                    subscription.stop();
                    resolveCompleted?.();
                }
            },
            onEventError: () => {
                order.push("error B");
            },
        });

        subscription.start();
        await completed;

        expect(order).toEqual(["event A", "error B", "event C"]);
    });

    test("continues serial delivery after onEvent rejects", async () => {
        const body = ["A", "B"]
            .map(
                (value) =>
                    `data: ${JSON.stringify({
                        ...JSON.parse(envelope),
                        id: value,
                        payload: { value },
                    })}\n\n`,
            )
            .join("");
        let resolveCompleted: (() => void) | undefined;
        const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
        });
        const order: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(body),
            onEvent: async (event) => {
                order.push(`event ${event.payload.value}`);
                if (event.payload.value === "A")
                    throw new Error("A handler failed");
                subscription.stop();
                resolveCompleted?.();
            },
            onEventError: () => {
                order.push("error A");
            },
        });

        subscription.start();
        await completed;

        expect(order).toEqual(["event A", "error A", "event B"]);
    });

    test("continues delivery when onEventError rejects", async () => {
        const body = `data: not-json\n\ndata: ${envelope}\n\n`;
        let resolveCompleted: (() => void) | undefined;
        const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
        });
        const delivered: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(body),
            onEvent: (event) => {
                delivered.push(event.payload.value);
                subscription.stop();
                resolveCompleted?.();
            },
            onEventError: async () => {
                throw new Error("error callback failed");
            },
        });

        subscription.start();
        await completed;

        expect(delivered).toEqual(["ok"]);
    });

    test("drops queued events from a stopped lifecycle", async () => {
        const body = ["A", "B"]
            .map(
                (value) =>
                    `data: ${JSON.stringify({
                        ...JSON.parse(envelope),
                        id: value,
                        payload: { value },
                    })}\n\n`,
            )
            .join("");
        let releaseA: (() => void) | undefined;
        const aGate = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        let resolveStartedA: (() => void) | undefined;
        const startedA = new Promise<void>((resolve) => {
            resolveStartedA = resolve;
        });
        let resolveFinishedA: (() => void) | undefined;
        const finishedA = new Promise<void>((resolve) => {
            resolveFinishedA = resolve;
        });
        const delivered: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () => sseResponse(body),
            onEvent: async (event) => {
                delivered.push(`${event.payload.value} start`);
                if (event.payload.value === "A") {
                    resolveStartedA?.();
                    await aGate;
                    delivered.push("A end");
                    resolveFinishedA?.();
                }
            },
        });

        subscription.start();
        await startedA;
        subscription.stop();
        releaseA?.();
        await finishedA;
        await Bun.sleep(0);

        expect(delivered).toEqual(["A start", "A end"]);
    });

    test("does not overlap delivery across stop and restart", async () => {
        const eventFor = (value: string) =>
            `data: ${JSON.stringify({
                ...JSON.parse(envelope),
                id: value,
                payload: { value },
            })}\n\n`;
        let releaseA: (() => void) | undefined;
        const aGate = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        let resolveStartedA: (() => void) | undefined;
        const startedA = new Promise<void>((resolve) => {
            resolveStartedA = resolve;
        });
        let resolveCompleted: (() => void) | undefined;
        const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
        });
        let fetches = 0;
        const order: string[] = [];
        const subscription = new SseSubscription({
            url: "https://example.test/events",
            contract,
            fetch: async () =>
                sseResponse(eventFor(++fetches === 1 ? "A" : "B")),
            onEvent: async (event) => {
                const value = event.payload.value;
                order.push(`${value} start`);
                if (value === "A") {
                    resolveStartedA?.();
                    await aGate;
                }
                order.push(`${value} end`);
                if (value === "B") {
                    subscription.stop();
                    resolveCompleted?.();
                }
            },
        });

        subscription.start();
        await startedA;
        subscription.stop();
        subscription.start();
        await Bun.sleep(0);
        expect(order).toEqual(["A start"]);
        releaseA?.();
        await completed;

        expect(order).toEqual(["A start", "A end", "B start", "B end"]);
    });

    test("requires exactly one contract source", () => {
        expect(
            () =>
                new SseSubscription({
                    url: "https://example.test/events",
                    onEvent: () => {},
                }),
        ).toThrow(TypeError);
        expect(
            () =>
                new SseSubscription({
                    url: "https://example.test/events",
                    contract,
                    contracts: createEventRegistry([contract]),
                    onEvent: () => {},
                }),
        ).toThrow(TypeError);
    });
});
