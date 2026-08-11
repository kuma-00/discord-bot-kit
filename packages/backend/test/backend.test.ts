import { describe, expect, test } from "bun:test";
import { defineHttpContract } from "@kuma-00/bot-kit-contracts";
import { objectSchema } from "../../../tests/schema.ts";
import {
    authenticateApiKey,
    defineRoute,
    executeRoute,
    healthResponse,
    type RouteResult,
    SseEventBroker,
} from "../src/index.ts";

describe("backend core", () => {
    test("parses multipart fields, repeated names, and files before schema validation", async () => {
        const contract = defineHttpContract({
            id: "upload",
            method: "POST",
            path: "/upload",
            requestBody: { encoding: "multipart/form-data", maxBytes: 2048 },
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        });
        const file = new File(["hello"], "hello.txt", { type: "text/plain" });
        const form = new FormData();
        form.set("title", "upload");
        form.append("tag", "one");
        form.append("tag", "two");
        form.set("file", file);
        let capturedInput: Record<string, unknown> | undefined;
        const response = await executeRoute(
            defineRoute({
                contract,
                handler: ({ input }) => {
                    capturedInput = input;
                    return { ok: true, data: input };
                },
            }),
            new Request("https://example.test/upload", {
                method: "POST",
                body: form,
            }),
            {},
        );
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.data.body.title).toBe("upload");
        expect(payload.data.body.tag).toEqual(["one", "two"]);
        const capturedFile = (capturedInput?.body as Record<string, unknown>)
            ?.file as File;
        expect(capturedFile.name).toBe("hello.txt");
    });

    test("returns safe 400 and 413 responses for invalid and oversized multipart input", async () => {
        const contract = defineHttpContract({
            id: "upload-limited",
            method: "POST",
            path: "/upload",
            requestBody: { encoding: "multipart/form-data", maxBytes: 4 },
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        });
        const route = defineRoute({
            contract,
            handler: ({ input }) => ({ ok: true, data: input }),
        });
        const invalid = await executeRoute(
            route,
            new Request("https://example.test/upload", {
                method: "POST",
                body: JSON.stringify({ body: {} }),
                headers: { "content-type": "application/json" },
            }),
            {},
        );
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({
            ok: false,
            error: { code: "invalid-multipart" },
        });

        const form = new FormData();
        form.set("value", "12345");
        const oversized = await executeRoute(
            route,
            new Request("https://example.test/upload", {
                method: "POST",
                body: form,
            }),
            {},
        );
        expect(oversized.status).toBe(413);
        expect(await oversized.json()).toMatchObject({
            ok: false,
            error: { code: "payload-too-large" },
        });
    });

    test("authenticates API keys without exposing the configured key", () => {
        const request = new Request("https://example.test");
        const result = authenticateApiKey(request, { apiKey: "secret" });
        expect(result?.error.code).toBe("unauthorized");
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    test("executes and validates a route", async () => {
        const contract = defineHttpContract({
            id: "echo",
            method: "POST",
            path: "/echo",
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        });
        const definition = defineRoute({
            contract,
            handler: ({ input }) => ({ ok: true, data: input }),
        });
        const response = await executeRoute(
            definition,
            new Request("https://example.test/echo"),
            { body: "ok" },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            ok: true,
            data: { body: "ok" },
        });
    });

    test("uses default and explicit handler statuses", async () => {
        const contract = defineHttpContract({
            id: "status",
            method: "POST",
            path: "/status",
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        });
        const request = new Request("https://example.test/status");
        const cases = [
            {
                result: { ok: true, data: { value: "ok" } } as const,
                status: 200,
            },
            {
                result: {
                    ok: true,
                    data: { value: "created" },
                    status: 201,
                } as const,
                status: 201,
            },
            {
                result: {
                    ok: false,
                    error: {
                        code: "invalid",
                        message: "Invalid",
                        details: {},
                    },
                } as const,
                status: 400,
            },
            {
                result: {
                    ok: false,
                    error: {
                        code: "missing",
                        message: "Missing",
                        details: {},
                    },
                    status: 404,
                } as const,
                status: 404,
            },
        ];
        for (const testCase of cases) {
            const response = await executeRoute(
                defineRoute({
                    contract,
                    handler: () => testCase.result,
                }),
                request,
                {},
            );
            expect(response.status).toBe(testCase.status);
            expect(await response.json()).not.toHaveProperty("status");
        }
    });

    test("requires failure details at compile time", () => {
        const result: RouteResult<Record<string, unknown>, object> = {
            ok: false,
            // @ts-expect-error Route failures require validated details.
            error: {
                code: "missing",
                message: "Missing",
            },
        };
        expect(result.ok).toBe(false);
    });

    test("validates failure details and safely maps invalid values", async () => {
        const contract = defineHttpContract({
            id: "failure-details",
            method: "GET",
            path: "/failure",
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        });
        const request = new Request("https://example.test/failure");
        const valid = await executeRoute(
            defineRoute({
                contract,
                handler: () => ({
                    ok: false,
                    status: 404,
                    error: {
                        code: "not-found",
                        message: "Not found",
                        details: { resource: "item" },
                    },
                }),
            }),
            request,
            {},
        );
        expect(valid.status).toBe(404);
        expect(await valid.json()).toEqual({
            ok: false,
            error: {
                code: "not-found",
                message: "Not found",
                details: { resource: "item" },
            },
        });

        const invalid = await executeRoute(
            defineRoute({
                contract,
                handler: () => ({
                    ok: false,
                    status: 422,
                    error: {
                        code: "invalid",
                        message: "Invalid",
                        details: "not-an-object" as unknown as Record<
                            string,
                            unknown
                        >,
                    },
                }),
            }),
            request,
            {},
        );
        expect(invalid.status).toBe(500);
        expect(await invalid.json()).toEqual({
            ok: false,
            error: {
                code: "internal-error",
                message: "Internal server error",
            },
        });
    });

    test("keeps validation failures behind the safe 500 response", async () => {
        const contract = defineHttpContract({
            id: "invalid-output",
            method: "GET",
            path: "/invalid",
            input: objectSchema,
            output: objectSchema,
            error: objectSchema,
        });
        const response = await executeRoute(
            defineRoute({
                contract,
                handler: () => ({
                    ok: true,
                    data: "invalid" as unknown as Record<string, unknown>,
                }),
            }),
            new Request("https://example.test/invalid"),
            {},
        );
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            ok: false,
            error: {
                code: "internal-error",
                message: "Internal server error",
            },
        });
    });

    test("provides health and SSE responses", async () => {
        const health = healthResponse(
            "test",
            () => new Date("2026-07-25T00:00:00Z"),
        );
        expect(await health.json()).toEqual({
            ok: true,
            data: {
                service: "test",
                status: "ok",
                timestamp: "2026-07-25T00:00:00.000Z",
            },
        });
        const broker = new SseEventBroker();
        const response = broker.response();
        const reader = response.body?.getReader();
        const read = reader?.read();
        broker.publish({ id: "1", data: { ok: true } });
        const chunk = await read;
        expect(new TextDecoder().decode(chunk?.value)).toContain("id: 1");
        await reader?.cancel();
    });
});
