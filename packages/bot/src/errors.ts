export class RegistryValidationError extends Error {
    constructor(
        readonly code:
            | "duplicate-id"
            | "invalid-id"
            | "missing-parent"
            | "invalid-parent"
            | "builder-name-mismatch"
            | "invalid-module"
            | "empty-source",
        message: string,
    ) {
        super(message);
        this.name = "RegistryValidationError";
    }
}

export class ExecutionTimeoutError extends Error {
    constructor(
        readonly operationId: string,
        readonly timeoutMs: number,
    ) {
        super(`Bot operation "${operationId}" timed out after ${timeoutMs}ms`);
        this.name = "ExecutionTimeoutError";
    }
}
