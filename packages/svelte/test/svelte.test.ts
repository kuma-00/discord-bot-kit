import { describe, expect, test } from "bun:test";
import {
    ObservableValue,
    type RealtimeConnectionState,
    RealtimeController,
} from "@kuma-00/bot-kit-frontend";
import { get } from "svelte/store";
import { schema } from "../../../tests/schema.ts";
import {
    createEventRegistry,
    defineEventContract,
} from "../../contracts/src/index.ts";
import { createRealtimeStores, toReadable } from "../src/index.ts";

describe("Svelte adapter", () => {
    test("converts observable values without browser globals", () => {
        const source = new ObservableValue(1);
        const store = toReadable(source);
        expect(get(store)).toBe(1);
        source.set(2);
        expect(get(store)).toBe(2);
    });

    test("starts on first subscription and stops after the last", () => {
        let starts = 0;
        let stops = 0;
        const controller = {
            state: new ObservableValue<RealtimeConnectionState>("idle"),
            lastEvent: new ObservableValue<string | undefined>(undefined),
            start: () => {
                starts += 1;
            },
            stop: () => {
                stops += 1;
            },
        };
        const stores = createRealtimeStores(controller);
        const unsubscribeState = stores.state.subscribe(() => {});
        const unsubscribeEvent = stores.event.subscribe(() => {});
        expect(starts).toBe(1);
        unsubscribeState();
        expect(stops).toBe(0);
        unsubscribeEvent();
        expect(stops).toBe(1);
    });

    test("stops a registry-backed controller after its final store subscriber", async () => {
        const payload = schema<{ value: string }>(
            (value): value is { value: string } =>
                typeof value === "object" &&
                value !== null &&
                typeof (value as { value?: unknown }).value === "string",
        );
        const registry = createEventRegistry([
            defineEventContract({ type: "First", version: 1, payload }),
            defineEventContract({ type: "Second", version: 1, payload }),
        ] as const);
        let fetches = 0;
        const controller = new RealtimeController({
            url: "/events",
            contracts: registry,
            fetch: async () => {
                fetches += 1;
                return new Response(new ReadableStream<Uint8Array>(), {
                    headers: { "content-type": "text/event-stream" },
                });
            },
        });
        const stores = createRealtimeStores(controller);
        const unsubscribeState = stores.state.subscribe(() => {});
        const unsubscribeEvent = stores.event.subscribe(() => {});
        for (
            let index = 0;
            index < 100 && controller.state.value !== "open";
            index++
        ) {
            await Bun.sleep(1);
        }
        expect(controller.state.value).toBe("open");
        unsubscribeState();
        expect(controller.state.value).toBe("open");
        unsubscribeEvent();

        for (let index = 0; index < 100 && fetches === 0; index++) {
            await Bun.sleep(1);
        }
        expect(fetches).toBe(1);
        expect(controller.state.value).toBe("closed");
    });
});
