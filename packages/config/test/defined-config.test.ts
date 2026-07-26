import { describe, expect, expectTypeOf, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ConfigError,
    type ConfigSchema,
    defineConfig,
    type InferConfig,
    loadDefinedConfig,
} from "../src/index.ts";
import { configSchema, type TestConfig } from "./test-config.ts";

describe("defined configuration", () => {
    test("infers the schema output type", () => {
        const definition = defineConfig({
            schema: configSchema,
            defaults: {
                port: 3000,
                nested: { value: "default" },
            },
        });
        expectTypeOf<
            InferConfig<typeof definition>
        >().toEqualTypeOf<TestConfig>();
    });

    test("creates and automatically loads the default config file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-"));
        const previousDirectory = process.cwd();
        const diagnostics: unknown[] = [];
        try {
            process.chdir(directory);
            const definition = defineConfig({
                schema: configSchema,
                defaults: { token: "runtime-default" },
                file: {
                    template: {
                        port: 4100,
                        nested: { value: "generated" },
                    },
                },
                onDiagnostic: (diagnostic) => {
                    diagnostics.push(diagnostic);
                },
            });

            const result = await loadDefinedConfig(definition);

            expect(result).toEqual({
                port: 4100,
                nested: { value: "generated" },
                token: "runtime-default",
            });
            expect(await readFile(join(directory, "config.yaml"), "utf8")).toBe(
                "port: 4100\nnested:\n  value: generated\n",
            );
            expect(diagnostics).toContainEqual(
                expect.objectContaining({
                    type: "file-created",
                }),
            );
        } finally {
            process.chdir(previousDirectory);
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("allows a runtime file path override", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-"));
        const file = join(directory, "custom.yaml");
        try {
            const definition = defineConfig({
                schema: configSchema,
                defaults: { token: "default" },
                file: {
                    path: join(directory, "ignored.yaml"),
                    template: {
                        port: 4200,
                        nested: { value: "custom" },
                    },
                },
            });
            const result = await loadDefinedConfig(definition, { file });
            expect(result.port).toBe(4200);
            expect(await Bun.file(file).exists()).toBe(true);
            expect(
                await Bun.file(join(directory, "ignored.yaml")).exists(),
            ).toBe(false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("does not overwrite a file during concurrent creation", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-"));
        const file = join(directory, "config.yaml");
        try {
            const definition = defineConfig({
                schema: configSchema,
                defaults: { token: "default" },
                file: {
                    path: file,
                    template: {
                        port: 4300,
                        nested: { value: "concurrent" },
                    },
                },
            });
            const [first, second] = await Promise.all([
                loadDefinedConfig(definition),
                loadDefinedConfig(definition),
            ]);
            expect(first).toEqual(second);
            expect((await readFile(file, "utf8")).match(/port:/g)).toHaveLength(
                1,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects secret values in generated templates", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-"));
        const file = join(directory, "config.yaml");
        try {
            const definition = defineConfig({
                schema: configSchema,
                file: {
                    path: file,
                    template: {
                        port: 4400,
                        nested: { value: "secret-test" },
                        token: "must-not-be-written",
                    },
                },
                bindings: [
                    { env: "DISCORD_TOKEN", path: "token", secret: true },
                ],
            });
            await expect(loadDefinedConfig(definition)).rejects.toMatchObject({
                source: "file",
                message:
                    "Configuration template must not contain secret path token",
            });
            expect(await Bun.file(file).exists()).toBe(false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("keeps an invalid file unchanged when defaults repair it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-"));
        const file = join(directory, "config.yaml");
        const contents =
            "port: invalid\nnested:\n  value: configured\ntoken: configured\n";
        try {
            await Bun.write(file, contents);
            const definition = defineConfig({
                schema: configSchema,
                defaults: { port: 4500 },
                file: { path: file, create: false },
                onValidationError: "use-defaults",
            });
            const result = await loadDefinedConfig(definition);
            expect(result.port).toBe(4500);
            expect(await readFile(file, "utf8")).toBe(contents);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("identifies the environment variable for a missing secret", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-"));
        const file = join(directory, "config.yaml");
        const diagnostics: unknown[] = [];
        const requiredTokenSchema: ConfigSchema<TestConfig> = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: (value) => {
                    const config = value as Partial<TestConfig>;
                    return typeof config.token === "string"
                        ? { value: config as TestConfig }
                        : {
                              issues: [
                                  {
                                      message: "Token is required",
                                      path: ["token"],
                                  },
                              ],
                          };
                },
            },
        };
        try {
            const definition = defineConfig({
                schema: requiredTokenSchema,
                file: {
                    path: file,
                    template: {},
                },
                bindings: [
                    { env: "DISCORD_TOKEN", path: "token", secret: true },
                ],
                onDiagnostic: (diagnostic) => {
                    diagnostics.push(diagnostic);
                },
            });
            await expect(
                loadDefinedConfig(definition, { environment: {} }),
            ).rejects.toBeInstanceOf(ConfigError);
            expect(diagnostics).toContainEqual({
                type: "configuration-required",
                path: ["token"],
                environment: "DISCORD_TOKEN",
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
