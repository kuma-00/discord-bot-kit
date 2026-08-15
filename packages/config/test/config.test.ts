import { describe, expect, test } from "bun:test";
import {
    chmod,
    lstat,
    mkdtemp,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    readConfigFileSnapshot,
    writeMigratedConfigFile,
} from "../src/config-file.ts";
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

    test("applies sequential migrations to YAML before merging sources", async () => {
        const diagnostics: unknown[] = [];
        const result = await loadConfig({
            schema: configSchema,
            version: 3,
            migrations: [
                {
                    from: 1,
                    to: 2,
                    migrate: (value) => ({ ...(value as object), port: 2 }),
                },
                {
                    from: 2,
                    to: 3,
                    migrate: async (value) => ({
                        ...(value as object),
                        nested: { value: "migrated" },
                    }),
                },
            ],
            defaults: { token: "default" },
            yaml: "port: 1\nnested: {}\n",
            environment: { TOKEN: "secret" },
            bindings: [{ env: "TOKEN", path: "token" }],
            onDiagnostic: (diagnostic) => {
                diagnostics.push(diagnostic);
            },
        });
        expect(result).toMatchObject({
            port: 2,
            nested: { value: "migrated" },
            token: "secret",
            version: 3,
        });
        expect(diagnostics).toHaveLength(0);
    });

    test("backs up and atomically rewrites migrated files after validation", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-migration-"),
        );
        const file = join(directory, "config.yaml");
        const diagnostics: unknown[] = [];
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Bun.write(file, original);
            await loadConfig({
                schema: configSchema,
                version: 2,
                migrations: [
                    {
                        from: 1,
                        to: 2,
                        migrate: (value) => ({ ...(value as object), port: 9 }),
                    },
                ],
                file,
                onDiagnostic: (diagnostic) => {
                    diagnostics.push(diagnostic);
                },
            });
            expect(await readFile(`${file}.v1.bak`, "utf8")).toBe(original);
            expect(await readFile(file, "utf8")).toContain("version: 2");
            expect(diagnostics).toContainEqual(
                expect.objectContaining({
                    type: "file-migrated",
                    from: 1,
                    to: 2,
                }),
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("does not rewrite migrated files when validation repairs defaults", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-migration-defaults-"),
        );
        const file = join(directory, "config.yaml");
        const original =
            "port: invalid\nnested:\n  value: configured\ntoken: configured\n";
        const diagnostics: unknown[] = [];
        try {
            await Bun.write(file, original);
            const result = await loadConfig({
                schema: configSchema,
                defaults: {
                    port: 3000,
                    nested: { value: "default" },
                    token: "default-token",
                },
                version: 2,
                migrations: [{ from: 1, to: 2, migrate: (value) => value }],
                file,
                onValidationError: "use-defaults",
                onDiagnostic: (diagnostic) => {
                    diagnostics.push(diagnostic);
                },
            });

            expect(result).toMatchObject({
                port: 3000,
                nested: { value: "configured" },
                token: "configured",
                version: 2,
            });
            expect(await readFile(file, "utf8")).toBe(original);
            expect(await Bun.file(`${file}.v1.bak`).exists()).toBe(false);
            expect(diagnostics).toContainEqual({
                type: "default-used",
                path: ["port"],
            });
            expect(diagnostics).not.toContainEqual(
                expect.objectContaining({ type: "file-migrated" }),
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("cleans up the backup when the pre-replace directory sync fails", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-sync-"));
        const file = join(directory, "config.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Bun.write(file, original);
            const snapshot = await readConfigFileSnapshot(file);
            await expect(
                writeMigratedConfigFile(
                    snapshot,
                    `${original}version: 2\n`,
                    1,
                    2,
                    undefined,
                    {
                        beforeBackupDirectorySync: async () => {
                            throw new Error("sync");
                        },
                    },
                ),
            ).rejects.toMatchObject({
                metadata: { code: "migration-write", cause: "write" },
            });
            expect(await readFile(file, "utf8")).toBe(original);
            expect(
                (await readdir(directory)).filter(
                    (name) =>
                        name.includes(".v1.bak") ||
                        name.endsWith(".tmp") ||
                        name.endsWith(".lock"),
                ),
            ).toHaveLength(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("retains the backup when the post-replace directory sync fails", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-sync-"));
        const file = join(directory, "config.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Bun.write(file, original);
            const snapshot = await readConfigFileSnapshot(file);
            await expect(
                writeMigratedConfigFile(
                    snapshot,
                    `${original}version: 2\n`,
                    1,
                    2,
                    undefined,
                    {
                        afterRenameBeforeFinalDirectorySync: async () => {
                            throw new Error("sync");
                        },
                    },
                ),
            ).rejects.toMatchObject({
                metadata: { code: "migration-write", cause: "write" },
            });
            expect(await readFile(file, "utf8")).toContain("version: 2");
            expect(await readFile(`${file}.v1.bak`, "utf8")).toBe(original);
            expect(await Bun.file(`${file}.migration.lock`).exists()).toBe(
                false,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("preserves restrictive permissions on migrated files and backups", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-permissions-"),
        );
        const file = join(directory, "config.yaml");
        try {
            await Bun.write(
                file,
                "port: 1\nnested:\n  value: old\ntoken: configured\n",
            );
            await chmod(file, 0o600);

            await loadConfig({
                schema: configSchema,
                version: 2,
                migrations: [
                    {
                        from: 1,
                        to: 2,
                        migrate: (value) => value,
                    },
                ],
                file,
            });

            expect((await stat(file)).mode & 0o777).toBe(0o600);
            expect((await stat(`${file}.v1.bak`)).mode & 0o777).toBe(0o600);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("migrates a symlink target without replacing the symlink", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-link-"));
        const target = join(directory, "target.yaml");
        const file = join(directory, "config.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Bun.write(target, original);
            await chmod(target, 0o600);
            await symlink(target, file);

            await loadConfig({
                schema: configSchema,
                version: 2,
                migrations: [{ from: 1, to: 2, migrate: (value) => value }],
                file,
            });

            expect((await lstat(file)).isSymbolicLink()).toBe(true);
            expect(await readFile(target, "utf8")).toContain("version: 2");
            expect(await readFile(`${target}.v1.bak`, "utf8")).toBe(original);
            expect((await stat(target)).mode & 0o777).toBe(0o600);
            expect((await stat(`${target}.v1.bak`)).mode & 0o777).toBe(0o600);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("allows only one concurrent migration to replace a file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-config-lock-"));
        const target = join(directory, "target.yaml");
        const firstAlias = join(directory, "first.yaml");
        const secondAlias = join(directory, "second.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        let arrivals = 0;
        let releaseMigrations: (() => void) | undefined;
        const migrationsReady = new Promise<void>((resolve) => {
            releaseMigrations = resolve;
        });
        const migrate = async (value: unknown): Promise<unknown> => {
            arrivals += 1;
            if (arrivals === 2) releaseMigrations?.();
            await migrationsReady;
            return value;
        };
        try {
            await Bun.write(target, original);
            await Promise.all([
                symlink(target, firstAlias),
                symlink(target, secondAlias),
            ]);
            const results = await Promise.allSettled([
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    migrations: [{ from: 1, to: 2, migrate }],
                    file: firstAlias,
                }),
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    migrations: [{ from: 1, to: 2, migrate }],
                    file: secondAlias,
                }),
            ]);

            expect(
                results.filter(({ status }) => status === "fulfilled"),
            ).toHaveLength(1);
            const rejected = results.find(
                ({ status }) => status === "rejected",
            );
            expect(rejected).toMatchObject({
                status: "rejected",
                reason: {
                    metadata: { code: "migration-write", cause: "conflict" },
                },
            });
            expect(await readFile(target, "utf8")).toContain("version: 2");
            expect(await Bun.file(`${target}.migration.lock`).exists()).toBe(
                false,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("recovers a stale migration lease", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-stale-"),
        );
        const file = join(directory, "config.yaml");
        const lock = `${file}.migration.lock`;
        try {
            await Bun.write(
                file,
                "port: 1\nnested:\n  value: old\ntoken: configured\n",
            );
            await writeFile(lock, "stale", { mode: 0o600 });
            const staleTime = new Date(Date.now() - 60_000);
            await utimes(lock, staleTime, staleTime);

            await loadConfig({
                schema: configSchema,
                version: 2,
                migrations: [{ from: 1, to: 2, migrate: (value) => value }],
                file,
            });

            expect(await readFile(file, "utf8")).toContain("version: 2");
            expect(await Bun.file(lock).exists()).toBe(false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }, 10_000);

    test("does not reclaim a stale-looking lease during stale observation", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-stale-heartbeat-"),
        );
        const file = join(directory, "config.yaml");
        const lock = `${file}.migration.lock`;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
            const original =
                "port: 1\nnested:\n  value: old\ntoken: configured\n";
            await Bun.write(file, original);
            await writeFile(lock, "active", { mode: 0o600 });
            const staleTime = new Date(Date.now() - 60_000);
            await utimes(lock, staleTime, staleTime);
            handle = await open(lock, "r+");
            setTimeout(() => {
                const now = new Date();
                void handle?.utimes(now, now);
            }, 1_000).unref?.();

            await expect(
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    migrations: [{ from: 1, to: 2, migrate: (value) => value }],
                    file,
                }),
            ).rejects.toMatchObject({
                metadata: { code: "migration-write", cause: "conflict" },
            });
            expect(await readFile(file, "utf8")).toBe(original);
            expect(await Bun.file(lock).exists()).toBe(true);
            const ownerStats = await handle.stat();
            const currentStats = await stat(lock);
            expect(currentStats.dev).toBe(ownerStats.dev);
            expect(currentStats.ino).toBe(ownerStats.ino);
        } finally {
            await handle?.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 10_000);

    test("stops when the migration lease is replaced before rename", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-lost-lease-"),
        );
        const file = join(directory, "config.yaml");
        const lock = `${file}.migration.lock`;
        const stolen = `${lock}.stolen`;
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Bun.write(file, original);
            const snapshot = await readConfigFileSnapshot(file);

            await expect(
                writeMigratedConfigFile(
                    snapshot,
                    `${original}version: 2\n`,
                    1,
                    2,
                    undefined,
                    {
                        beforeFinalLeaseCheck: async (lockPath) => {
                            await rename(lockPath, stolen);
                            await rm(stolen);
                            await writeFile(lockPath, "new owner", {
                                flag: "wx",
                                mode: 0o600,
                            });
                        },
                    },
                ),
            ).rejects.toMatchObject({
                metadata: { code: "migration-write", cause: "conflict" },
            });

            expect(await readFile(file, "utf8")).toBe(original);
            expect(await Bun.file(`${file}.v1.bak`).exists()).toBe(false);
            expect(await readFile(lock, "utf8")).toBe("new owner");
            expect(
                (await readdir(directory)).filter((name) =>
                    name.endsWith(".tmp"),
                ),
            ).toHaveLength(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects a symlink target changed during migration", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-retarget-"),
        );
        const firstTarget = join(directory, "first-target.yaml");
        const secondTarget = join(directory, "second-target.yaml");
        const file = join(directory, "config.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Promise.all([
                Bun.write(firstTarget, original),
                Bun.write(secondTarget, original),
            ]);
            await symlink(firstTarget, file);

            await expect(
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    migrations: [
                        {
                            from: 1,
                            to: 2,
                            migrate: async (value) => {
                                await rm(file);
                                await symlink(secondTarget, file);
                                return value;
                            },
                        },
                    ],
                    file,
                }),
            ).rejects.toMatchObject({
                metadata: { code: "migration-write", cause: "conflict" },
            });
            expect(await readFile(firstTarget, "utf8")).toBe(original);
            expect(await readFile(secondTarget, "utf8")).toBe(original);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects a target inode replaced during migration", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-inode-"),
        );
        const file = join(directory, "config.yaml");
        const replacement = join(directory, "replacement.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        try {
            await Bun.write(file, original);
            await expect(
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    migrations: [
                        {
                            from: 1,
                            to: 2,
                            migrate: async (value) => {
                                await Bun.write(replacement, original);
                                await rename(replacement, file);
                                return value;
                            },
                        },
                    ],
                    file,
                }),
            ).rejects.toMatchObject({
                metadata: { code: "migration-write", cause: "conflict" },
            });
            expect(await readFile(file, "utf8")).toBe(original);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("does not report a diagnostic failure as a migration write failure", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-diagnostic-"),
        );
        const file = join(directory, "config.yaml");
        const diagnosticFailure = new Error("diagnostic failed");
        try {
            await Bun.write(
                file,
                "port: 1\nnested:\n  value: old\ntoken: configured\n",
            );
            await expect(
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    migrations: [{ from: 1, to: 2, migrate: (value) => value }],
                    file,
                    onDiagnostic: () => {
                        throw diagnosticFailure;
                    },
                }),
            ).rejects.toBe(diagnosticFailure);
            expect(await readFile(file, "utf8")).toContain("version: 2");
            expect(await Bun.file(`${file}.migration.lock`).exists()).toBe(
                false,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects future YAML versions and non-mapping migration results", async () => {
        await expect(
            loadConfig({
                schema: configSchema,
                version: 2,
                yaml: "version: 3\n",
                migrations: [{ from: 1, to: 2, migrate: (value) => value }],
            }),
        ).rejects.toMatchObject({
            metadata: { code: "migration", cause: "validation" },
        });
        await expect(
            loadConfig({
                schema: configSchema,
                version: 2,
                yaml: "port: 1\nnested: {}\n",
                migrations: [{ from: 1, to: 2, migrate: () => [] }],
            }),
        ).rejects.toMatchObject({
            metadata: { code: "migration", cause: "validation" },
        });
        await expect(
            loadConfig({
                schema: configSchema,
                version: 2,
                yaml: "port: 1\nnested: {}\n",
                migrations: [
                    {
                        from: 1,
                        to: 2,
                        migrate: () => {
                            throw new Error("secret");
                        },
                    },
                ],
            }),
        ).rejects.toMatchObject({
            metadata: { code: "migration", cause: "migration" },
        });
    });

    test("attributes migration errors to their YAML source", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-migration-source-"),
        );
        const file = join(directory, "config.yaml");
        const migrations = [
            {
                from: 1,
                to: 2,
                migrate: () => {
                    throw new Error("migration failed");
                },
            },
        ];
        try {
            await Bun.write(file, "port: 1\nnested: {}\n");
            await expect(
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    file,
                    migrations,
                }),
            ).rejects.toMatchObject({ source: "file" });
            await expect(
                loadConfig({
                    schema: configSchema,
                    version: 2,
                    yaml: "port: 1\nnested: {}\n",
                    migrations,
                }),
            ).rejects.toMatchObject({ source: "yaml" });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("leaves a migrated file and backup untouched when final validation fails", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "bot-kit-config-migration-fail-"),
        );
        const file = join(directory, "config.yaml");
        const original = "port: 1\nnested:\n  value: old\ntoken: configured\n";
        const failingSchema: ConfigSchema<TestConfig> = {
            "~standard": {
                version: 1,
                vendor: "test",
                validate: () => ({ issues: [{ message: "invalid" }] }),
            },
        };
        try {
            await Bun.write(file, original);
            await expect(
                loadConfig({
                    schema: failingSchema,
                    version: 2,
                    migrations: [
                        {
                            from: 1,
                            to: 2,
                            migrate: (value) => ({
                                ...(value as object),
                                port: 9,
                            }),
                        },
                    ],
                    file,
                }),
            ).rejects.toBeInstanceOf(ConfigError);
            expect(await readFile(file, "utf8")).toBe(original);
            expect(await Bun.file(`${file}.v1.bak`).exists()).toBe(false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects gaps in migration definitions", async () => {
        await expect(
            loadConfig({
                schema: configSchema,
                version: 3,
                migrations: [{ from: 2, to: 3, migrate: (value) => value }],
            }),
        ).rejects.toMatchObject({
            metadata: { code: "migration-options" },
        });
    });
});
