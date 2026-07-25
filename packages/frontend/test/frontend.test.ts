import { describe, expect, test } from "bun:test";
import { ObservableValue } from "../src/index.ts";

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
