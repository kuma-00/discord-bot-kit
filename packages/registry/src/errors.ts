/** Coded failure raised during static registry discovery or generation. */
export class StaticRegistryError extends Error {
    constructor(
        readonly code:
            | "empty-source"
            | "invalid-export-name"
            | "missing-export"
            | "invalid-entry"
            | "stale",
        message: string,
    ) {
        super(message);
        this.name = "StaticRegistryError";
    }
}
