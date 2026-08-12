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

/** Ordered recovery strategies used after an unexpected disconnect. */
export type VoiceConnectionRecoveryMethod = "grace" | "rejoin" | "recreate";

/** Retry settings for the existing connection's `rejoin` operation. */
export interface VoiceConnectionRejoinRecoveryOptions {
    readonly maxAttempts?: number;
    readonly readyTimeoutMs?: number;
    readonly backoffMs?: number;
}

/** Retry settings for destroying and creating a replacement connection. */
export interface VoiceConnectionRecreateRecoveryOptions {
    readonly enabled?: boolean;
    readonly maxAttempts?: number;
    readonly readyTimeoutMs?: number;
    readonly backoffMs?: number;
}

/** Grace period and bounded retry settings for connection recovery. */
export interface VoiceConnectionRecoveryOptions {
    readonly gracePeriodMs?: number;
    readonly rejoin?: VoiceConnectionRejoinRecoveryOptions;
    readonly recreate?: VoiceConnectionRecreateRecoveryOptions;
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

/** Context delivered before a rejoin or recreate recovery attempt. */
export interface VoiceConnectionRecoveryAttemptContext {
    readonly method: Exclude<VoiceConnectionRecoveryMethod, "grace">;
    readonly attempt: number;
    readonly connection: VoiceConnection;
}

/** Context delivered after any recovery strategy restores readiness. */
export interface VoiceConnectionRecoveredContext {
    readonly method: VoiceConnectionRecoveryMethod;
    readonly connection: VoiceConnection;
}

/** Context delivered when all configured recovery attempts are exhausted. */
export interface VoiceConnectionRecoveryFailedContext {
    readonly error: VoiceConnectionRecoveryError;
    readonly connection: VoiceConnection;
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
        context: VoiceConnectionRecoveryAttemptContext,
    ) => void;
    readonly onRecovered?: (context: VoiceConnectionRecoveredContext) => void;
    readonly onRecoveryFailed?: (
        context: VoiceConnectionRecoveryFailedContext,
    ) => void;
    readonly onError?: (error: unknown) => void;
}
