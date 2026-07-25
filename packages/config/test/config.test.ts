import { describe, expect, test } from "bun:test";
import { ConfigError, type ConfigSchema, loadConfig } from "../src/index.ts";

interface TestConfig {
    port: number;
    nested: { value: string };
    token: string;
}

const configSchema: ConfigSchema<TestConfig> = {
    "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
            const config = value as Partial<TestConfig>;
            return typeof config.port === "number" &&
                typeof config.nested?.value === "string" &&
                typeof config.token === "string"
                ? { value: config as TestConfig }
                : { issues: [{ message: "Invalid config", path: ["port"] }] };
        },
    },
};

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
});
