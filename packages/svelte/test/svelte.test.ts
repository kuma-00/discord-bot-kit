import { describe, expect, test } from "bun:test";
import {
    ObservableValue,
    type RealtimeConnectionState,
} from "@kuma-00/bot-kit-frontend";
import { get } from "svelte/store";
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
});
