import { ConfigError } from "./errors.ts";
import { pathKeys } from "./path.ts";
import type {
    ConfigDiagnostic,
    ConfigDiagnosticHandler,
    ConfigErrorCause,
    ConfigErrorCode,
    ConfigErrorDiagnostic,
} from "./types.ts";

const redactedIssueMessage = "Invalid secret configuration value";
const configErrorCodes = new Set<ConfigErrorCode>([
    "invalid-options",
    "file-not-found",
    "file-read",
    "file-create",
    "yaml-parse",
    "environment-path",
    "environment-parse",
    "validation",
    "validation-default",
    "validation-convergence",
    "secret-template",
    "unknown",
]);
const configErrorCauses = new Set<ConfigErrorCause>([
    "conflict",
    "missing",
    "read",
    "write",
    "parse",
    "unsafe-path",
    "validation",
    "unknown",
]);
const configErrorSources = new Set([
    "file",
    "yaml",
    "environment",
    "override",
    "validation",
]);

function pathsOverlap(
    left: ReadonlyArray<string | number>,
    right: ReadonlyArray<string | number>,
): boolean {
    const length = Math.min(left.length, right.length);
    return left
        .slice(0, length)
        .every((part, index) => String(part) === String(right[index]));
}

function safeCode(error: ConfigError): ConfigErrorCode {
    return configErrorCodes.has(error.metadata.code as ConfigErrorCode)
        ? (error.metadata.code as ConfigErrorCode)
        : "unknown";
}

function safeCause(error: ConfigError): ConfigErrorCause {
    return configErrorCauses.has(error.metadata.cause as ConfigErrorCause)
        ? (error.metadata.cause as ConfigErrorCause)
        : "unknown";
}

function normalizePath(
    value: unknown,
): ReadonlyArray<string | number> | undefined {
    return Array.isArray(value) ? pathKeys(value) : undefined;
}

function safeMessage(code: ConfigErrorCode): string {
    switch (code) {
        case "invalid-options":
            return "Configuration options conflict";
        case "file-not-found":
            return "Configuration file does not exist";
        case "file-read":
            return "Unable to read configuration file";
        case "file-create":
            return "Unable to create configuration file";
        case "yaml-parse":
            return "Unable to parse YAML configuration";
        case "environment-path":
            return "Environment binding path is empty or unsafe";
        case "environment-parse":
            return "Unable to parse environment configuration";
        case "validation":
            return "Configuration validation failed";
        case "validation-default":
            return "Configuration validation failed and no usable default is available";
        case "validation-convergence":
            return "Configuration validation did not converge after applying defaults";
        case "secret-template":
            return "Configuration template contains a secret path";
        default:
            return "Configuration loading failed";
    }
}

/**
 * Converts an arbitrary thrown value to logger-neutral configuration diagnostics.
 *
 * Validation messages whose paths overlap a secret environment binding are
 * replaced rather than copied. Raw causes, stacks, configuration values, and
 * environment values are never included in the returned object.
 */
export function toConfigDiagnostics(error: unknown): ConfigErrorDiagnostic {
    if (
        !(error instanceof ConfigError) ||
        !configErrorSources.has(error.source)
    ) {
        return {
            kind: "unknown-error",
            code: "unknown",
            message: "Unknown configuration error",
            issues: [],
            cause: "unknown",
        };
    }

    const secretPaths = Array.isArray(error.metadata.secretPaths)
        ? error.metadata.secretPaths
              .map(normalizePath)
              .filter(
                  (path): path is ReadonlyArray<string | number> =>
                      path !== undefined,
              )
        : [];
    const issues = (Array.isArray(error.issues) ? error.issues : []).map(
        (issue) => {
            const path = normalizePath(
                typeof issue === "object" && issue !== null
                    ? issue.path
                    : undefined,
            );
            const redacted =
                path === undefined
                    ? secretPaths.length > 0
                    : secretPaths.some((secretPath) =>
                          pathsOverlap(path, secretPath),
                      );
            return {
                ...(path === undefined ? {} : { path }),
                message: redacted
                    ? redactedIssueMessage
                    : typeof issue === "object" &&
                        issue !== null &&
                        typeof issue.message === "string"
                      ? issue.message
                      : "Invalid configuration value",
                ...(redacted ? { redacted: true as const } : {}),
            };
        },
    );

    const code = safeCode(error);
    const path = normalizePath(error.metadata.path);
    return {
        kind: "config-error",
        code,
        source: error.source,
        message: safeMessage(code),
        ...(path === undefined ? {} : { path }),
        issues,
        cause: safeCause(error),
    };
}

export async function emitDiagnostic(
    handler: ConfigDiagnosticHandler | undefined,
    diagnostic: ConfigDiagnostic,
): Promise<void> {
    await handler?.(diagnostic);
}
