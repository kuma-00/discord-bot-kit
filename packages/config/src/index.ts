import { parse as parseYaml } from "yaml";

/** Minimal Standard Schema interface accepted by the config loader. */
export interface ConfigSchema<T> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
        ) =>
            | { readonly value: T; readonly issues?: undefined }
            | { readonly issues: ReadonlyArray<ConfigIssue> }
            | Promise<
                  | { readonly value: T; readonly issues?: undefined }
                  | { readonly issues: ReadonlyArray<ConfigIssue> }
              >;
    };
}

/** Schema issue shape used in configuration errors. */
export interface ConfigIssue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** Maps an environment variable to a dotted configuration path. */
export interface EnvironmentBinding {
    readonly env: string;
    readonly path: string;
    readonly parse?: (value: string) => unknown;
    readonly secret?: boolean;
}

/** Options for loading and validating application configuration. */
export interface LoadConfigOptions<T> {
    readonly schema: ConfigSchema<T>;
    readonly defaults?: unknown;
    readonly file?: string;
    readonly yaml?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly bindings?: ReadonlyArray<EnvironmentBinding>;
    readonly override?: unknown;
}

/** Typed error that identifies the failed configuration source. */
export class ConfigError extends Error {
    constructor(
        message: string,
        readonly source:
            | "file"
            | "yaml"
            | "environment"
            | "override"
            | "validation",
        readonly issues: ReadonlyArray<ConfigIssue> = [],
    ) {
        super(message);
        this.name = "ConfigError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(left: unknown, right: unknown): unknown {
    if (!isRecord(left) || !isRecord(right)) return right;
    const result: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
        result[key] = key in result ? merge(result[key], value) : value;
    }
    return result;
}

function setPath(
    target: Record<string, unknown>,
    path: string,
    value: unknown,
): void {
    const keys = path.split(".").filter(Boolean);
    if (keys.length === 0) {
        throw new ConfigError(
            "Environment binding path cannot be empty",
            "environment",
        );
    }
    let cursor = target;
    for (const key of keys.slice(0, -1)) {
        const next = cursor[key];
        if (!isRecord(next)) cursor[key] = {};
        cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[keys.at(-1) as string] = value;
}

function parseYamlSource(source: string, origin: "file" | "yaml"): unknown {
    try {
        return parseYaml(source) ?? {};
    } catch {
        throw new ConfigError(
            `Unable to parse ${origin} configuration`,
            origin,
        );
    }
}

/** Loads defaults, YAML, environment values, and overrides in that order. */
export async function loadConfig<T>(options: LoadConfigOptions<T>): Promise<T> {
    if (options.file !== undefined && options.yaml !== undefined) {
        throw new ConfigError("Specify either file or yaml, not both", "yaml");
    }

    let yamlConfig: unknown = {};
    if (options.file !== undefined) {
        try {
            const file = Bun.file(options.file);
            if (!(await file.exists())) {
                throw new ConfigError(
                    `Configuration file does not exist: ${options.file}`,
                    "file",
                );
            }
            yamlConfig = parseYamlSource(await file.text(), "file");
        } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError(
                `Unable to read configuration file: ${options.file}`,
                "file",
            );
        }
    } else if (options.yaml !== undefined) {
        yamlConfig = parseYamlSource(options.yaml, "yaml");
    }

    const environmentConfig: Record<string, unknown> = {};
    const environment = options.environment ?? process.env;
    for (const binding of options.bindings ?? []) {
        const raw = environment[binding.env];
        if (raw === undefined) continue;
        try {
            setPath(
                environmentConfig,
                binding.path,
                binding.parse?.(raw) ?? raw,
            );
        } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError(
                `Unable to parse environment variable ${binding.env}${
                    binding.secret ? " (redacted)" : ""
                }`,
                "environment",
            );
        }
    }

    const candidate = merge(
        merge(merge(options.defaults ?? {}, yamlConfig), environmentConfig),
        options.override ?? {},
    );
    const result = await options.schema["~standard"].validate(candidate);
    if ("issues" in result) {
        throw new ConfigError(
            "Configuration validation failed",
            "validation",
            result.issues,
        );
    }
    return result.value;
}
