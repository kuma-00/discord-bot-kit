import { ExecutionTimeoutError } from "./errors.ts";

interface ActiveOperation {
    readonly controller: AbortController;
    readonly promise: Promise<void>;
}

export class OperationTracker {
    private readonly active = new Set<ActiveOperation>();

    async run<T>(
        id: string,
        timeoutMs: number | undefined,
        operation: (signal: AbortSignal) => Promise<T> | T,
    ): Promise<T> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const operationPromise = Promise.resolve(operation(controller.signal));
        const active: ActiveOperation = {
            controller,
            promise: operationPromise.then(
                () => {},
                () => {},
            ),
        };
        this.active.add(active);
        void active.promise.finally(() => this.active.delete(active));
        try {
            if (timeoutMs === undefined) return await operationPromise;
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                throw new RangeError("timeoutMs must be a positive number");
            }
            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort(new ExecutionTimeoutError(id, timeoutMs));
                    reject(new ExecutionTimeoutError(id, timeoutMs));
                }, timeoutMs);
            });
            return await Promise.race([operationPromise, timeoutPromise]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async abortAndSettle(reason: unknown): Promise<void> {
        const operations = [...this.active];
        for (const operation of operations) {
            operation.controller.abort(reason);
        }
        await Promise.allSettled(
            operations.map((operation) => operation.promise),
        );
    }
}
