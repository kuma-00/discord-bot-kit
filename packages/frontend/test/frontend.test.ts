import { describe, expect, test } from "bun:test";
import {
    defineEventContract,
    defineHttpContract,
} from "@kuma-00/bot-kit-contracts";
import { schema } from "../../../tests/schema.ts";
import {
    FrontendApiClient,
    ObservableValue,
    RealtimeController,
} from "../src/index.ts";

async function waitFor(condition: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index++) {
        if (condition()) return;
        await Bun.sleep(1);
    }
    throw new Error("condition was not reached");
}

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

describe("RealtimeController", () => {
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

    test("forwards parser buffer validation to transport", () => {
        expect(
            () =>
                new RealtimeController({
                    url: "https://example.test/events",
                    contract,
                    maxBufferSize: 0,
                }),
        ).toThrow(TypeError);
    });

    test("publishes terminal connection failures and clears them on stop", async () => {
        const controller = new RealtimeController({
            url: "https://example.test/events",
            contract,
            reconnect: false,
            fetch: async () => new Response(null, { status: 401 }),
        });
        const states: string[] = [];
        controller.state.subscribe((state) => states.push(state));

        controller.start();
        await waitFor(() => controller.state.value === "closed");

        expect(states).toEqual(["idle", "connecting", "closed"]);
        expect(controller.failure.value).toEqual({
            kind: "http",
            phase: "response",
            attempt: 1,
            status: 401,
            retrying: false,
        });

        controller.stop();
        expect(controller.failure.value).toBeUndefined();
    });

    test("uses browser online as a pending-retry hint and removes listeners when closed", async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(
            globalThis,
            "window",
        );
        const previousDocument = Object.getOwnPropertyDescriptor(
            globalThis,
            "document",
        );
        const browserWindow = new EventTarget();
        const browserDocument = Object.assign(new EventTarget(), {
            visibilityState: "visible",
        });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: browserWindow,
        });
        Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: browserDocument,
        });

        let fetches = 0;
        const controller = new RealtimeController({
            url: "https://example.test/events",
            contract,
            reconnect: {
                initialDelayMs: 60_000,
                maxDelayMs: 60_000,
                jitterRatio: 0,
            },
            fetch: async () => {
                fetches++;
                return new Response(null, {
                    status: fetches === 1 ? 503 : 401,
                });
            },
        });

        try {
            controller.start();
            await waitFor(() => controller.failure.value?.retrying === true);
            browserWindow.dispatchEvent(new Event("online"));
            await waitFor(() => controller.state.value === "closed");
            browserWindow.dispatchEvent(new Event("online"));
            await Bun.sleep(0);

            expect(fetches).toBe(2);
        } finally {
            controller.stop();
            if (previousWindow) {
                Object.defineProperty(globalThis, "window", previousWindow);
            } else {
                Reflect.deleteProperty(globalThis, "window");
            }
            if (previousDocument) {
                Object.defineProperty(globalThis, "document", previousDocument);
            } else {
                Reflect.deleteProperty(globalThis, "document");
            }
        }
    });
});
