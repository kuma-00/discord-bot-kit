import {
    type VoiceConnectionState as RawVoiceConnectionState,
    type VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { defaultVoiceConnectionAdapter } from "./adapter.ts";
import { abortableDelay, withAbort } from "./async.ts";
import {
    VoiceConnectionConnectError,
    VoiceConnectionRecoveryError,
} from "./errors.ts";
import type {
    VoiceConnectionAdapter,
    VoiceConnectionControllerOptions,
    VoiceConnectionRecoveryMethod,
    VoiceConnectionState,
} from "./types.ts";

interface RecoveryToken {
    generation: number;
    connection: VoiceConnection;
}

interface RecoveryFailure {
    readonly method: VoiceConnectionRecoveryMethod;
    readonly attempts: number;
    readonly cause: unknown;
    readonly connection: VoiceConnection;
}

/**
 * Owns one guild voice connection with bounded recovery and cleanup.
 *
 * Same-target connects share work while each caller retains independent
 * cancellation. Channel changes are serialized and cancelled by disconnect or
 * destroy. Unexpected disconnects recover through grace, rejoin, then transport
 * recreation without exposing transport lifecycle bookkeeping to consumers.
 */
export class VoiceConnectionController {
    private _state: VoiceConnectionState = "idle";
    private _channel: VoiceBasedChannel | undefined;
    private _connection: VoiceConnection | undefined;
    private connectPromise: Promise<VoiceConnection> | undefined;
    private connectTarget: string | undefined;
    private connectController: AbortController | undefined;
    private lifecycleGeneration = 0;
    private recoveryPromise: Promise<void> | undefined;
    private recoveryController: AbortController | undefined;
    private explicitDisconnect = false;
    private readonly adapter: VoiceConnectionAdapter;
    private readonly handleDisconnected = () => {
        const connection = this._connection;
        if (
            !connection ||
            this.explicitDisconnect ||
            this._state === "destroyed" ||
            this.recoveryPromise
        ) {
            return;
        }
        const generation = this.lifecycleGeneration;
        const recovery = this.recover(connection, generation)
            .catch((error) => {
                if (!this.isRecoveryCurrent(generation, connection)) return;
                try {
                    this.setState("error");
                } catch (stateError) {
                    this.reportError(stateError);
                }
                this.reportError(error);
            })
            .finally(() => {
                if (this.recoveryPromise === recovery) {
                    this.recoveryPromise = undefined;
                }
            });
        this.recoveryPromise = recovery;
    };
    private readonly handleConnectionStateChange = (
        _oldState: RawVoiceConnectionState,
        _newState: RawVoiceConnectionState,
    ) => {
        // Recovery owns observable controller state. Keeping this listener
        // centralized prevents duplicate listeners and leaves room for future
        // connection diagnostics without racing the recovery pipeline.
    };

    constructor(
        private readonly options: VoiceConnectionControllerOptions = {},
    ) {
        this.adapter = options.adapter ?? defaultVoiceConnectionAdapter;
    }

    /** Current controller lifecycle state. */
    get state(): VoiceConnectionState {
        return this._state;
    }

    /** Channel currently owned by the controller, if connected. */
    get channel(): VoiceBasedChannel | undefined {
        return this._channel;
    }

    /** Underlying voice connection currently owned by the controller. */
    get connection(): VoiceConnection | undefined {
        return this._connection;
    }

    /**
     * Connects to a channel and waits for Ready.
     *
     * Caller cancellation does not cancel shared same-target work.
     */
    connect(
        channel: VoiceBasedChannel,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<VoiceConnection> {
        if (this._state === "destroyed") {
            return Promise.reject(
                new VoiceConnectionConnectError(
                    "Cannot connect a destroyed VoiceConnectionController",
                    undefined,
                ),
            );
        }
        if (
            this._state === "ready" &&
            this._channel?.id === channel.id &&
            this._channel.guild.id === channel.guild.id &&
            this._connection
        ) {
            return withAbort(Promise.resolve(this._connection), options.signal);
        }
        const target = `${channel.guild.id}:${channel.id}`;
        if (this.connectPromise) {
            if (this.connectTarget === target) {
                return withAbort(this.connectPromise, options.signal);
            }
            const generation = this.lifecycleGeneration;
            const connectAfterCurrent = () => {
                if (
                    generation !== this.lifecycleGeneration ||
                    options.signal?.aborted ||
                    this._state === "destroyed"
                ) {
                    throw new VoiceConnectionConnectError(
                        "Voice connection request was cancelled",
                        options.signal?.reason,
                    );
                }
                return this.connect(channel, options);
            };
            return withAbort(
                this.connectPromise.then(
                    connectAfterCurrent,
                    connectAfterCurrent,
                ),
                options.signal,
            );
        }

        const generation = ++this.lifecycleGeneration;
        this.explicitDisconnect = false;
        this.recoveryController?.abort(
            new DOMException(
                "Voice recovery superseded by connect",
                "AbortError",
            ),
        );
        const controller = new AbortController();
        this.connectController = controller;
        this.connectTarget = target;
        this.connectPromise = this.connectInternal(
            channel,
            controller.signal,
            generation,
        ).finally(() => {
            this.connectPromise = undefined;
            this.connectTarget = undefined;
            if (this.connectController === controller) {
                this.connectController = undefined;
            }
        });
        return withAbort(this.connectPromise, options.signal);
    }

    /** Cancels pending work, removes listeners, and destroys the connection. */
    async disconnect(): Promise<void> {
        if (
            this._state === "idle" ||
            this._state === "destroyed" ||
            this._state === "disconnecting"
        ) {
            return;
        }
        ++this.lifecycleGeneration;
        this.explicitDisconnect = true;
        const reason = new DOMException(
            "Voice connection disconnected",
            "AbortError",
        );
        this.connectController?.abort(reason);
        this.recoveryController?.abort(reason);
        await this.connectPromise?.catch(() => {});
        this.setState("disconnecting");
        const connection = this._connection;
        if (connection) {
            this.detachConnection(connection);
            this.destroyConnection(connection);
        }
        this._connection = undefined;
        this._channel = undefined;
        this.setState("idle");
        await this.recoveryPromise?.catch(() => {});
        this.explicitDisconnect = false;
    }

    /** Permanently disconnects the controller; later connects are rejected. */
    async destroy(): Promise<void> {
        if (this._state === "destroyed") return;
        await this.disconnect();
        ++this.lifecycleGeneration;
        this.explicitDisconnect = true;
        this.setState("destroyed");
    }

    private async connectInternal(
        channel: VoiceBasedChannel,
        signal: AbortSignal,
        generation: number,
    ): Promise<VoiceConnection> {
        const previousConnection = this._connection;
        if (previousConnection) this.detachConnection(previousConnection);
        this.setState("connecting");
        let connection: VoiceConnection | undefined;
        try {
            connection = this.adapter.join(this.joinOptions(channel));
            if (previousConnection && previousConnection !== connection) {
                this.destroyConnection(previousConnection);
            }
            this.assertConnectCurrent(generation, signal);
            this._channel = channel;
            this._connection = connection;
            this.attachConnection(connection);
            await this.waitForReady(
                connection,
                this.options.readyTimeoutMs ?? 15_000,
                signal,
            );
            this.assertConnectCurrent(generation, signal, connection);
            this.setState("ready");
            const connected = connection;
            this.runHook(() => this.options.onConnected?.(connected));
            return connection;
        } catch (error) {
            if (connection && this._connection === connection) {
                this.detachConnection(connection);
                this.destroyConnection(connection);
                this._connection = undefined;
                this._channel = undefined;
            } else if (connection && connection !== this._connection) {
                this.destroyConnection(connection);
            }
            if (previousConnection && this._connection === previousConnection) {
                this.detachConnection(previousConnection);
                this.destroyConnection(previousConnection);
                this._connection = undefined;
                this._channel = undefined;
            }
            if (
                generation === this.lifecycleGeneration &&
                this._state !== "destroyed" &&
                !this.explicitDisconnect
            ) {
                this.setState("error");
            }
            const wrapped =
                error instanceof VoiceConnectionConnectError
                    ? error
                    : new VoiceConnectionConnectError(
                          "Voice connection failed",
                          error,
                      );
            this.reportError(wrapped);
            throw wrapped;
        }
    }

    private async recover(
        connection: VoiceConnection,
        generation: number,
    ): Promise<void> {
        const controller = new AbortController();
        this.recoveryController?.abort();
        this.recoveryController = controller;
        const token: RecoveryToken = { generation, connection };
        this.setState("reconnecting");
        let failure: RecoveryFailure = {
            method: "grace",
            attempts: 1,
            cause: new Error(
                "Voice connection did not recover during grace period",
            ),
            connection,
        };

        try {
            await this.tryGraceRecovery(token, controller.signal);
            this.finishRecovery("grace", token);
            return;
        } catch (error) {
            if (!this.isTokenCurrent(token, controller.signal)) return;
            failure = { ...failure, cause: error };
        }

        const rejoin = this.options.recovery?.rejoin;
        const rejoinAttempts = rejoin?.maxAttempts ?? 3;
        if (rejoinAttempts > 0) {
            const result = await this.tryRejoinRecovery(
                token,
                controller.signal,
                rejoinAttempts,
                rejoin?.readyTimeoutMs ?? this.options.readyTimeoutMs ?? 15_000,
                rejoin?.backoffMs ?? 100,
            );
            if (!result) return;
            if (result === true) {
                this.finishRecovery("rejoin", token);
                return;
            }
            failure = result;
        }

        const recreate = this.options.recovery?.recreate;
        const recreateAttempts = recreate?.maxAttempts ?? 1;
        if ((recreate?.enabled ?? true) && recreateAttempts > 0) {
            const result = await this.tryRecreateRecovery(
                token,
                controller.signal,
                recreateAttempts,
                recreate?.readyTimeoutMs ??
                    this.options.readyTimeoutMs ??
                    15_000,
                recreate?.backoffMs ?? 100,
            );
            if (!result) return;
            if (result === true) {
                this.finishRecovery("recreate", token);
                return;
            }
            failure = result;
        }

        if (!this.isRecoveryGenerationCurrent(token, controller.signal)) return;
        const error = new VoiceConnectionRecoveryError(
            failure.method,
            failure.attempts,
            failure.cause,
        );
        this.setState("error");
        this.runHook(() =>
            this.options.onRecoveryFailed?.({
                error,
                connection: failure.connection,
            }),
        );
        this.reportError(error);
    }

    private async tryGraceRecovery(
        token: RecoveryToken,
        signal: AbortSignal,
    ): Promise<void> {
        const gracePeriodMs = this.options.recovery?.gracePeriodMs ?? 5_000;
        await withAbort(
            Promise.any([
                this.adapter.enterState(
                    token.connection,
                    VoiceConnectionStatus.Ready,
                    gracePeriodMs,
                ),
                this.adapter.enterState(
                    token.connection,
                    VoiceConnectionStatus.Signalling,
                    gracePeriodMs,
                ),
                this.adapter.enterState(
                    token.connection,
                    VoiceConnectionStatus.Connecting,
                    gracePeriodMs,
                ),
            ]),
            signal,
        );
        this.assertTokenCurrent(token, signal);
        await this.waitForReady(
            token.connection,
            this.options.recovery?.rejoin?.readyTimeoutMs ??
                this.options.readyTimeoutMs ??
                15_000,
            signal,
        );
        this.assertTokenCurrent(token, signal);
    }

    private async tryRejoinRecovery(
        token: RecoveryToken,
        signal: AbortSignal,
        maxAttempts: number,
        readyTimeoutMs: number,
        backoffMs: number,
    ): Promise<true | RecoveryFailure | undefined> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (!this.isTokenCurrent(token, signal)) return undefined;
            this.runHook(() =>
                this.options.onRecoveryAttempt?.({
                    method: "rejoin",
                    attempt,
                    connection: token.connection,
                }),
            );
            try {
                if (!token.connection.rejoin()) {
                    throw new Error("Voice connection rejected rejoin");
                }
                await this.waitForReady(
                    token.connection,
                    readyTimeoutMs,
                    signal,
                );
                this.assertTokenCurrent(token, signal);
                return true;
            } catch (error) {
                if (!this.isTokenCurrent(token, signal)) return undefined;
                lastError = error;
                if (attempt < maxAttempts) {
                    try {
                        await abortableDelay(backoffMs, signal);
                    } catch {
                        if (!this.isTokenCurrent(token, signal))
                            return undefined;
                    }
                }
            }
        }
        return {
            method: "rejoin",
            attempts: maxAttempts,
            cause: lastError,
            connection: token.connection,
        };
    }

    private async tryRecreateRecovery(
        token: RecoveryToken,
        signal: AbortSignal,
        maxAttempts: number,
        readyTimeoutMs: number,
        backoffMs: number,
    ): Promise<true | RecoveryFailure | undefined> {
        const channel = this._channel;
        if (!channel) return undefined;
        let lastError: unknown;
        let failureConnection = token.connection;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (!this.isRecoveryGenerationCurrent(token, signal)) {
                return undefined;
            }
            this.runHook(() =>
                this.options.onRecoveryAttempt?.({
                    method: "recreate",
                    attempt,
                    connection: token.connection,
                }),
            );

            const oldConnection = token.connection;
            this.detachConnection(oldConnection);
            if (this._connection === oldConnection) {
                this._connection = undefined;
            }
            this.destroyConnection(oldConnection);
            token.generation = ++this.lifecycleGeneration;

            let connection: VoiceConnection | undefined;
            try {
                this.assertRecoveryGeneration(token, signal);
                connection = this.adapter.join(this.joinOptions(channel));
                failureConnection = connection;
                token.connection = connection;
                this._connection = connection;
                this.attachConnection(connection);
                await this.waitForReady(connection, readyTimeoutMs, signal);
                this.assertTokenCurrent(token, signal);
                return true;
            } catch (error) {
                lastError = error;
                if (connection && this._connection === connection) {
                    this.detachConnection(connection);
                    this.destroyConnection(connection);
                    this._connection = undefined;
                } else if (connection && connection !== this._connection) {
                    this.destroyConnection(connection);
                }
                if (!this.isRecoveryGenerationCurrent(token, signal)) {
                    return undefined;
                }
                if (attempt < maxAttempts) {
                    try {
                        await abortableDelay(backoffMs, signal);
                    } catch {
                        if (!this.isRecoveryGenerationCurrent(token, signal)) {
                            return undefined;
                        }
                    }
                }
            }
        }
        return {
            method: "recreate",
            attempts: maxAttempts,
            cause: lastError,
            connection: failureConnection,
        };
    }

    private finishRecovery(
        method: VoiceConnectionRecoveryMethod,
        token: RecoveryToken,
    ): void {
        this.setState("ready");
        this.runHook(() =>
            this.options.onRecovered?.({
                method,
                connection: token.connection,
            }),
        );
    }

    private waitForReady(
        connection: VoiceConnection,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<VoiceConnection> {
        return withAbort(
            this.adapter.enterState(
                connection,
                VoiceConnectionStatus.Ready,
                timeoutMs,
            ),
            signal,
        );
    }

    private joinOptions(channel: VoiceBasedChannel) {
        return {
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfMute: this.options.selfMute ?? false,
            selfDeaf: this.options.selfDeaf ?? false,
        };
    }

    private attachConnection(connection: VoiceConnection): void {
        this.detachConnection(connection);
        connection.on(
            VoiceConnectionStatus.Disconnected,
            this.handleDisconnected,
        );
        connection.on("stateChange", this.handleConnectionStateChange);
    }

    private detachConnection(connection: VoiceConnection): void {
        connection.off(
            VoiceConnectionStatus.Disconnected,
            this.handleDisconnected,
        );
        connection.off("stateChange", this.handleConnectionStateChange);
    }

    private destroyConnection(connection: VoiceConnection): void {
        if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
        connection.destroy();
    }

    private assertConnectCurrent(
        generation: number,
        signal: AbortSignal,
        connection?: VoiceConnection,
    ): void {
        if (
            signal.aborted ||
            generation !== this.lifecycleGeneration ||
            this.explicitDisconnect ||
            this._state === "destroyed" ||
            (connection !== undefined && this._connection !== connection)
        ) {
            throw new VoiceConnectionConnectError(
                "Voice connection request was cancelled",
                signal.reason,
            );
        }
    }

    private assertTokenCurrent(
        token: RecoveryToken,
        signal: AbortSignal,
    ): void {
        if (!this.isTokenCurrent(token, signal)) {
            throw (
                signal.reason ??
                new DOMException("Stale recovery", "AbortError")
            );
        }
    }

    private assertRecoveryGeneration(
        token: RecoveryToken,
        signal: AbortSignal,
    ): void {
        if (!this.isRecoveryGenerationCurrent(token, signal)) {
            throw (
                signal.reason ??
                new DOMException("Stale recovery", "AbortError")
            );
        }
    }

    private isTokenCurrent(token: RecoveryToken, signal: AbortSignal): boolean {
        return (
            this.isRecoveryGenerationCurrent(token, signal) &&
            this._connection === token.connection
        );
    }

    private isRecoveryGenerationCurrent(
        token: RecoveryToken,
        signal: AbortSignal,
    ): boolean {
        return (
            !signal.aborted &&
            token.generation === this.lifecycleGeneration &&
            !this.explicitDisconnect &&
            this._state !== "destroyed"
        );
    }

    private isRecoveryCurrent(
        generation: number,
        connection: VoiceConnection,
    ): boolean {
        return (
            generation === this.lifecycleGeneration &&
            this._connection === connection &&
            !this.explicitDisconnect &&
            this._state !== "destroyed"
        );
    }

    private setState(state: VoiceConnectionState): void {
        if (state === this._state) return;
        const previous = this._state;
        this._state = state;
        this.runHook(() => this.options.onStateChange?.(state, previous));
    }

    private runHook(
        hook: (() => Promise<void> | void | undefined) | undefined,
    ): void {
        if (!hook) return;
        try {
            void Promise.resolve(hook()).catch((error) =>
                this.reportError(error),
            );
        } catch (error) {
            this.reportError(error);
        }
    }

    private reportError(error: unknown): void {
        try {
            void Promise.resolve(this.options.onError?.(error)).catch(() => {});
        } catch {
            // Error reporting must not create an unhandled lifecycle rejection.
        }
    }
}
