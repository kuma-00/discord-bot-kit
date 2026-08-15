import { stringify as stringifyYaml } from "yaml";
import {
    type ConfigFileSnapshot,
    parseYamlSource,
    readConfigFileSnapshot,
    writeMigratedConfigFile,
} from "./config-file.ts";
import { ConfigError } from "./errors.ts";
import { dottedPathKeys, merge, setPath } from "./path.ts";
import type { ConfigMigration, LoadConfigOptions } from "./types.ts";
import { validateConfig } from "./validation.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validVersion(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    );
}

/** Validates migration options before any configuration I/O occurs. */
export function validateMigrations(
    version: number | undefined,
    migrations: ReadonlyArray<ConfigMigration> | undefined,
    secretPaths: ReadonlyArray<ReadonlyArray<string | number>>,
): void {
    if (version === undefined && migrations !== undefined) {
        throw new ConfigError(
            "Migration options require a target version",
            "yaml",
            [],
            {
                code: "migration-options",
                cause: "validation",
                secretPaths,
            },
        );
    }
    if (version !== undefined && !validVersion(version)) {
        throw new ConfigError(
            "Configuration version must be a positive safe integer",
            "yaml",
            [],
            {
                code: "migration-options",
                cause: "validation",
                secretPaths,
            },
        );
    }
    if (migrations === undefined) {
        if (version !== undefined && version > 1) {
            throw new ConfigError(
                "Configuration migrations must cover every version",
                "yaml",
                [],
                {
                    code: "migration-options",
                    cause: "validation",
                    secretPaths,
                },
            );
        }
        return;
    }
    const seen = new Set<number>();
    for (const migration of migrations) {
        if (
            !validVersion(migration.from) ||
            !validVersion(migration.to) ||
            migration.to !== migration.from + 1 ||
            typeof migration.migrate !== "function" ||
            seen.has(migration.from) ||
            (version !== undefined && migration.to > version)
        ) {
            throw new ConfigError(
                "Configuration migrations must be sequential and target the configured version",
                "yaml",
                [],
                {
                    code: "migration-options",
                    cause: "validation",
                    secretPaths,
                },
            );
        }
        seen.add(migration.from);
    }
    if (version !== undefined) {
        for (let from = 1; from < version; from += 1) {
            if (!seen.has(from)) {
                throw new ConfigError(
                    "Configuration migrations must cover every version",
                    "yaml",
                    [],
                    {
                        code: "migration-options",
                        cause: "validation",
                        secretPaths,
                    },
                );
            }
        }
    }
}

async function migrateYaml(
    value: unknown,
    version: number | undefined,
    migrations: ReadonlyArray<ConfigMigration> | undefined,
    secretPaths: ReadonlyArray<ReadonlyArray<string | number>>,
    source: "file" | "yaml",
): Promise<{ value: unknown; changed: boolean; from: number; to: number }> {
    if (version === undefined) return { value, changed: false, from: 1, to: 1 };
    if (!isRecord(value)) {
        throw new ConfigError(
            "Versioned YAML configuration must be a mapping",
            source,
            [],
            { code: "migration", cause: "validation", secretPaths },
        );
    }
    const sourceVersion =
        isRecord(value) && value.version !== undefined ? value.version : 1;
    if (!validVersion(sourceVersion)) {
        throw new ConfigError("Configuration version is invalid", source, [], {
            code: "migration",
            cause: "validation",
            secretPaths,
        });
    }
    if (sourceVersion > version) {
        throw new ConfigError(
            "Configuration version is newer than supported",
            source,
            [],
            {
                code: "migration",
                cause: "validation",
                secretPaths,
            },
        );
    }
    let current = value;
    let currentVersion = sourceVersion;
    const originalMissingVersion =
        isRecord(value) && value.version === undefined;
    while (currentVersion < version) {
        const migration = migrations?.find(
            ({ from }) => from === currentVersion,
        );
        if (migration === undefined) {
            throw new ConfigError(
                "No configuration migration is available",
                source,
                [],
                {
                    code: "migration",
                    cause: "validation",
                    secretPaths,
                },
            );
        }
        let migratedValue: unknown;
        try {
            migratedValue = await migration.migrate(current);
        } catch {
            throw new ConfigError(
                "Configuration migration failed",
                source,
                [],
                {
                    code: "migration",
                    cause: "migration",
                    secretPaths,
                },
            );
        }
        if (!isRecord(migratedValue)) {
            throw new ConfigError(
                "Configuration migration must return a mapping",
                source,
                [],
                { code: "migration", cause: "validation", secretPaths },
            );
        }
        current = migratedValue;
        currentVersion = migration.to;
        current = { ...current, version: currentVersion };
    }
    if (isRecord(current)) current = { ...current, version };
    return {
        value: current,
        changed: currentVersion !== sourceVersion || originalMissingVersion,
        from: sourceVersion,
        to: version,
    };
}

/** Loads defaults, YAML, environment values, and overrides in that order. */
export async function loadConfig<T>(options: LoadConfigOptions<T>): Promise<T> {
    const bindingPaths = (options.bindings ?? []).map((binding) => ({
        binding,
        path: dottedPathKeys(binding.path),
    }));
    const secretPaths = bindingPaths
        .filter(({ binding }) => binding.secret)
        .map(({ path }) => path);

    validateMigrations(options.version, options.migrations, secretPaths);

    if (options.file !== undefined && options.yaml !== undefined) {
        throw new ConfigError(
            "Specify either file or yaml, not both",
            "yaml",
            [],
            {
                code: "invalid-options",
                cause: "conflict",
                secretPaths,
            },
        );
    }

    let yamlConfig: unknown = {};
    const yamlSource: "file" | "yaml" =
        options.file === undefined ? "yaml" : "file";
    let fileSnapshot: ConfigFileSnapshot | undefined;
    let migrationInfo:
        | { changed: boolean; from: number; to: number }
        | undefined;
    if (options.file !== undefined) {
        try {
            const file = Bun.file(options.file);
            if (!(await file.exists())) {
                throw new ConfigError(
                    `Configuration file does not exist: ${options.file}`,
                    "file",
                    [],
                    { code: "file-not-found", cause: "missing", secretPaths },
                );
            }
            fileSnapshot = await readConfigFileSnapshot(options.file);
            yamlConfig = parseYamlSource(fileSnapshot.contents, "file");
        } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError(
                `Unable to read configuration file: ${options.file}`,
                "file",
                [],
                { code: "file-read", cause: "read", secretPaths },
            );
        }
    } else if (options.yaml !== undefined) {
        yamlConfig = parseYamlSource(options.yaml, "yaml");
    }

    const migrated = await migrateYaml(
        yamlConfig,
        options.version,
        options.migrations,
        secretPaths,
        yamlSource,
    );
    yamlConfig = migrated.value;
    migrationInfo = migrated;

    const environmentConfig: Record<string, unknown> = {};
    const environment = options.environment ?? process.env;
    for (const { binding, path } of bindingPaths) {
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
                [],
                {
                    code: "environment-parse",
                    cause: "parse",
                    path,
                    secretPaths,
                },
            );
        }
    }

    let candidate = merge(
        merge(merge(options.defaults ?? {}, yamlConfig), environmentConfig),
        options.override ?? {},
    );
    if (options.version !== undefined && isRecord(candidate)) {
        candidate = {
            ...candidate,
            version: migrationInfo?.to ?? options.version,
        };
    }
    const validation = await validateConfig(
        options.schema,
        candidate,
        options.defaults ?? {},
        options.onValidationError ?? "throw",
        options.onDiagnostic,
        secretPaths,
    );
    if (
        options.file !== undefined &&
        fileSnapshot !== undefined &&
        migrationInfo?.changed &&
        !validation.defaultsApplied
    ) {
        await writeMigratedConfigFile(
            fileSnapshot,
            stringifyYaml(yamlConfig),
            migrationInfo.from,
            migrationInfo.to,
            options.onDiagnostic,
        );
    }
    return validation.value;
}
