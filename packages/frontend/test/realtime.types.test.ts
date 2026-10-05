import { expect, test } from "bun:test";
import {
    createEventRegistry,
    defineEventContract,
} from "@kuma-00/bot-kit-contracts";
import { schema } from "../../../tests/schema.ts";
import { RealtimeController } from "../src/index.ts";

const created = defineEventContract({
    type: "Created",
    version: 1,
    payload: schema<{ id: string }>(
        (value): value is { id: string } =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { id?: unknown }).id === "string",
    ),
});
const deleted = defineEventContract({
    type: "Deleted",
    version: 2,
    payload: schema<{ reason: string }>(
        (value): value is { reason: string } =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { reason?: unknown }).reason === "string",
    ),
});
const registry = createEventRegistry([created, deleted] as const);

function assertOptionExclusivityAtCompileTime(): void {
    new RealtimeController({ url: "/events", contract: created });
    // @ts-expect-error Exactly one of contract and contracts is required.
    new RealtimeController({ url: "/events" });
    // @ts-expect-error Exactly one of contract and contracts is required.
    new RealtimeController({
        url: "/events",
        contract: created,
        contracts: registry,
    });
}
void assertOptionExclusivityAtCompileTime;

test("realtime controller infers a heterogeneous registry event union", () => {
    const singleController = new RealtimeController({
        url: "/events",
        contract: created,
    });
    singleController.lastEvent.subscribe((event) => {
        if (!event) return;
        const id: string = event.payload.id;
        expect(id).toBeString();
    });

    const controller = new RealtimeController({
        url: "/events",
        contracts: registry,
    });
    controller.lastEvent.subscribe((event) => {
        if (!event) return;
        if (event.type === "Created") {
            const id: string = event.payload.id;
            expect(id).toBeString();
        } else {
            const reason: string = event.payload.reason;
            expect(reason).toBeString();
        }
    });
});
