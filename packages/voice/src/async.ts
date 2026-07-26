export function abortError(signal: AbortSignal): unknown {
    return (
        signal.reason ??
        new DOMException("Voice connection operation aborted", "AbortError")
    );
}

export async function withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortError(signal);
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
    });
    const handleAbort = () => rejectAbort?.(abortError(signal));
    signal.addEventListener("abort", handleAbort, { once: true });
    try {
        return await Promise.race([promise, abortPromise]);
    } finally {
        signal.removeEventListener("abort", handleAbort);
    }
}

export function abortableDelay(
    milliseconds: number,
    signal: AbortSignal,
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError(signal));
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", handleAbort);
            resolve();
        }, milliseconds);
        const handleAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", handleAbort);
            reject(abortError(signal));
        };
        signal.addEventListener("abort", handleAbort, { once: true });
    });
}
