import {
    type VoiceConnectionState as RawVoiceConnectionState,
    type VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { defaultVoiceConnectionAdapter } from "./adapter.ts";
import { abortableDelay, abortError, withAbort } from "./async.ts";
import {
    VoiceConnectionConnectError,
    VoiceConnectionRecoveryError,
} from "./errors.ts";
import type {
    VoiceConnectionAdapter,
    VoiceConnectionControllerOptions,
    VoiceConnectionState,
} from "./types.ts";

export class VoiceConnectionController {
    private _state: VoiceConnectionState = "idle";
    private _channel: VoiceBasedChannel | undefined;
    private _connection: VoiceConnection | undefined;
    private connectPromise: Promise<VoiceConnection> | undefined;
    private connectController: AbortController | undefined;
    private recoveryPromise: Promise<void> | undefined;
    private recoveryController: AbortController | undefined;
    private explicitDisconnect = false;
    private readonly adapter: VoiceConnectionAdapter;
    private readonly handleDisconnected = () => {
        if (this.explicitDisconnect || this._state === "destroyed") return;
        if (!this.recoveryPromise) {
            this.recoveryPromise = this.recover().finally(() => {
                this.recoveryPromise = undefined;
            });
        }
    };
    private readonly handleConnectionStateChange = (
        _oldState: RawVoiceConnectionState,
        newState: RawVoiceConnectionState,
    ) => {
        if (
            newState.status === VoiceConnectionStatus.Ready &&
            this._state === "reconnecting"
        ) {
            this.setState("ready");
        }
    };

    constructor(
        private readonly options: VoiceConnectionControllerOptions = {},
    ) {
        this.adapter = options.adapter ?? defaultVoiceConnectionAdapter;
    }

    get state(): VoiceConnectionState {
        return this._state;
    }

    get channel(): VoiceBasedChannel | undefined {
        return this._channel;
    }

    get connection(): VoiceConnection | undefined {
        return this._connection;
    }

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
            this._connection
        ) {
            return Promise.resolve(this._connection);
        }
        if (this.connectPromise) return this.connectPromise;
        const controller = new AbortController();
        this.connectController = controller;
        const externalSignal = options.signal;
        const forwardAbort = () =>
            controller.abort(
                externalSignal ? abortError(externalSignal) : undefined,
            );
        if (externalSignal?.aborted) {
            forwardAbort();
        } else {
            externalSignal?.addEventListener("abort", forwardAbort, {
                once: true,
            });
        }
        this.connectPromise = this.connectInternal(
            channel,
            controller.signal,
        ).finally(() => {
            externalSignal?.removeEventListener("abort", forwardAbort);
            this.connectPromise = undefined;
            if (this.connectController === controller) {
                this.connectController = undefined;
            }
        });
        return this.connectPromise;
    }

    async disconnect(): Promise<void> {
        if (
            this._state === "idle" ||
            this._state === "destroyed" ||
            this._state === "disconnecting"
        ) {
            return;
        }
        this.explicitDisconnect = true;
        this.connectController?.abort(
            new DOMException("Voice connection disconnected", "AbortError"),
        );
        this.recoveryController?.abort(
            new DOMException("Voice connection disconnected", "AbortError"),
        );
        await this.connectPromise?.catch(() => {});
        this.setState("disconnecting");
        this.detachConnection();
        this._connection?.destroy();
        this._connection = undefined;
        this._channel = undefined;
        this.setState("idle");
        this.explicitDisconnect = false;
        await this.recoveryPromise?.catch(() => {});
    }

    async destroy(): Promise<void> {
        if (this._state === "destroyed") return;
        await this.disconnect();
        this.explicitDisconnect = true;
        this.setState("destroyed");
    }

    private async connectInternal(
        channel: VoiceBasedChannel,
        signal: AbortSignal | undefined,
    ): Promise<VoiceConnection> {
        this.explicitDisconnect = false;
        this.recoveryController?.abort();
        this.detachConnection();
        this.setState("connecting");
        try {
            const connection = this.adapter.join({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: this.options.selfMute ?? false,
                selfDeaf: this.options.selfDeaf ?? false,
            });
            this._channel = channel;
            this._connection = connection;
            this.attachConnection(connection);
            await this.waitForReady(
                connection,
                this.options.readyTimeoutMs ?? 15_000,
                signal,
            );
            this.setState("ready");
            this.options.onConnected?.(connection);
            return connection;
        } catch (error) {
            this.detachConnection();
            this._connection?.destroy();
            this._connection = undefined;
            this._channel = undefined;
            this.setState("error");
            const wrapped =
                error instanceof VoiceConnectionConnectError
                    ? error
                    : new VoiceConnectionConnectError(
                          "Voice connection failed",
                          error,
                      );
            this.options.onError?.(wrapped);
            throw wrapped;
        }
    }

    private async recover(): Promise<void> {
        const connection = this._connection;
        if (!connection) return;
        const controller = new AbortController();
        this.recoveryController?.abort();
        this.recoveryController = controller;
        const recovery = this.options.recovery;
        const gracePeriodMs = recovery?.gracePeriodMs ?? 5_000;
        const maxAttempts = recovery?.maxAttempts ?? 3;
        const readyTimeoutMs =
            recovery?.readyTimeoutMs ?? this.options.readyTimeoutMs ?? 15_000;
        const backoffMs = recovery?.backoffMs ?? 100;
        this.setState("reconnecting");
        let lastError: unknown;

        try {
            await withAbort(
                Promise.any([
                    this.adapter.enterState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        gracePeriodMs,
                    ),
                    this.adapter.enterState(
                        connection,
                        VoiceConnectionStatus.Connecting,
                        gracePeriodMs,
                    ),
                ]),
                controller.signal,
            );
            await this.waitForReady(
                connection,
                readyTimeoutMs,
                controller.signal,
            );
            this.setState("ready");
            return;
        } catch (error) {
            lastError = error;
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (controller.signal.aborted || this.explicitDisconnect) return;
            this.options.onRecoveryAttempt?.(attempt, connection);
            try {
                if (!connection.rejoin()) {
                    throw new Error("Voice connection rejected rejoin");
                }
                await this.waitForReady(
                    connection,
                    readyTimeoutMs,
                    controller.signal,
                );
                this.setState("ready");
                this.options.onConnected?.(connection);
                return;
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    await abortableDelay(backoffMs, controller.signal);
                }
            }
        }

        if (controller.signal.aborted || this.explicitDisconnect) return;
        const error = new VoiceConnectionRecoveryError(maxAttempts, lastError);
        this.setState("error");
        this.options.onRecoveryFailed?.(error, connection);
        this.options.onError?.(error);
    }

    private waitForReady(
        connection: VoiceConnection,
        timeoutMs: number,
        signal: AbortSignal | undefined,
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

    private attachConnection(connection: VoiceConnection): void {
        connection.on(
            VoiceConnectionStatus.Disconnected,
            this.handleDisconnected,
        );
        connection.on("stateChange", this.handleConnectionStateChange);
    }

    private detachConnection(): void {
        this._connection?.off(
            VoiceConnectionStatus.Disconnected,
            this.handleDisconnected,
        );
        this._connection?.off("stateChange", this.handleConnectionStateChange);
    }

    private setState(state: VoiceConnectionState): void {
        if (state === this._state) return;
        const previous = this._state;
        this._state = state;
        this.options.onStateChange?.(state, previous);
    }
}
