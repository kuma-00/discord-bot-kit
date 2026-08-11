import { describe, expect, test } from "bun:test";
import { schema } from "../../../tests/schema.ts";
import {
    ContractValidationError,
    defineEventContract,
    defineHttpContract,
    parseEventEnvelope,
} from "../src/index.ts";

const payloadSchema = schema<{ value: string }>(
    (value): value is { value: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { value?: unknown }).value === "string",
);

describe("contracts", () => {
    test("preserves HTTP contract metadata", () => {
        const contract = defineHttpContract({
            id: "health",
            method: "GET",
            path: "/healthz",
            input: payloadSchema,
            output: payloadSchema,
            error: payloadSchema,
        });
        expect(contract.id).toBe("health");
        expect(contract.method).toBe("GET");
    });

    test("preserves multipart request-body metadata and defaults omitted encoding", () => {
        const multipart = defineHttpContract({
            id: "upload",
            method: "POST",
            path: "/upload",
            requestBody: { encoding: "multipart/form-data", maxBytes: 1024 },
            input: payloadSchema,
            output: payloadSchema,
            error: payloadSchema,
        });
        expect(multipart.requestBody).toEqual({
            encoding: "multipart/form-data",
            maxBytes: 1024,
        });
        expect(
            defineHttpContract({
                id: "json",
                method: "POST",
                path: "/json",
                input: payloadSchema,
                output: payloadSchema,
                error: payloadSchema,
            }).requestBody,
        ).toBeUndefined();
    });

    test("validates multipart maxBytes metadata", () => {
        for (const maxBytes of [
            Number.NaN,
            Infinity,
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() =>
                defineHttpContract({
                    id: "invalid",
                    method: "POST",
                    path: "/invalid",
                    requestBody: { encoding: "multipart/form-data", maxBytes },
                    input: payloadSchema,
                    output: payloadSchema,
                    error: payloadSchema,
                }),
            ).toThrow(TypeError);
        }
        expect(() =>
            defineHttpContract({
                id: "json-limit",
                method: "POST",
                path: "/json",
                requestBody: { encoding: "json", maxBytes: 1 },
                input: payloadSchema,
                output: payloadSchema,
                error: payloadSchema,
            }),
        ).toThrow(TypeError);
    });

    test("validates event type, version, and payload", async () => {
        const contract = defineEventContract({
            type: "Updated",
            version: 1,
            payload: payloadSchema,
        });
        const event = await parseEventEnvelope(contract, {
            id: "1",
            type: "Updated",
            version: 1,
            occurredAt: "2026-07-25T00:00:00.000Z",
            payload: { value: "ok" },
        });
        expect(event.payload.value).toBe("ok");
        await expect(
            parseEventEnvelope(contract, {
                id: "1",
                type: "Updated",
                version: 2,
                occurredAt: "now",
                payload: { value: "ok" },
            }),
        ).rejects.toBeInstanceOf(ContractValidationError);
    });
});
