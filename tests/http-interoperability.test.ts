import { describe, expect, test } from "bun:test";
import {
    accessFailureResponse,
    authenticateApiKey,
    defineRoute,
    executeRoute,
} from "../packages/backend/src/index.ts";
import {
    createAccessFailure,
    defineHttpContract,
} from "../packages/contracts/src/index.ts";
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

const multipartContract = defineHttpContract({
    id: "interop-upload",
    method: "POST",
    path: "/interop-upload",
    requestBody: { encoding: "multipart/form-data", maxBytes: 32 },
    input: schema<{ body?: Record<string, unknown> }>(
        (value): value is { body?: Record<string, unknown> } =>
            typeof value === "object" && value !== null,
    ),
    output,
    error,
});
const multipartRoute = defineRoute({
    contract: multipartContract,
    handler: ({ input }) => ({
        ok: true as const,
        data: { value: String(input.body?.value ?? "") },
    }),
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

    test("preserves backend payload-too-large through the client", async () => {
        const uploadClient = new HttpClient({
            baseUrl: "https://example.test",
            fetch: async (input, init) => {
                const request = new Request(input, init);
                return executeRoute(multipartRoute, request, {});
            },
        });
        const result = await uploadClient.request(multipartContract, {
            body: { value: "x".repeat(128) },
        });
        expect(result).toEqual({
            ok: false,
            error: {
                code: "payload-too-large",
                message: "Request payload is too large",
                details: { kind: "http", status: 413 },
            },
        });
    });

    test("passes standard access failures through without domain error validation", async () => {
        for (const code of ["unauthorized", "forbidden"] as const) {
            const response = accessFailureResponse(createAccessFailure(code));
            const accessClient = new HttpClient({
                baseUrl: "https://example.test",
                fetch: async () => response,
            });
            expect(
                await accessClient.request(contract, {
                    body: { mode: "accepted" },
                }),
            ).toEqual({
                ok: false,
                error: {
                    code,
                    message:
                        code === "unauthorized" ? "Unauthorized" : "Forbidden",
                    details: {
                        kind: "http",
                        status: code === "unauthorized" ? 401 : 403,
                    },
                },
            });
        }
    });

    test("API key authentication returns a standard unauthorized response", async () => {
        const failure = authenticateApiKey(
            new Request("https://example.test", {
                headers: { "x-api-key": "bad" },
            }),
            { apiKey: "secret" },
        );
        expect(failure).toEqual(createAccessFailure("unauthorized"));
        if (!failure) throw new Error("Expected authentication failure");
        const response = accessFailureResponse(failure);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual(
            createAccessFailure("unauthorized"),
        );
    });

    test("rejects forged access markers, status mismatches, and details", async () => {
        const cases = [
            {
                status: 401,
                error: { kind: "access", code: "declined", message: "No" },
            },
            {
                status: 403,
                error: { kind: "access", code: "unauthorized", message: "No" },
            },
            {
                status: 401,
                error: {
                    kind: "access",
                    code: "unauthorized",
                    message: "No",
                    details: {},
                },
            },
        ];
        for (const value of cases) {
            const forgedClient = new HttpClient({
                baseUrl: "https://example.test",
                fetch: async () =>
                    Response.json(
                        { ok: false, error: value.error },
                        { status: value.status },
                    ),
            });
            const result = await forgedClient.request(contract, {
                body: { mode: "accepted" },
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(result.error.code).toBe("invalid-error-response");
        }
    });
});
