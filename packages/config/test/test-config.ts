import type { ConfigSchema } from "../src/index.ts";

export interface TestConfig {
    port: number;
    nested: { value: string };
    token: string;
}

export const configSchema: ConfigSchema<TestConfig> = {
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
