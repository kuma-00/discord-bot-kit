import { describe, expect, test } from "bun:test";
import {
    ConfigError,
    type ConfigSchema,
    loadConfig,
    toConfigDiagnostics,
} from "../src/index.ts";

describe("toConfigDiagnostics", () => {
    test("preserves ordinary validation issues", () => {
        const diagnostic = toConfigDiagnostics(
            new ConfigError(
                "validation failed",
                "validation",
                [
                    {
                        message: "Port must be a number",
                        path: ["server", "port"],
                    },
                ],
                { code: "validation", cause: "validation" },
            ),
        );

        expect(diagnostic).toEqual({
            kind: "config-error",
            code: "validation",
            source: "validation",
            message: "Configuration validation failed",
            issues: [
                {
                    path: ["server", "port"],
                    message: "Port must be a number",
                },
            ],
            cause: "validation",
        });
    });

    test("redacts secret environment parse errors and keeps their path", async () => {
        const schema: ConfigSchema<{ token: string }> = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: (value) => ({ value: value as { token: string } }),
            },
        };

        try {
            await loadConfig({
                schema,
                environment: { TOKEN: "known-secret" },
                bindings: [
                    {
                        env: "TOKEN",
                        path: "credentials.token",
                        secret: true,
                        parse: () => {
                            throw new Error("known-secret");
                        },
                    },
                ],
            });
            throw new Error("Expected loadConfig to fail");
        } catch (error) {
            const diagnostic = toConfigDiagnostics(error);
            expect(diagnostic).toMatchObject({
                kind: "config-error",
                code: "environment-parse",
                source: "environment",
                message: "Unable to parse environment configuration",
                path: ["credentials", "token"],
                cause: "parse",
                issues: [],
            });
            expect(JSON.stringify(diagnostic)).not.toContain("known-secret");
        }
    });

    test("redacts validator messages that include a secret", async () => {
        const schema: ConfigSchema<{ credentials: { token: string } }> = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: () => ({
                    issues: [
                        {
                            message: "Token known-secret is invalid",
                            path: [{ key: "credentials" }, { key: "token" }],
                        },
                    ],
                }),
            },
        };
        let thrown: unknown;
        try {
            await loadConfig({
                schema,
                environment: { TOKEN: "known-secret" },
                bindings: [
                    {
                        env: "TOKEN",
                        path: "credentials.token",
                        secret: true,
                    },
                ],
            });
        } catch (error) {
            thrown = error;
        }
        const diagnostic = toConfigDiagnostics(thrown);

        expect(diagnostic).toMatchObject({
            issues: [
                {
                    path: ["credentials", "token"],
                    message: "Invalid secret configuration value",
                    redacted: true,
                },
            ],
        });
        expect(JSON.stringify(diagnostic)).not.toContain("known-secret");
    });

    test("redacts descendants and ancestors of a nested secret path", () => {
        const secretPaths = [["credentials", "token", "value"]];
        const diagnostic = toConfigDiagnostics(
            new ConfigError(
                "validation failed",
                "validation",
                [
                    {
                        message: "parent secret",
                        path: ["credentials", "token"],
                    },
                    {
                        message: "descendant secret",
                        path: ["credentials", "token", "value", "part"],
                    },
                    {
                        message: "sibling is safe",
                        path: ["credentials", "name"],
                    },
                ],
                { code: "validation", cause: "validation", secretPaths },
            ),
        );

        expect(diagnostic).toMatchObject({
            issues: [
                {
                    message: "Invalid secret configuration value",
                    redacted: true,
                },
                {
                    message: "Invalid secret configuration value",
                    redacted: true,
                },
                { message: "sibling is safe" },
            ],
        });
    });

    test("normalizes Standard Schema object and numeric array paths", () => {
        const diagnostic = toConfigDiagnostics(
            new ConfigError(
                "validation failed",
                "validation",
                [
                    {
                        message: "array secret",
                        path: [{ key: "tokens" }, 1, { key: "value" }],
                    },
                ],
                {
                    code: "validation",
                    cause: "validation",
                    // Dotted environment bindings represent indexes as strings.
                    secretPaths: [["tokens", "1"]],
                },
            ),
        );

        expect(diagnostic).toMatchObject({
            issues: [
                {
                    path: ["tokens", 1, "value"],
                    message: "Invalid secret configuration value",
                    redacted: true,
                },
            ],
        });
    });

    test("safely handles unknown and malformed errors", () => {
        const unknown = toConfigDiagnostics({
            message: "known-secret",
            stack: "known-secret",
            cause: "known-secret",
        });
        expect(unknown).toEqual({
            kind: "unknown-error",
            code: "unknown",
            message: "Unknown configuration error",
            issues: [],
            cause: "unknown",
        });
        expect(JSON.stringify(unknown)).not.toContain("known-secret");

        const malformed = new ConfigError(
            "known-secret",
            "validation",
            [{ message: "known-secret", path: ["token"] }],
            {
                code: "known-secret" as never,
                cause: "known-secret" as never,
                secretPaths: [["token"]],
            },
        );
        const diagnostic = toConfigDiagnostics(malformed);
        expect(diagnostic).toMatchObject({
            kind: "config-error",
            code: "unknown",
            source: "validation",
            message: "Configuration loading failed",
            cause: "unknown",
            issues: [
                {
                    message: "Invalid secret configuration value",
                    redacted: true,
                },
            ],
        });
        expect(JSON.stringify(diagnostic)).not.toContain("known-secret");
    });

    test("attributes missing YAML files to the file source", async () => {
        const schema: ConfigSchema<Record<string, never>> = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: (value) => ({
                    value: value as Record<string, never>,
                }),
            },
        };
        const path = `/tmp/bot-kit-config-missing-${crypto.randomUUID()}.yaml`;

        try {
            await loadConfig({
                schema,
                file: path,
                bindings: [{ env: "TOKEN", path: "token", secret: true }],
            });
            throw new Error("Expected loadConfig to fail");
        } catch (error) {
            expect(toConfigDiagnostics(error)).toMatchObject({
                kind: "config-error",
                code: "file-not-found",
                source: "file",
                message: "Configuration file does not exist",
                cause: "missing",
            });
        }
    });
});
