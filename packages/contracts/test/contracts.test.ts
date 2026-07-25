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
