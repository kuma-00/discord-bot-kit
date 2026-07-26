import { describe, expect, test } from "bun:test";
import { ConfigError, type ConfigSchema, loadConfig } from "../src/index.ts";
import { configSchema, type TestConfig } from "./test-config.ts";

describe("loadConfig", () => {
    test("merges sources in documented precedence order", async () => {
        const result = await loadConfig({
            schema: configSchema,
            defaults: { port: 1, nested: { value: "default" }, token: "a" },
            yaml: "port: 2\nnested:\n  value: yaml\n",
            environment: { PORT: "3", TOKEN: "secret" },
            bindings: [
                { env: "PORT", path: "port", parse: Number },
                { env: "TOKEN", path: "token", secret: true },
            ],
            override: { nested: { value: "override" } },
        });
        expect(result).toEqual({
            port: 3,
            nested: { value: "override" },
            token: "secret",
        });
    });

    test("reports invalid YAML without including source contents", async () => {
        await expect(
            loadConfig({ schema: configSchema, yaml: "token: [secret" }),
        ).rejects.toMatchObject({
            name: "ConfigError",
            source: "yaml",
            message: "Unable to parse yaml configuration",
        });
    });

    test("redacts secret environment values when parsing fails", async () => {
        try {
            await loadConfig({
                schema: configSchema,
                defaults: { port: 1, nested: { value: "x" }, token: "x" },
                environment: { SECRET: "do-not-leak" },
                bindings: [
                    {
                        env: "SECRET",
                        path: "token",
                        secret: true,
                        parse: () => {
                            throw new Error("do-not-leak");
                        },
                    },
                ],
            });
            throw new Error("Expected loadConfig to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
            expect(String(error)).not.toContain("do-not-leak");
        }
    });

    test("rejects unsafe environment binding paths", async () => {
        await expect(
            loadConfig({
                schema: configSchema,
                defaults: {
                    port: 1,
                    nested: { value: "x" },
                    token: "x",
                },
                environment: { VALUE: "pollution" },
                bindings: [{ env: "VALUE", path: "__proto__.polluted" }],
            }),
        ).rejects.toMatchObject({
            source: "environment",
            message: "Environment binding path is empty or unsafe",
        });
        expect(
            (Object.prototype as unknown as Record<string, unknown>).polluted,
        ).toBeUndefined();
    });

    test("replaces only invalid paths with defaults at runtime", async () => {
        const diagnostics: unknown[] = [];
        const result = await loadConfig({
            schema: configSchema,
            defaults: {
                port: 3000,
                nested: { value: "default" },
                token: "default-token",
            },
            yaml: "port: invalid\nnested:\n  value: configured\ntoken: configured\n",
            onValidationError: "use-defaults",
            onDiagnostic: (diagnostic) => {
                diagnostics.push(diagnostic);
            },
        });

        expect(result).toEqual({
            port: 3000,
            nested: { value: "configured" },
            token: "configured",
        });
        expect(diagnostics).toContainEqual({
            type: "default-used",
            path: ["port"],
        });
    });

    test("stops when an invalid path has no default", async () => {
        await expect(
            loadConfig({
                schema: configSchema,
                defaults: {
                    nested: { value: "default" },
                    token: "default-token",
                },
                yaml: "port: invalid\n",
                onValidationError: "use-defaults",
            }),
        ).rejects.toMatchObject({
            source: "validation",
            message:
                "Configuration validation failed and no usable default is available",
        });
    });

    test("stops without reporting applied defaults when any issue cannot recover", async () => {
        const diagnostics: unknown[] = [];
        const schemaWithMultipleIssues: ConfigSchema<TestConfig> = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: () => ({
                    issues: [
                        { message: "Invalid port", path: ["port"] },
                        { message: "Invalid token" },
                    ],
                }),
            },
        };
        await expect(
            loadConfig({
                schema: schemaWithMultipleIssues,
                defaults: { port: 3000 },
                yaml: "port: invalid\n",
                onValidationError: "use-defaults",
                onDiagnostic: (diagnostic) => {
                    diagnostics.push(diagnostic);
                },
            }),
        ).rejects.toBeInstanceOf(ConfigError);
        expect(diagnostics).not.toContainEqual(
            expect.objectContaining({ type: "default-used" }),
        );
    });
});
