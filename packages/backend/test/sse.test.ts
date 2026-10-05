import { describe, expect, spyOn, test } from "bun:test";
import { type BrokerEvent, SseEventBroker } from "../src/sse.ts";

const event: BrokerEvent = { id: "evt-1", data: { ok: true } };
const text = (chunk?: Uint8Array) => new TextDecoder().decode(chunk);

async function readText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const result = await reader?.read();
    reader?.releaseLock();
    return text(result?.value);
}

describe("SseEventBroker", () => {
    test("keeps response/publish global fan-out and sets SSE headers", async () => {
        const broker = new SseEventBroker();
        const response = broker.response();
        expect(response.headers.get("cache-control")).toBe(
            "no-cache, no-transform",
        );
        expect(response.headers.get("connection")).toBe("keep-alive");
        expect(response.headers.get("content-type")).toBe(
            "text/event-stream; charset=utf-8",
        );
        const pending = readText(response);
        broker.publish(event);
        expect(await pending).toContain("id: evt-1");
        await response.body?.cancel();
        expect(broker.subscriberCount).toBe(0);
    });

    test("global publishes reach every connection and scoped publishes stay exact", async () => {
        const broker = new SseEventBroker();
        const unscoped = broker.response();
        const scopeA = broker.responseFor("A");
        const scopeB = broker.responseFor("B");
        const all = [unscoped, scopeA, scopeB].map(readText);
        broker.publish(event);
        expect(
            (await Promise.all(all)).every((chunk) => chunk.includes("evt-1")),
        ).toBe(true);

        const aNext = readText(scopeA);
        const bReader = scopeB.body?.getReader();
        const globalReader = unscoped.body?.getReader();
        const bNext = bReader?.read();
        const globalNext = globalReader?.read();
        broker.publishTo("A", { id: "only-a", data: 1 });
        expect(await aNext).toContain("only-a");
        await bReader?.cancel();
        await globalReader?.cancel();
        expect(await bNext).toMatchObject({ done: true });
        expect(await globalNext).toMatchObject({ done: true });
        bReader?.releaseLock();
        globalReader?.releaseLock();
        for (const response of [unscoped, scopeA, scopeB])
            await response.body?.cancel();
    });

    test("validates scopes without normalizing their identity", () => {
        const broker = new SseEventBroker();
        for (const invalid of [undefined, null, "", "  ", 1, {}]) {
            expect(() => broker.responseFor(invalid as string)).toThrow(
                TypeError,
            );
            expect(() => broker.publishTo(invalid as string, event)).toThrow(
                TypeError,
            );
        }
        const response = broker.responseFor(" A ");
        expect(broker.scopeCount).toBe(1);
        void response.body?.cancel();
    });

    test("pre-aborted response creates no subscriber or scoped map", async () => {
        const broker = new SseEventBroker({ heartbeatIntervalMs: 5 });
        const abort = new AbortController();
        abort.abort();
        const response = broker.responseFor("closed", abort.signal);
        expect(broker.subscriberCount).toBe(0);
        expect(broker.scopeCount).toBe(0);
        expect(await response.body?.getReader().read()).toMatchObject({
            done: true,
        });
    });

    test("abort, reader cancellation, and repeated cleanup release each scope once", async () => {
        const broker = new SseEventBroker();
        const abort = new AbortController();
        const response = broker.responseFor("A", abort.signal);
        const reader = response.body?.getReader();
        abort.abort();
        await reader?.cancel();
        expect(broker.subscriberCount).toBe(0);
        expect(broker.scopeCount).toBe(0);
        const next = broker.responseFor("A");
        expect(broker.subscriberCount).toBe(1);
        expect(broker.scopeCount).toBe(1);
        await next.body?.cancel();
        expect(broker.scopeCount).toBe(0);
    });

    test("heartbeat emits SSE comments and stops on abort", async () => {
        const broker = new SseEventBroker({ heartbeatIntervalMs: 5 });
        const abort = new AbortController();
        const response = broker.response(abort.signal);
        const removeListener = spyOn(abort.signal, "removeEventListener");
        const clearTimer = spyOn(globalThis, "clearInterval");
        const reader = response.body?.getReader();
        const heartbeat = await reader?.read();
        expect(text(heartbeat?.value)).toBe(": heartbeat\n\n");
        abort.abort();
        expect(await reader?.read()).toMatchObject({ done: true });
        expect(removeListener).toHaveBeenCalledWith(
            "abort",
            expect.any(Function),
        );
        expect(clearTimer).toHaveBeenCalledTimes(1);
        expect(broker.subscriberCount).toBe(0);
        removeListener.mockRestore();
        clearTimer.mockRestore();
    });

    test("custom headers are retained while SSE content type is forced", () => {
        const response = new SseEventBroker({
            headers: { "x-custom": "yes", "content-type": "text/plain" },
        }).response();
        expect(response.headers.get("x-custom")).toBe("yes");
        expect(response.headers.get("content-type")).toBe(
            "text/event-stream; charset=utf-8",
        );
        void response.body?.cancel();
    });

    test("cleans up a failed enqueue and continues delivery to other subscribers", async () => {
        const broker = new SseEventBroker();
        const broken = broker.responseFor("A");
        const healthy = broker.responseFor("B");
        const entry = [
            ...(
                broker as unknown as {
                    subscribers: Set<{
                        controller?: ReadableStreamDefaultController<Uint8Array>;
                    }>;
                }
            ).subscribers,
        ][0];
        if (!entry) throw new Error("Expected an active subscriber");
        Object.defineProperty(entry.controller, "enqueue", {
            configurable: true,
            value: () => {
                throw new Error("closed controller");
            },
        });
        const pending = readText(healthy);
        broker.publish(event);
        expect(await pending).toContain("evt-1");
        expect(broker.subscriberCount).toBe(1);
        expect(broker.scopeCount).toBe(1);
        await broken.body?.cancel();
        await healthy.body?.cancel();
        expect(broker.scopeCount).toBe(0);
    });

    test("accepts the maximum heartbeat interval without retaining a timer", async () => {
        const broker = new SseEventBroker({
            heartbeatIntervalMs: 2_147_483_647,
        });
        const response = broker.response();
        expect(broker.subscriberCount).toBe(1);
        await response.body?.cancel();
        expect(broker.subscriberCount).toBe(0);
    });

    test("rejects heartbeat intervals outside the supported range", () => {
        for (const heartbeatIntervalMs of [
            0,
            -1,
            1.5,
            2_147_483_648,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => new SseEventBroker({ heartbeatIntervalMs })).toThrow(
                TypeError,
            );
        }
    });
});
