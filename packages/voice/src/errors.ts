export class VoiceConnectionConnectError extends Error {
    constructor(
        message: string,
        readonly cause: unknown,
    ) {
        super(message);
        this.name = "VoiceConnectionConnectError";
    }
}

export class VoiceConnectionRecoveryError extends Error {
    constructor(
        readonly attempts: number,
        readonly cause: unknown,
    ) {
        super(`Voice connection recovery failed after ${attempts} attempts`);
        this.name = "VoiceConnectionRecoveryError";
    }
}
