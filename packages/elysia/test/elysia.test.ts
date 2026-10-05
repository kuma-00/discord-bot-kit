import { describe, expect, test } from "bun:test";
import { defineRoute, SseEventBroker } from "@kuma-00/bot-kit-backend";
import {
    createAccessFailure,
    defineHttpContract,
} from "@kuma-00/bot-kit-contracts";
import { objectSchema } from "../../../tests/schema.ts";
import { HttpClient } from "../../transport/src/index.ts";
import { createElysiaApp } from "../src/index.ts";

describe("Elysia adapter", () => {
    test("handles multipart routes end-to-end through HttpClient and disables Elysia parsing", async () => {
        const route = defineRoute({
            contract: defineHttpContract({
                id: "upload",
                method: "POST",
                path: "/upload",
                requestBody: { encoding: "multipart/form-data" },
                input: objectSchema,
                output: objectSchema,
                error: objectSchema,
            }),
            handler: ({ input }) => ({ ok: true, data: input }),
        });
        const app = createElysiaApp({
            service: "multipart-test",
            routes: [route],
        });
        const client = new HttpClient({
            baseUrl: "https://example.test",
            fetch: (input, init) => app.handle(new Request(input, init)),
        });
        const result = await client.request(route.contract, {
            body: {
                title: "from-client",
                attachment: new File(["data"], "data.txt"),
            },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            const body = result.data.body as Record<string, unknown>;
            expect(body.title).toBe("from-client");
            expect(body.attachment).toBeDefined();
        }
    });

    test("mounts health and authenticated contract routes", async () => {
        const route = defineRoute({
            contract: defineHttpContract({
                id: "echo",
                method: "POST",
                path: "/echo/:id",
                input: objectSchema,
                output: objectSchema,
                error: objectSchema,
            }),
            handler: ({ input, params }) => ({
                ok: true,
                data: { ...input, routeId: params.id },
            }),
        });
        const app = createElysiaApp({
            service: "adapter-test",
            apiKey: { apiKey: "key" },
            routes: [route],
        });
        expect(
            (
                await app
                    .handle(new Request("https://example.test/healthz"))
                    .then((response) => response.json())
            ).data.status,
        ).toBe("ok");
        const unauthorized = await app.handle(
            new Request("https://example.test/echo/1", {
                method: "POST",
                body: JSON.stringify({ value: "ok" }),
                headers: { "content-type": "application/json" },
            }),
        );
        expect(unauthorized.status).toBe(401);
        const authorized = await app.handle(
            new Request("https://example.test/echo/1", {
                method: "POST",
                body: JSON.stringify({ value: "ok" }),
                headers: {
                    "content-type": "application/json",
                    "x-api-key": "key",
                },
            }),
        );
        expect(await authorized.json()).toEqual({
            ok: true,
            data: {
                params: { id: "1" },
                query: {},
                body: { value: "ok" },
                routeId: "1",
            },
        });
    });
});

test("SSE response factory authorizes params before creating scoped subscriptions", async () => {
    const broker = new SseEventBroker();
    const app = createElysiaApp({
        service: "scoped-test",
        apiKey: { apiKey: "key" },
        sse: {
            path: "/events/:scope",
            responseFactory: ({ request, params }) => {
                if (params.scope !== "allowed")
                    return createAccessFailure("forbidden");
                return broker.responseFor(params.scope, request.signal);
            },
        },
    });
    const unauthorized = await app.handle(
        new Request("https://example.test/events/allowed"),
    );
    expect(unauthorized.status).toBe(401);
    expect(broker.subscriberCount).toBe(0);
    const denied = await app.handle(
        new Request("https://example.test/events/denied", {
            headers: { "x-api-key": "key" },
        }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(createAccessFailure("forbidden"));
    expect(broker.subscriberCount).toBe(0);
    expect(broker.scopeCount).toBe(0);
    const response = await app.handle(
        new Request("https://example.test/events/allowed", {
            headers: { "x-api-key": "key" },
        }),
    );
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Missing SSE body");
    const reader = response.body.getReader();
    broker.publishTo("denied", { id: "wrong", data: {} });
    broker.publishTo("allowed", { id: "right", data: {} });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "right",
    );
    await reader.cancel();
    expect(broker.scopeCount).toBe(0);
});

test("consumer access check uses the same 403 contract before HTTP handlers and SSE factories", async () => {
    let executions = 0;
    const route = defineRoute({
        contract: defineHttpContract({
            id: "protected",
            method: "GET",
            path: "/protected/:id",
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        }),
        handler: () => {
            executions++;
            return { ok: true, data: {} };
        },
    });
    const broker = new SseEventBroker();
    const app = createElysiaApp({
        service: "access-test",
        routes: [route],
        authorize: ({ params }) =>
            params.id === "denied"
                ? createAccessFailure("forbidden")
                : undefined,
        sse: {
            path: "/events/:id",
            responseFactory: ({ request, params }) => {
                executions++;
                return broker.responseFor(params.id ?? "", request.signal);
            },
        },
    });
    const client = new HttpClient({
        baseUrl: "https://example.test",
        fetch: (input, init) => app.handle(new Request(input, init)),
    });
    expect(
        await client.request(route.contract, { params: { id: "denied" } }),
    ).toEqual({
        ok: false,
        error: {
            code: "forbidden",
            message: "Forbidden",
            details: { kind: "http", status: 403 },
        },
    });
    expect(
        (await app.handle(new Request("https://example.test/events/denied")))
            .status,
    ).toBe(403);
    expect(executions).toBe(0);
    expect(broker.subscriberCount).toBe(0);
});

test("legacy Elysia broker configuration still supports global delivery", async () => {
    const broker = new SseEventBroker();
    const app = createElysiaApp({
        service: "legacy-test",
        sse: { path: "/events", broker },
    });
    const response = await app.handle(
        new Request("https://example.test/events"),
    );
    if (!response.body) throw new Error("Missing SSE body");
    const reader = response.body.getReader();
    broker.publish({ id: "legacy", data: {} });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "legacy",
    );
    await reader.cancel();
    expect(broker.subscriberCount).toBe(0);
});

test("contains authorization and SSE factory exceptions in the safe backend boundary", async () => {
    const privateError = new Error("private connection credential");
    const route = defineRoute({
        contract: defineHttpContract({
            id: "safe",
            method: "GET",
            path: "/safe",
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        }),
        handler: () => ({ ok: true, data: {} }),
    });
    for (const callback of [
        "http-authorize",
        "sse-authorize",
        "sse-factory",
    ] as const) {
        const logged: unknown[] = [];
        const broker = new SseEventBroker();
        const app = createElysiaApp({
            service: "safe-errors",
            routes: [route],
            ...(callback === "sse-factory"
                ? {}
                : {
                      authorize: async () => {
                          throw privateError;
                      },
                  }),
            sse: {
                path: "/events",
                responseFactory: async ({ request }) => {
                    if (callback === "sse-factory") throw privateError;
                    return broker.response(request.signal);
                },
            },
            logger: {
                error: (_message, context) => {
                    logged.push(context?.error);
                },
            },
        });
        const path = callback === "http-authorize" ? "/safe" : "/events";
        const response = await app.handle(
            new Request(`https://example.test${path}`),
        );
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            ok: false,
            error: { code: "internal-error", message: "Internal server error" },
        });
        expect(logged).toEqual([privateError]);
        expect(broker.subscriberCount).toBe(0);
        const client = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async () =>
                app.handle(new Request(`https://example.test${path}`)),
        });
        const result = await client.request(route.contract, {});
        expect(result).toMatchObject({
            ok: false,
            error: {
                code: "invalid-error-response",
                details: { kind: "invalid-response", status: 500 },
            },
        });
    }
});
