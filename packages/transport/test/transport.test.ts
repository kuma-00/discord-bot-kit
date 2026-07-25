import { describe, expect, test } from "bun:test";
import {
    defineEventContract,
    defineHttpContract,
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
    test("parses frames split across arbitrary chunks", async () => {
        async function* chunks() {
            yield "id: 1\nevent: Up";
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
            },
        ]);
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
                new Response(
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
});
