import { describe, expect, test } from "bun:test";
import { defineHttpContract } from "@kuma-00/bot-kit-contracts";
import { objectSchema } from "../../../tests/schema.ts";
import {
    authenticateApiKey,
    defineRoute,
    executeRoute,
    healthResponse,
    SseEventBroker,
} from "../src/index.ts";

describe("backend core", () => {
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
