import type { SseReconnectOptions } from "./sse.ts";

export interface ResolvedReconnectOptions {
    readonly enabled: boolean;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly multiplier: number;
    readonly jitterRatio: number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveReconnectOptions(
    options: false | SseReconnectOptions | undefined,
): ResolvedReconnectOptions {
    if (options === false) {
        return {
            enabled: false,
            initialDelayMs: 3_000,
            maxDelayMs: 30_000,
            multiplier: 2,
            jitterRatio: 0.2,
        };
    }
    const resolved = {
        enabled: true,
        initialDelayMs: options?.initialDelayMs ?? 3_000,
        maxDelayMs: options?.maxDelayMs ?? 30_000,
        multiplier: options?.multiplier ?? 2,
        jitterRatio: options?.jitterRatio ?? 0.2,
    };
    assertFiniteRange(
        "initialDelayMs",
        resolved.initialDelayMs,
        0,
        MAX_TIMER_DELAY_MS,
    );
    assertFiniteRange("maxDelayMs", resolved.maxDelayMs, 0, MAX_TIMER_DELAY_MS);
    if (resolved.initialDelayMs > resolved.maxDelayMs) {
        throw new TypeError(
            "SSE reconnect initialDelayMs must not exceed maxDelayMs",
        );
    }
    assertFiniteRange("multiplier", resolved.multiplier, 1, Number.MAX_VALUE);
    assertFiniteRange("jitterRatio", resolved.jitterRatio, 0, 1);
    return resolved;
}

export function isRetryableStatus(status: number): boolean {
    return (
        status === 408 ||
        status === 425 ||
        status === 429 ||
        (status >= 500 && status <= 599)
    );
}

export function parseRetryAfter(
    value: string | null,
    now: number,
): number | undefined {
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
    }
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return undefined;
    return Math.max(0, timestamp - now);
}

export function calculateRetryDelay(
    options: ResolvedReconnectOptions,
    consecutiveFailures: number,
    serverRetryMs: number | undefined,
    retryAfterMs: number | undefined,
    random: number,
): number {
    if (retryAfterMs !== undefined) {
        return clampDelay(retryAfterMs, options.maxDelayMs);
    }
    const base = serverRetryMs ?? options.initialDelayMs;
    const exponent = Math.max(0, consecutiveFailures - 1);
    const raw = clampDelay(
        base * options.multiplier ** exponent,
        options.maxDelayMs,
    );
    const boundedRandom = Math.min(1, Math.max(0, random));
    const factor =
        1 - options.jitterRatio + 2 * options.jitterRatio * boundedRandom;
    return clampDelay(Math.round(raw * factor), options.maxDelayMs);
}

export function clampServerRetry(
    value: number,
    maxDelayMs: number,
): number | undefined {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    return clampDelay(value, maxDelayMs);
}

function clampDelay(value: number, maximum: number): number {
    if (!Number.isFinite(value)) return maximum;
    return Math.min(maximum, Math.max(0, Math.round(value)));
}

function assertFiniteRange(
    name: string,
    value: number,
    minimum: number,
    maximum: number,
): void {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new TypeError(
            `SSE reconnect ${name} must be between ${minimum} and ${maximum}`,
        );
    }
}
