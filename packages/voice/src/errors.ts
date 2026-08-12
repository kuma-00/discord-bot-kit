import type { VoiceConnectionRecoveryMethod } from "./types.ts";

/** Wraps a failed initial voice connection attempt and preserves its cause. */
export class VoiceConnectionConnectError extends Error {
    constructor(
        message: string,
        readonly cause: unknown,
    ) {
        super(message);
        this.name = "VoiceConnectionConnectError";
    }
}

/** Reports exhaustion of the configured bounded recovery attempts. */
export class VoiceConnectionRecoveryError extends Error {
    constructor(
        readonly method: VoiceConnectionRecoveryMethod,
        readonly attempts: number,
        readonly cause: unknown,
        message: string = `Voice connection ${method} recovery failed after ${attempts} attempts`,
    ) {
        super(message);
        this.name = "VoiceConnectionRecoveryError";
    }
}
