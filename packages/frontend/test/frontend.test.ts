import { describe, expect, test } from "bun:test";
import { defineHttpContract } from "@kuma-00/bot-kit-contracts";
import { schema } from "../../../tests/schema.ts";
import { FrontendApiClient, ObservableValue } from "../src/index.ts";

describe("ObservableValue", () => {
    test("publishes current and changed values and supports unsubscribe", () => {
        const value = new ObservableValue("idle");
        const received: string[] = [];
        const unsubscribe = value.subscribe((next) => received.push(next));
        value.set("open");
        unsubscribe();
        value.set("closed");
        expect(received).toEqual(["idle", "open"]);
    });
});

describe("FrontendApiClient", () => {
    test("delegates multipart requests to HttpClient", async () => {
        const valueSchema = schema<{ id: string }>(
            (value): value is { id: string } =>
                typeof value === "object" &&
                value !== null &&
                typeof (value as { id?: unknown }).id === "string",
        );
        const contract = defineHttpContract({
            id: "upload",
            method: "POST",
            path: "/upload",
            requestBody: { encoding: "multipart/form-data" },
            input: schema<{ body: Record<string, unknown> }>(
                (value): value is { body: Record<string, unknown> } =>
                    typeof value === "object" && value !== null,
            ),
            output: valueSchema,
            error: valueSchema,
        });
        const client = new FrontendApiClient({
            baseUrl: "https://example.test",
            fetch: async (_input, init) => {
                expect(
                    new Request("https://example.test", init).body,
                ).toBeDefined();
                return Response.json({ ok: true, data: { id: "1" } });
            },
        });
        await expect(
            client.request(contract, { body: { name: "test" } }),
        ).resolves.toEqual({ ok: true, data: { id: "1" } });
    });
});
