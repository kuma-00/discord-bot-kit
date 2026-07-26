import { emitDiagnostic } from "./diagnostics.ts";
import { ConfigError } from "./errors.ts";
import { isRecord, pathKeys, setKeys, valueAtPath } from "./path.ts";
import type {
    ConfigDiagnosticHandler,
    ConfigSchema,
    ValidationErrorPolicy,
} from "./types.ts";

export async function validateConfig<T>(
    schema: ConfigSchema<T>,
    candidate: unknown,
    defaults: unknown,
    policy: ValidationErrorPolicy,
    onDiagnostic?: ConfigDiagnosticHandler,
): Promise<T> {
    const current = structuredClone(candidate);
    const repairedPaths = new Set<string>();
    const maximumAttempts = 32;

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const result = await schema["~standard"].validate(current);
        if (result.issues === undefined) return result.value;
        if (policy === "throw" || !isRecord(current)) {
            for (const issue of result.issues) {
                const keys =
                    issue.path === undefined ? undefined : pathKeys(issue.path);
                await emitDiagnostic(onDiagnostic, {
                    type: "configuration-required",
                    ...(keys === undefined ? {} : { path: keys }),
                });
            }
            throw new ConfigError(
                "Configuration validation failed",
                "validation",
                result.issues,
            );
        }

        const repairs = new Map<
            string,
            {
                readonly keys: ReadonlyArray<string | number>;
                readonly value: unknown;
            }
        >();
        for (const issue of result.issues) {
            const keys =
                issue.path === undefined ? undefined : pathKeys(issue.path);
            const pathId = keys?.map(String).join(".");
            const fallback =
                keys === undefined
                    ? { found: false as const }
                    : valueAtPath(defaults, keys);
            if (
                keys === undefined ||
                pathId === undefined ||
                repairedPaths.has(pathId) ||
                !fallback.found
            ) {
                await emitDiagnostic(onDiagnostic, {
                    type: "configuration-required",
                    ...(keys === undefined ? {} : { path: keys }),
                });
                throw new ConfigError(
                    "Configuration validation failed and no usable default is available",
                    "validation",
                    result.issues,
                );
            }
            repairs.set(pathId, { keys, value: fallback.value });
        }
        for (const [pathId, repair] of repairs) {
            setKeys(current, repair.keys, structuredClone(repair.value));
            repairedPaths.add(pathId);
            await emitDiagnostic(onDiagnostic, {
                type: "default-used",
                path: repair.keys,
            });
        }
        if (repairs.size === 0) break;
    }

    throw new ConfigError(
        "Configuration validation did not converge after applying defaults",
        "validation",
    );
}
