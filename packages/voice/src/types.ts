import type {
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceConnectionRecoveryError } from "./errors.ts";

/** Observable lifecycle states of a voice connection controller. */
export type VoiceConnectionState =
    | "idle"
    | "connecting"
    | "ready"
    | "reconnecting"
    | "disconnecting"
    | "destroyed"
    | "error";

/** Grace period, retry bound, Ready timeout, and retry backoff settings. */
export interface VoiceConnectionRecoveryOptions {
    readonly gracePeriodMs?: number;
    readonly maxAttempts?: number;
    readonly readyTimeoutMs?: number;
    readonly backoffMs?: number;
}

/** Injectable `@discordjs/voice` operations used for testing and integration. */
export interface VoiceConnectionAdapter {
    readonly join: (
        options: Parameters<typeof joinVoiceChannel>[0],
    ) => VoiceConnection;
    readonly enterState: (
        connection: VoiceConnection,
        status: VoiceConnectionStatus,
        timeoutOrSignal: number | AbortSignal,
    ) => Promise<VoiceConnection>;
}

/** Connection defaults, recovery policy, adapter, and lifecycle hooks. */
export interface VoiceConnectionControllerOptions {
    readonly selfMute?: boolean;
    readonly selfDeaf?: boolean;
    readonly readyTimeoutMs?: number;
    readonly recovery?: VoiceConnectionRecoveryOptions;
    readonly adapter?: VoiceConnectionAdapter;
    readonly onStateChange?: (
        state: VoiceConnectionState,
        previous: VoiceConnectionState,
    ) => void;
    readonly onConnected?: (connection: VoiceConnection) => void;
    readonly onRecoveryAttempt?: (
        attempt: number,
        connection: VoiceConnection,
    ) => void;
    readonly onRecoveryFailed?: (
        error: VoiceConnectionRecoveryError,
        connection: VoiceConnection,
    ) => void;
    readonly onError?: (error: unknown) => void;
}
