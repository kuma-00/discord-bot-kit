import { describe, expect, test } from "bun:test";
import { type VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import {
    type VoiceConnectionAdapter,
    VoiceConnectionConnectError,
    VoiceConnectionController,
    VoiceConnectionRecoveryError,
} from "../src/index.ts";

type Handler = (...args: unknown[]) => void;

class MockVoiceConnection {
    readonly handlers = new Map<string, Set<Handler>>();
    state = { status: VoiceConnectionStatus.Connecting };
    rejoinCalls = 0;
    destroyCalls = 0;

    on(event: string, handler: Handler) {
        const handlers = this.handlers.get(event) ?? new Set();
        handlers.add(handler);
        this.handlers.set(event, handlers);
        return this;
    }

    off(event: string, handler: Handler) {
        this.handlers.get(event)?.delete(handler);
        return this;
    }

    emit(event: string, ...args: unknown[]) {
        for (const handler of this.handlers.get(event) ?? []) {
            handler(...args);
        }
    }

    rejoin() {
        this.rejoinCalls++;
        return true;
    }

    destroy() {
        this.destroyCalls++;
        this.state = { status: VoiceConnectionStatus.Destroyed };
    }
}

function channel(id = "voice"): VoiceBasedChannel {
    return {
        id,
        guild: {
            id: "guild",
            voiceAdapterCreator: {},
        },
    } as unknown as VoiceBasedChannel;
}

function adapter(
    connection: MockVoiceConnection,
    enterState: VoiceConnectionAdapter["enterState"] = async (
        target,
        status,
    ) => {
        connection.state = { status };
        return target;
    },
) {
    const joins: Parameters<VoiceConnectionAdapter["join"]>[0][] = [];
    const value: VoiceConnectionAdapter = {
        join: (options) => {
            joins.push(options);
            return connection as unknown as VoiceConnection;
        },
        enterState,
    };
    return { value, joins };
}

describe("VoiceConnectionController", () => {
    test("waits for Ready and coalesces concurrent connect calls", async () => {
        const connection = new MockVoiceConnection();
        let resolveReady!: (connection: VoiceConnection) => void;
        const ready = new Promise<VoiceConnection>((resolve) => {
            resolveReady = resolve;
        });
        const fixture = adapter(connection, async (target, status) =>
            status === VoiceConnectionStatus.Ready ? ready : target,
        );
        const states: string[] = [];
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            onStateChange: (state) => states.push(state),
        });
        const first = controller.connect(channel());
        const second = controller.connect(channel());
        expect(fixture.joins).toHaveLength(1);
        resolveReady(connection as unknown as VoiceConnection);
        expect(await first).toBe(connection as unknown as VoiceConnection);
        expect(await second).toBe(connection as unknown as VoiceConnection);
        expect(controller.state).toBe("ready");
        expect(states).toEqual(["connecting", "ready"]);
    });

    test("reconfigures the connection when the channel changes", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(connection);
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });
        await controller.connect(channel("first"));
        await controller.connect(channel("second"));
        expect(fixture.joins.map(({ channelId }) => channelId)).toEqual([
            "first",
            "second",
        ]);
        expect(controller.channel?.id).toBe("second");
    });

    test("accepts natural recovery without rejoin", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(connection);
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            recovery: { gracePeriodMs: 1, readyTimeoutMs: 1 },
        });
        await controller.connect(channel());
        connection.emit(VoiceConnectionStatus.Disconnected);
        await Bun.sleep(1);
        expect(controller.state).toBe("ready");
        expect(connection.rejoinCalls).toBe(0);
    });

    test("bounds rejoin attempts and reports recovery failure", async () => {
        const connection = new MockVoiceConnection();
        let initialReady = true;
        const fixture = adapter(connection, async (target, status) => {
            if (status === VoiceConnectionStatus.Ready && initialReady) {
                initialReady = false;
                return target;
            }
            throw new Error(`cannot enter ${status}`);
        });
        const attempts: number[] = [];
        const failures: VoiceConnectionRecoveryError[] = [];
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            recovery: {
                gracePeriodMs: 1,
                readyTimeoutMs: 1,
                maxAttempts: 2,
                backoffMs: 0,
            },
            onRecoveryAttempt: (attempt) => attempts.push(attempt),
            onRecoveryFailed: (error) => failures.push(error),
        });
        await controller.connect(channel());
        connection.emit(VoiceConnectionStatus.Disconnected);
        await Bun.sleep(5);
        expect(attempts).toEqual([1, 2]);
        expect(connection.rejoinCalls).toBe(2);
        expect(failures[0]).toBeInstanceOf(VoiceConnectionRecoveryError);
        expect(controller.state).toBe("error");
    });

    test("supports aborting connect and cleans up the connection", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(
            connection,
            () => new Promise<VoiceConnection>(() => {}),
        );
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });
        const abortController = new AbortController();
        const connecting = controller.connect(channel(), {
            signal: abortController.signal,
        });
        abortController.abort(new DOMException("cancelled", "AbortError"));
        expect(connecting).rejects.toBeInstanceOf(VoiceConnectionConnectError);
        await connecting.catch(() => {});
        expect(connection.destroyCalls).toBe(1);
        expect(
            [...connection.handlers.values()].every(
                (handlers) => handlers.size === 0,
            ),
        ).toBe(true);
    });

    test("disconnects and destroys idempotently", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(connection);
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });
        await controller.connect(channel());
        await controller.disconnect();
        await controller.disconnect();
        expect(connection.destroyCalls).toBe(1);
        expect(controller.state).toBe("idle");
        await controller.destroy();
        await controller.destroy();
        expect(controller.state).toBe("destroyed");
    });

    test("destroy aborts an in-progress connection", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(
            connection,
            () => new Promise<VoiceConnection>(() => {}),
        );
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });
        const connecting = controller.connect(channel());
        const destroying = controller.destroy();
        await expect(connecting).rejects.toBeInstanceOf(
            VoiceConnectionConnectError,
        );
        await destroying;
        expect(controller.state).toBe("destroyed");
        expect(connection.destroyCalls).toBe(1);
    });
});
