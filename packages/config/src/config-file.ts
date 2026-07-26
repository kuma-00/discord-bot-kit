import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { emitDiagnostic } from "./diagnostics.ts";
import { ConfigError } from "./errors.ts";
import { dottedPathKeys, valueAtPath } from "./path.ts";
import type { ConfigDiagnosticHandler, EnvironmentBinding } from "./types.ts";

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
            );
        }
    }
}

export async function createConfigFile(
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
