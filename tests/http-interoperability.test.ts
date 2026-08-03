import { describe, expect, test } from "bun:test";
import { defineRoute, executeRoute } from "../packages/backend/src/index.ts";
import { defineHttpContract } from "../packages/contracts/src/index.ts";
import { HttpClient } from "../packages/transport/src/index.ts";
import { schema } from "./schema.ts";

const input = schema<{ body: { mode: string } }>(
    (value): value is { body: { mode: string } } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { body?: unknown }).body === "object" &&
        (value as { body: { mode?: unknown } }).body !== null &&
        typeof (value as { body: { mode?: unknown } }).body.mode === "string",
);
const output = schema<{ value: string }>(
    (value): value is { value: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { value?: unknown }).value === "string",
);
const error = schema<{ reason: string }>(
    (value): value is { reason: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { reason?: unknown }).reason === "string",
);
const contract = defineHttpContract({
    id: "interop",
    method: "POST",
    path: "/interop",
    input,
    output,
    error,
});
const route = defineRoute({
    contract,
    handler: ({ input: requestInput }) => {
        if (requestInput.body.mode === "failure") {
            return {
                ok: false as const,
                error: {
                    code: "declined",
                    message: "Declined",
                    details: { reason: "not allowed" },
                },
                status: 422,
            };
        }
        if (requestInput.body.mode === "invalid-output") {
            return {
                ok: true as const,
                data: { value: 123 as unknown as string },
            };
        }
        return { ok: true as const, data: { value: "accepted" } };
    },
});

const backendFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> => {
    const request = new Request(input, init);
    return executeRoute(route, request, {
        body: await request.clone().json(),
    });
};

describe("HTTP backend/transport interoperability", () => {
    const client = new HttpClient({
        baseUrl: "https://example.test",
        fetch: backendFetch,
    });

    test("round-trips backend success and declared failure envelopes", async () => {
        expect(
            await client.request(contract, { body: { mode: "accepted" } }),
        ).toEqual({
            ok: true,
            data: { value: "accepted" },
        });

        const failureClient = new HttpClient({
            baseUrl: "https://example.test",
            fetch: backendFetch,
        });
        expect(
            await failureClient.request(contract, {
                body: { mode: "failure" },
            }),
        ).toEqual({
            ok: false,
            error: {
                code: "declined",
                message: "Declined",
                details: { reason: "not allowed" },
            },
        });
    });

    test("maps invalid backend output and safe 500 to invalid-error-response", async () => {
        const invalidClient = new HttpClient({
            baseUrl: "https://example.test",
            fetch: backendFetch,
        });
        const result = await invalidClient.request(contract, {
            body: { mode: "invalid-output" },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("invalid-error-response");
            expect(result.error.details).toMatchObject({
                kind: "invalid-response",
                status: 500,
            });
        }
    });
});
