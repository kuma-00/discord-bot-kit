import { describe, expect, test } from "bun:test";
import { defineRoute } from "@kuma-00/bot-kit-backend";
import { defineHttpContract } from "@kuma-00/bot-kit-contracts";
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
