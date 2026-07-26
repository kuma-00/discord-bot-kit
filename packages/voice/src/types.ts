import type {
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceConnectionRecoveryError } from "./errors.ts";

export type VoiceConnectionState =
    | "idle"
    | "connecting"
    | "ready"
    | "reconnecting"
    | "disconnecting"
    | "destroyed"
    | "error";

export interface VoiceConnectionRecoveryOptions {
    readonly gracePeriodMs?: number;
    readonly maxAttempts?: number;
    readonly readyTimeoutMs?: number;
    readonly backoffMs?: number;
}

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
