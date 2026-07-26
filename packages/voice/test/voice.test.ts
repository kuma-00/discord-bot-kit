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

function channel(id = "voice", guildId = "guild"): VoiceBasedChannel {
    return {
        id,
        guild: {
            id: guildId,
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
            onStateChange: (state) => {
                states.push(state);
            },
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

    test("routes state hook failures without failing the connection", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(connection);
        const hookFailure = new Error("state hook failed");
        const errors: unknown[] = [];
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            onStateChange: () => {
                throw hookFailure;
            },
            onError: (error) => {
                errors.push(error);
            },
        });

        expect(await controller.connect(channel())).toBe(
            connection as unknown as VoiceConnection,
        );
        expect(controller.state).toBe("ready");
        expect(errors).toEqual([hookFailure, hookFailure]);
    });

    test("contains rejected asynchronous hooks and error reporters", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(connection);
        const hookFailure = new Error("async state hook failed");
        let reported = 0;
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            onStateChange: async () => {
                throw hookFailure;
            },
            onError: async (error) => {
                expect(error).toBe(hookFailure);
                reported++;
                throw new Error("async error reporter failed");
            },
        });

        expect(await controller.connect(channel())).toBe(
            connection as unknown as VoiceConnection,
        );
        await Bun.sleep(0);
        expect(controller.state).toBe("ready");
        expect(reported).toBe(2);
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

    test("destroys the previous connection when switching guilds", async () => {
        const firstConnection = new MockVoiceConnection();
        const secondConnection = new MockVoiceConnection();
        const connections = [firstConnection, secondConnection];
        const fixture: VoiceConnectionAdapter = {
            join: () => connections.shift() as unknown as VoiceConnection,
            enterState: async (connection) => connection,
        };
        const controller = new VoiceConnectionController({
            adapter: fixture,
        });

        await controller.connect(channel("first", "guild-a"));
        await controller.connect(channel("second", "guild-b"));

        expect(firstConnection.destroyCalls).toBe(1);
        expect(secondConnection.destroyCalls).toBe(0);
        expect(controller.connection).toBe(
            secondConnection as unknown as VoiceConnection,
        );
    });

    test("serializes concurrent connections to different channels", async () => {
        const connection = new MockVoiceConnection();
        let resolveFirst!: (connection: VoiceConnection) => void;
        let readyCalls = 0;
        const firstReady = new Promise<VoiceConnection>((resolve) => {
            resolveFirst = resolve;
        });
        const fixture = adapter(connection, async (target, status) => {
            if (status === VoiceConnectionStatus.Ready && readyCalls++ === 0) {
                return firstReady;
            }
            return target;
        });
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });

        const first = controller.connect(channel("first"));
        const second = controller.connect(channel("second"));
        expect(fixture.joins.map(({ channelId }) => channelId)).toEqual([
            "first",
        ]);
        resolveFirst(connection as unknown as VoiceConnection);
        await Promise.all([first, second]);
        expect(fixture.joins.map(({ channelId }) => channelId)).toEqual([
            "first",
            "second",
        ]);
        expect(controller.channel?.id).toBe("second");
    });

    test("cancels queued channel changes when destroyed", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(
            connection,
            () => new Promise<VoiceConnection>(() => {}),
        );
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });

        const first = controller.connect(channel("first"));
        const queuedResult = controller
            .connect(channel("second"))
            .catch((error: unknown) => error);
        const destroying = controller.destroy();
        await expect(first).rejects.toBeInstanceOf(VoiceConnectionConnectError);
        expect(await queuedResult).toBeInstanceOf(VoiceConnectionConnectError);
        await destroying;
        expect(fixture.joins.map(({ channelId }) => channelId)).toEqual([
            "first",
        ]);
        expect(controller.state).toBe("destroyed");
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

    test("accepts direct Ready recovery without rejoin", async () => {
        const connection = new MockVoiceConnection();
        let initialReady = true;
        const fixture = adapter(connection, async (target, status) => {
            if (initialReady && status === VoiceConnectionStatus.Ready) {
                initialReady = false;
                return target;
            }
            if (status === VoiceConnectionStatus.Ready) return target;
            throw new Error(`did not enter ${status}`);
        });
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

    test("switches channels while recovery is backing off", async () => {
        const connection = new MockVoiceConnection();
        let joins = 0;
        let notifyRecoveryAttempt!: () => void;
        let initialReady = true;
        const recoveryAttempted = new Promise<void>((resolve) => {
            notifyRecoveryAttempt = resolve;
        });
        const fixture = adapter(connection, async (target, status) => {
            if (status === VoiceConnectionStatus.Ready && initialReady) {
                initialReady = false;
                return target;
            }
            if (joins >= 2 && status === VoiceConnectionStatus.Ready) {
                return target;
            }
            throw new Error(`cannot enter ${status}`);
        });
        const originalJoin = fixture.value.join;
        (
            fixture.value as {
                join: VoiceConnectionAdapter["join"];
            }
        ).join = (options) => {
            const joined = originalJoin(options);
            joins++;
            return joined;
        };
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            recovery: {
                gracePeriodMs: 1,
                readyTimeoutMs: 1,
                maxAttempts: 2,
                backoffMs: 10_000,
            },
            onRecoveryAttempt: () => notifyRecoveryAttempt(),
        });
        await controller.connect(channel("first"));
        connection.emit(VoiceConnectionStatus.Disconnected);
        await recoveryAttempted;
        await controller.connect(channel("second"));
        expect(controller.state).toBe("ready");
        expect(controller.channel?.id).toBe("second");
    });

    test("routes recovery hook failures without an unhandled rejection", async () => {
        const connection = new MockVoiceConnection();
        let initialReady = true;
        const fixture = adapter(connection, async (target, status) => {
            if (status === VoiceConnectionStatus.Ready && initialReady) {
                initialReady = false;
                return target;
            }
            throw new Error(`cannot enter ${status}`);
        });
        const hookFailure = new Error("recovery hook failed");
        const errors: unknown[] = [];
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            recovery: {
                gracePeriodMs: 1,
                readyTimeoutMs: 1,
                maxAttempts: 1,
            },
            onRecoveryAttempt: () => {
                throw hookFailure;
            },
            onError: (error) => {
                errors.push(error);
            },
        });

        await controller.connect(channel());
        connection.emit(VoiceConnectionStatus.Disconnected);
        await Bun.sleep(1);
        expect(controller.state).toBe("error");
        expect(errors).toContain(hookFailure);
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
            onRecoveryAttempt: (attempt) => {
                attempts.push(attempt);
            },
            onRecoveryFailed: (error) => {
                failures.push(error);
            },
        });
        await controller.connect(channel());
        connection.emit(VoiceConnectionStatus.Disconnected);
        await Bun.sleep(5);
        expect(attempts).toEqual([1, 2]);
        expect(connection.rejoinCalls).toBe(2);
        expect(failures[0]).toBeInstanceOf(VoiceConnectionRecoveryError);
        expect(controller.state).toBe("error");
    });

    test("aborts one caller without cancelling a shared connection", async () => {
        const connection = new MockVoiceConnection();
        let resolveReady!: (connection: VoiceConnection) => void;
        const ready = new Promise<VoiceConnection>((resolve) => {
            resolveReady = resolve;
        });
        const fixture = adapter(connection, () => ready);
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
        });
        const abortController = new AbortController();
        const cancelled = controller.connect(channel(), {
            signal: abortController.signal,
        });
        const shared = controller.connect(channel());
        abortController.abort(new DOMException("cancelled", "AbortError"));
        await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
        resolveReady(connection as unknown as VoiceConnection);
        expect(await shared).toBe(connection as unknown as VoiceConnection);
        expect(connection.destroyCalls).toBe(0);
        expect(controller.state).toBe("ready");
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

    test("disconnect aborts an in-progress connection and finishes idle", async () => {
        const connection = new MockVoiceConnection();
        const fixture = adapter(
            connection,
            () => new Promise<VoiceConnection>(() => {}),
        );
        const states: string[] = [];
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            onStateChange: (state) => states.push(state),
        });

        const connecting = controller.connect(channel());
        const disconnecting = controller.disconnect();
        await expect(connecting).rejects.toBeInstanceOf(
            VoiceConnectionConnectError,
        );
        await disconnecting;

        expect(controller.state).toBe("idle");
        expect(states).toEqual([
            "connecting",
            "error",
            "disconnecting",
            "idle",
        ]);
    });

    test("disconnect stops recovery and prevents stale state updates", async () => {
        const connection = new MockVoiceConnection();
        let initialReady = true;
        let recoveryStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            recoveryStarted = resolve;
        });
        const fixture = adapter(connection, async (target, status) => {
            if (initialReady && status === VoiceConnectionStatus.Ready) {
                initialReady = false;
                return target;
            }
            recoveryStarted();
            return new Promise<VoiceConnection>(() => {});
        });
        const controller = new VoiceConnectionController({
            adapter: fixture.value,
            recovery: { gracePeriodMs: 10_000 },
        });

        await controller.connect(channel());
        connection.emit(VoiceConnectionStatus.Disconnected);
        await started;
        await controller.disconnect();
        await Bun.sleep(0);

        expect(controller.state).toBe("idle");
        expect(connection.rejoinCalls).toBe(0);
    });
});
