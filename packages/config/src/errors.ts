import type {
    ConfigErrorCause,
    ConfigErrorCode,
    ConfigIssue,
} from "./types.ts";

/** Non-secret metadata retained for safe diagnostic conversion. */
export interface ConfigErrorMetadata {
    readonly code?: ConfigErrorCode;
    readonly cause?: ConfigErrorCause;
    readonly path?: ReadonlyArray<string | number>;
    readonly secretPaths?: ReadonlyArray<ReadonlyArray<string | number>>;
}

/** Typed error that identifies the failed configuration source. */
export class ConfigError extends Error {
    constructor(
        message: string,
        readonly source:
            | "file"
            | "yaml"
            | "environment"
            | "override"
            | "validation",
        readonly issues: ReadonlyArray<ConfigIssue> = [],
        readonly metadata: ConfigErrorMetadata = {},
    ) {
        super(message);
        this.name = "ConfigError";
    }
}
