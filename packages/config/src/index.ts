import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

type SchemaOutput<TSchema extends ConfigSchema<unknown>> =
    TSchema extends ConfigSchema<infer TOutput> ? TOutput : never;

/** Recursively optional configuration shape accepted by defaults and templates. */
export type DeepPartial<T> =
    T extends ReadonlyArray<infer TItem>
        ? ReadonlyArray<DeepPartial<TItem>>
        : T extends object
          ? { readonly [TKey in keyof T]?: DeepPartial<T[TKey]> }
          : T;

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
    readonly onValidationError?: ValidationErrorPolicy;
    readonly onDiagnostic?: ConfigDiagnosticHandler;
}

/** Behavior used when the merged configuration does not pass validation. */
export type ValidationErrorPolicy = "throw" | "use-defaults";

/** Non-secret lifecycle information emitted by configuration loading. */
export type ConfigDiagnostic =
    | {
          readonly type: "file-created";
          readonly path: string;
      }
    | {
          readonly type: "default-used";
          readonly path: ReadonlyArray<string | number>;
      }
    | {
          readonly type: "configuration-required";
          readonly path?: ReadonlyArray<string | number>;
          readonly environment?: string;
      };

/** Receives structured configuration diagnostics. */
export type ConfigDiagnosticHandler = (
    diagnostic: ConfigDiagnostic,
) => void | Promise<void>;

/** File behavior used by a defined configuration. */
export interface DefinedConfigFile<T> {
    readonly path?: string;
    readonly create?: boolean;
    readonly template?: string | DeepPartial<T>;
}

/** Reusable, typed configuration definition. */
export interface ConfigDefinition<TSchema extends ConfigSchema<unknown>> {
    readonly schema: TSchema;
    readonly defaults?: DeepPartial<SchemaOutput<TSchema>>;
    readonly file?: DefinedConfigFile<SchemaOutput<TSchema>>;
    readonly bindings?: ReadonlyArray<EnvironmentBinding>;
    readonly onValidationError?: ValidationErrorPolicy;
    readonly onDiagnostic?: ConfigDiagnosticHandler;
}

/** Infers the validated output type of a configuration definition. */
export type InferConfig<
    TDefinition extends ConfigDefinition<ConfigSchema<unknown>>,
> = SchemaOutput<TDefinition["schema"]>;

/** Runtime-only inputs for loading a reusable configuration definition. */
export interface LoadDefinedConfigOptions {
    readonly file?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly override?: unknown;
    readonly onDiagnostic?: ConfigDiagnosticHandler;
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

const unsafePathKeys = new Set(["__proto__", "constructor", "prototype"]);

function pathKeys(
    path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>,
): ReadonlyArray<string | number> | undefined {
    const keys = path.map((part) =>
        typeof part === "object" && part !== null ? part.key : part,
    );
    return keys.length > 0 &&
        keys.every(
            (key): key is string | number =>
                typeof key !== "symbol" && !unsafePathKeys.has(String(key)),
        )
        ? keys
        : undefined;
}

function dottedPathKeys(path: string): ReadonlyArray<string> {
    const keys = path.split(".").filter(Boolean);
    if (keys.length === 0 || keys.some((key) => unsafePathKeys.has(key))) {
        throw new ConfigError(
            "Environment binding path is empty or unsafe",
            "environment",
        );
    }
    return keys;
}

function valueAtPath(
    value: unknown,
    keys: ReadonlyArray<string | number>,
): { readonly found: boolean; readonly value?: unknown } {
    let cursor = value;
    for (const key of keys) {
        if (!isRecord(cursor) || !Object.hasOwn(cursor, key)) {
            return { found: false };
        }
        cursor = cursor[key];
    }
    return { found: true, value: cursor };
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
    const keys = dottedPathKeys(path);
    setKeys(target, keys, value);
}

function setKeys(
    target: Record<string, unknown>,
    keys: ReadonlyArray<string | number>,
    value: unknown,
): void {
    let cursor = target;
    for (const key of keys.slice(0, -1)) {
        const stringKey = String(key);
        const next = cursor[stringKey];
        if (!isRecord(next)) cursor[stringKey] = {};
        cursor = cursor[stringKey] as Record<string, unknown>;
    }
    cursor[String(keys.at(-1))] = value;
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

async function emitDiagnostic(
    handler: ConfigDiagnosticHandler | undefined,
    diagnostic: ConfigDiagnostic,
): Promise<void> {
    await handler?.(diagnostic);
}

async function validateConfig<T>(
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

/** Defines a reusable configuration while preserving its inferred schema type. */
export function defineConfig<const TSchema extends ConfigSchema<unknown>>(
    definition: ConfigDefinition<TSchema>,
): ConfigDefinition<TSchema> {
    return definition;
}

function assertTemplateHasNoSecrets(
    template: unknown,
    bindings: ReadonlyArray<EnvironmentBinding>,
): void {
    for (const binding of bindings) {
        if (!binding.secret) continue;
        const keys = dottedPathKeys(binding.path);
        if (valueAtPath(template, keys).found) {
            throw new ConfigError(
                `Configuration template must not contain secret path ${binding.path}`,
                "file",
            );
        }
    }
}

async function createConfigFile(
    path: string,
    template: string | unknown,
    bindings: ReadonlyArray<EnvironmentBinding>,
    onDiagnostic?: ConfigDiagnosticHandler,
): Promise<void> {
    const parsedTemplate =
        typeof template === "string"
            ? parseYamlSource(template, "yaml")
            : template;
    assertTemplateHasNoSecrets(parsedTemplate, bindings);
    const contents =
        typeof template === "string" ? template : stringifyYaml(template ?? {});

    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
        handle = await open(temporaryPath, "wx");
        await handle.writeFile(contents, "utf8");
        await handle.close();
        handle = undefined;
        await link(temporaryPath, path);
        await emitDiagnostic(onDiagnostic, { type: "file-created", path });
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
        ) {
            return;
        }
        throw new ConfigError(
            `Unable to create configuration file: ${path}`,
            "file",
        );
    } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
    }
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
