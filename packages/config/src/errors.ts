import type { ConfigIssue } from "./types.ts";

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
    ) {
        super(message);
        this.name = "ConfigError";
    }
}
