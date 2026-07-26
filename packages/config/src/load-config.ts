import { parseYamlSource } from "./config-file.ts";
import { ConfigError } from "./errors.ts";
import { merge, setPath } from "./path.ts";
import type { LoadConfigOptions } from "./types.ts";
import { validateConfig } from "./validation.ts";

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
    return validateConfig(
        options.schema,
        candidate,
        options.defaults ?? {},
        options.onValidationError ?? "throw",
        options.onDiagnostic,
    );
}
