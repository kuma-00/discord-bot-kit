import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
    link,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    stat,
    unlink,
} from "node:fs/promises";
import { basename, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { emitDiagnostic } from "./diagnostics.ts";
import { ConfigError } from "./errors.ts";
import { dottedPathKeys, valueAtPath } from "./path.ts";
import type { ConfigDiagnosticHandler, EnvironmentBinding } from "./types.ts";

const lockStaleMilliseconds = 30_000;
const lockHeartbeatMilliseconds = 5_000;
const staleLeaseObservationMarginMilliseconds = 100;

/** Internal identity and contents captured from one opened configuration file. */
export interface ConfigFileSnapshot {
    readonly configuredPath: string;
    readonly targetPath: string;
    readonly contents: string;
    readonly device: number;
    readonly inode: number;
    readonly mode: number;
}

interface MigrationLease {
    readonly handle: FileHandle;
    readonly path: string;
    readonly heartbeat: ReturnType<typeof setInterval>;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code
    );
}

async function writeDurableFile(
    path: string,
    contents: string,
    mode: number,
): Promise<void> {
    const handle = await open(path, "wx", mode);
    let failure: unknown;
    try {
        await handle.writeFile(contents, "utf8");
        await handle.chmod(mode);
        await handle.sync();
    } catch (error) {
        failure = error;
    }
    let closeFailure: unknown;
    try {
        await handle.close();
    } catch (error) {
        closeFailure = error;
    }
    if (failure !== undefined || closeFailure !== undefined) {
        await unlink(path).catch(() => undefined);
        throw failure ?? closeFailure;
    }
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Captures the resolved file identity used to reject conflicting migrations. */
export async function readConfigFileSnapshot(
    configuredPath: string,
): Promise<ConfigFileSnapshot> {
    const targetPath = await realpath(configuredPath);
    const handle = await open(targetPath, "r");
    try {
        const [{ dev, ino, mode }, contents] = await Promise.all([
            handle.stat(),
            handle.readFile("utf8"),
        ]);
        return {
            configuredPath,
            targetPath,
            contents,
            device: dev,
            inode: ino,
            mode: mode & 0o7777,
        };
    } finally {
        await handle.close();
    }
}

async function acquireMigrationLease(path: string): Promise<MigrationLease> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        let handle: FileHandle;
        try {
            handle = await open(path, "wx", 0o600);
        } catch (error) {
            if (!hasErrorCode(error, "EEXIST")) throw error;

            const lockStats = await stat(path).catch((statError: unknown) => {
                if (hasErrorCode(statError, "ENOENT")) return undefined;
                throw statError;
            });
            if (lockStats === undefined) continue;
            if (Date.now() - lockStats.mtimeMs <= lockStaleMilliseconds) {
                throw new ConfigError(
                    "Configuration migration is already in progress",
                    "file",
                    [],
                    { code: "migration-write", cause: "conflict" },
                );
            }

            // Keep the canonical path occupied while allowing an owner one
            // heartbeat interval to prove that the initial stale mtime is
            // obsolete. This avoids breaking an active owner's lease.
            await new Promise<void>((resolve) => {
                setTimeout(
                    resolve,
                    lockHeartbeatMilliseconds +
                        staleLeaseObservationMarginMilliseconds,
                );
            });
            const observed = await stat(path).catch(() => undefined);
            if (
                observed === undefined ||
                observed.dev !== lockStats.dev ||
                observed.ino !== lockStats.ino ||
                observed.mtimeMs !== lockStats.mtimeMs ||
                Date.now() - observed.mtimeMs <= lockStaleMilliseconds
            ) {
                throw new ConfigError(
                    "Configuration migration is already in progress",
                    "file",
                    [],
                    { code: "migration-write", cause: "conflict" },
                );
            }

            const stalePath = `${path}.stale.${randomUUID()}`;
            try {
                await rename(path, stalePath);
            } catch (renameError) {
                if (hasErrorCode(renameError, "ENOENT")) continue;
                throw renameError;
            }
            const quarantined = await stat(stalePath).catch(() => undefined);
            if (
                quarantined === undefined ||
                quarantined.dev !== lockStats.dev ||
                quarantined.ino !== lockStats.ino
            ) {
                try {
                    await link(stalePath, path);
                    await unlink(stalePath);
                } catch {
                    // Do not overwrite a lock created by another owner, and
                    // retain the quarantine when exclusive restoration fails.
                }
                throw new ConfigError(
                    "Configuration migration is already in progress",
                    "file",
                    [],
                    { code: "migration-write", cause: "conflict" },
                );
            }
            await unlink(stalePath).catch(() => undefined);
            continue;
        }

        const owner = randomUUID();
        try {
            await handle.writeFile(
                JSON.stringify({
                    owner,
                    pid: process.pid,
                    createdAt: Date.now(),
                }),
                "utf8",
            );
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(path).catch(() => undefined);
            throw error;
        }
        const heartbeat = setInterval(() => {
            const now = new Date();
            void handle.utimes(now, now).catch(() => undefined);
        }, lockHeartbeatMilliseconds);
        heartbeat.unref?.();
        return { handle, path, heartbeat };
    }

    throw new ConfigError(
        "Configuration migration lock could not be acquired",
        "file",
        [],
        { code: "migration-write", cause: "conflict" },
    );
}

async function releaseMigrationLease(lease: MigrationLease): Promise<void> {
    clearInterval(lease.heartbeat);
    try {
        const [owned, current] = await Promise.all([
            lease.handle.stat(),
            stat(lease.path).catch(() => undefined),
        ]);
        if (
            current !== undefined &&
            owned.dev === current.dev &&
            owned.ino === current.ino
        ) {
            await unlink(lease.path).catch(() => undefined);
        }
    } catch {
        // Cleanup must not replace the migration result with a release error.
    } finally {
        await lease.handle.close().catch(() => undefined);
    }
}

async function assertMigrationLeaseOwned(lease: MigrationLease): Promise<void> {
    const [owned, current] = await Promise.all([
        lease.handle.stat(),
        stat(lease.path).catch(() => undefined),
    ]);
    if (
        current === undefined ||
        owned.dev !== current.dev ||
        owned.ino !== current.ino
    ) {
        throw new ConfigError(
            "Configuration migration lease was lost",
            "file",
            [],
            { code: "migration-write", cause: "conflict" },
        );
    }
}

async function assertSnapshotCurrent(
    snapshot: ConfigFileSnapshot,
): Promise<void> {
    const [resolved, current, contents] = await Promise.all([
        realpath(snapshot.configuredPath),
        stat(snapshot.targetPath),
        readFile(snapshot.targetPath, "utf8"),
    ]);
    if (
        resolved !== snapshot.targetPath ||
        current.dev !== snapshot.device ||
        current.ino !== snapshot.inode ||
        contents !== snapshot.contents
    ) {
        throw new ConfigError(
            "Configuration file changed during migration",
            "file",
            [],
            { code: "migration-write", cause: "conflict" },
        );
    }
}

/** Atomically replaces a migrated file after preserving its original contents. */
export async function writeMigratedConfigFile(
    snapshot: ConfigFileSnapshot,
    contents: string,
    oldVersion: number,
    newVersion: number,
    onDiagnostic?: ConfigDiagnosticHandler,
    testing?: {
        readonly beforeFinalLeaseCheck?: (lockPath: string) => Promise<void>;
        readonly beforeBackupDirectorySync?: () => Promise<void>;
        readonly afterRenameBeforeFinalDirectorySync?: () => Promise<void>;
    },
): Promise<void> {
    const lockPath = `${snapshot.targetPath}.migration.lock`;
    let lease: MigrationLease | undefined;
    let temporaryPath: string | undefined;
    let backupPath: string | undefined;
    let discardBackup = false;
    let replaced = false;
    let migrated = false;
    try {
        try {
            lease = await acquireMigrationLease(lockPath);
        } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError(
                "Unable to lock configuration file for migration",
                "file",
                [],
                { code: "migration-write", cause: "write" },
            );
        }

        try {
            await assertMigrationLeaseOwned(lease);
            await assertSnapshotCurrent(snapshot);
        } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError(
                "Unable to read configuration file",
                "file",
                [],
                { code: "migration-write", cause: "read" },
            );
        }
        const backupBase = `${snapshot.targetPath}.v${oldVersion}.bak`;
        let backup = backupBase;
        for (let attempt = 0; attempt < 16; attempt += 1) {
            try {
                await writeDurableFile(
                    backup,
                    snapshot.contents,
                    snapshot.mode,
                );
                backupPath = backup;
                break;
            } catch (error) {
                if (
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    error.code !== "EEXIST"
                ) {
                    throw new ConfigError(
                        "Unable to preserve configuration backup",
                        "file",
                        [],
                        {
                            code: "migration-write",
                            cause: "write",
                        },
                    );
                }
                backup = `${backupBase}.${randomUUID()}`;
                if (attempt === 15) {
                    throw new ConfigError(
                        "Unable to preserve configuration backup",
                        "file",
                        [],
                        {
                            code: "migration-write",
                            cause: "write",
                        },
                    );
                }
            }
        }
        try {
            await testing?.beforeBackupDirectorySync?.();
            await syncDirectory(dirname(snapshot.targetPath));
        } catch {
            throw new ConfigError(
                "Unable to preserve configuration backup",
                "file",
                [],
                { code: "migration-write", cause: "write" },
            );
        }

        temporaryPath = `${dirname(snapshot.targetPath)}/.${basename(snapshot.targetPath)}.${randomUUID()}.tmp`;
        try {
            await writeDurableFile(temporaryPath, contents, snapshot.mode);
            await assertSnapshotCurrent(snapshot);
            await testing?.beforeFinalLeaseCheck?.(lockPath);
            await assertMigrationLeaseOwned(lease);
            await rename(temporaryPath, snapshot.targetPath);
            replaced = true;
            await testing?.afterRenameBeforeFinalDirectorySync?.();
            await syncDirectory(dirname(snapshot.targetPath));
            migrated = true;
        } catch (error) {
            if (error instanceof ConfigError) {
                if (error.metadata.cause === "conflict") discardBackup = true;
                throw error;
            }
            throw new ConfigError(
                "Unable to write migrated configuration file",
                "file",
                [],
                {
                    code: "migration-write",
                    cause: "write",
                },
            );
        }
    } finally {
        if (temporaryPath !== undefined) {
            await unlink(temporaryPath).catch(() => undefined);
        }
        if ((discardBackup || !replaced) && backupPath !== undefined) {
            await unlink(backupPath).catch(() => undefined);
        }
        if (lease !== undefined) await releaseMigrationLease(lease);
    }

    if (migrated) {
        await emitDiagnostic(onDiagnostic, {
            type: "file-migrated",
            from: oldVersion,
            to: newVersion,
            path: snapshot.configuredPath,
        });
    }
}

export function parseYamlSource(
    source: string,
    origin: "file" | "yaml",
): unknown {
    try {
        return parseYaml(source) ?? {};
    } catch {
        throw new ConfigError(
            `Unable to parse ${origin} configuration`,
            origin,
            [],
            { code: "yaml-parse", cause: "parse" },
        );
    }
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
                [],
                { code: "secret-template", cause: "write", path: keys },
            );
        }
    }
}

export async function createConfigFile(
    path: string,
    template: string | unknown,
    bindings: ReadonlyArray<EnvironmentBinding>,
    onDiagnostic?: ConfigDiagnosticHandler,
    version?: number,
): Promise<void> {
    let parsedTemplate =
        typeof template === "string"
            ? parseYamlSource(template, "yaml")
            : template;
    if (
        version !== undefined &&
        (parsedTemplate === null ||
            typeof parsedTemplate !== "object" ||
            Array.isArray(parsedTemplate))
    ) {
        throw new ConfigError(
            "Versioned configuration templates must be mappings",
            "file",
            [],
            { code: "migration-options", cause: "validation" },
        );
    }
    if (
        version !== undefined &&
        parsedTemplate &&
        typeof parsedTemplate === "object" &&
        !Array.isArray(parsedTemplate)
    ) {
        parsedTemplate = {
            ...(parsedTemplate as Record<string, unknown>),
            version,
        };
    }
    assertTemplateHasNoSecrets(parsedTemplate, bindings);
    const contents =
        version === undefined && typeof template === "string"
            ? template
            : stringifyYaml(parsedTemplate ?? {});

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
            [],
            { code: "file-create", cause: "write" },
        );
    } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
    }
}
