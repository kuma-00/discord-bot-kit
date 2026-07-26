import { ConfigError } from "./errors.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const unsafePathKeys = new Set(["__proto__", "constructor", "prototype"]);

export function pathKeys(
    path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>,
): ReadonlyArray<string | number> | undefined {
    const keys = path.map((part) =>
        typeof part === "object" && part !== null ? part.key : part,
    );
    return keys.length > 0 &&
        keys.every(
            (key): key is string | number =>
                typeof key !== "symbol" && !unsafePathKeys.has(String(key)),
        )
        ? keys
        : undefined;
}

export function dottedPathKeys(path: string): ReadonlyArray<string> {
    const keys = path.split(".").filter(Boolean);
    if (keys.length === 0 || keys.some((key) => unsafePathKeys.has(key))) {
        throw new ConfigError(
            "Environment binding path is empty or unsafe",
            "environment",
        );
    }
    return keys;
}

export function valueAtPath(
    value: unknown,
    keys: ReadonlyArray<string | number>,
): { readonly found: boolean; readonly value?: unknown } {
    let cursor = value;
    for (const key of keys) {
        if (!isRecord(cursor) || !Object.hasOwn(cursor, key)) {
            return { found: false };
        }
        cursor = cursor[key];
    }
    return { found: true, value: cursor };
}

export function setPath(
    target: Record<string, unknown>,
    path: string,
    value: unknown,
): void {
    setKeys(target, dottedPathKeys(path), value);
}

export function setKeys(
    target: Record<string, unknown>,
    keys: ReadonlyArray<string | number>,
    value: unknown,
): void {
    let cursor = target;
    for (const key of keys.slice(0, -1)) {
        const stringKey = String(key);
        const next = cursor[stringKey];
        if (!isRecord(next)) cursor[stringKey] = {};
        cursor = cursor[stringKey] as Record<string, unknown>;
    }
    cursor[String(keys.at(-1))] = value;
}

export function merge(left: unknown, right: unknown): unknown {
    if (!isRecord(left) || !isRecord(right)) return right;
    const result: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
        result[key] = key in result ? merge(result[key], value) : value;
    }
    return result;
}

export { isRecord };
