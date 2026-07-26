import { resolve } from "node:path";
import { createConfigFile } from "./config-file.ts";
import { emitDiagnostic } from "./diagnostics.ts";
import { ConfigError } from "./errors.ts";
import { loadConfig } from "./load-config.ts";
import { dottedPathKeys, pathKeys } from "./path.ts";
import type {
    ConfigDefinition,
    ConfigSchema,
    LoadDefinedConfigOptions,
    SchemaOutput,
} from "./types.ts";

/** Defines a reusable configuration while preserving its inferred schema type. */
export function defineConfig<const TSchema extends ConfigSchema<unknown>>(
    definition: ConfigDefinition<TSchema>,
): ConfigDefinition<TSchema> {
    return definition;
}

/** Loads a reusable definition from its automatically managed YAML file. */
export async function loadDefinedConfig<
    const TSchema extends ConfigSchema<unknown>,
>(
    definition: ConfigDefinition<TSchema>,
    options: LoadDefinedConfigOptions = {},
): Promise<SchemaOutput<TSchema>> {
    const configuredPath =
        options.file ?? definition.file?.path ?? "config.yaml";
    const file = resolve(configuredPath);
    const shouldCreate = definition.file?.create ?? true;
    const onDiagnostic = options.onDiagnostic ?? definition.onDiagnostic;

    if (!(await Bun.file(file).exists()) && shouldCreate) {
        await createConfigFile(
            file,
            definition.file?.template ?? {},
            definition.bindings ?? [],
            onDiagnostic,
        );
    }

    try {
        return await loadConfig<SchemaOutput<TSchema>>({
            schema: definition.schema as ConfigSchema<SchemaOutput<TSchema>>,
            file,
            ...(definition.defaults === undefined
                ? {}
                : { defaults: definition.defaults }),
            ...(options.environment === undefined
                ? {}
                : { environment: options.environment }),
            ...(definition.bindings === undefined
                ? {}
                : { bindings: definition.bindings }),
            ...(options.override === undefined
                ? {}
                : { override: options.override }),
            ...(definition.onValidationError === undefined
                ? {}
                : { onValidationError: definition.onValidationError }),
            ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
        });
    } catch (error) {
        if (error instanceof ConfigError && error.source === "validation") {
            for (const binding of definition.bindings ?? []) {
                if (!binding.secret) continue;
                const bindingPath = dottedPathKeys(binding.path);
                const matchesIssue = error.issues.some((issue) => {
                    const issuePath =
                        issue.path === undefined
                            ? undefined
                            : pathKeys(issue.path);
                    return (
                        issuePath !== undefined &&
                        issuePath.map(String).join(".") === binding.path
                    );
                });
                if (!matchesIssue) continue;
                await emitDiagnostic(onDiagnostic, {
                    type: "configuration-required",
                    path: bindingPath,
                    environment: binding.env,
                });
            }
        }
        throw error;
    }
}
