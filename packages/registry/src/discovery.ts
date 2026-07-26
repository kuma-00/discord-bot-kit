import { dirname, relative, resolve, sep } from "node:path";
import { StaticRegistryError } from "./errors.ts";

/** Validates a generated JavaScript identifier used in emitted source. */
export function assertIdentifier(value: string, label: string): void {
    if (!/^[A-Za-z_$][\w$]*$/.test(value)) {
        throw new StaticRegistryError(
            "invalid-export-name",
            `${label} must be a valid JavaScript identifier: ${value}`,
        );
    }
}

function isRuntimeModule(path: string): boolean {
    return (
        path.endsWith(".ts") &&
        !path.endsWith(".d.ts") &&
        !path.endsWith(".test.ts") &&
        !path.endsWith(".spec.ts")
    );
}

/**
 * Discovers sorted runtime TypeScript modules for generation.
 *
 * Tests, declarations, and the generated output itself are excluded.
 */
export async function discoverRegistryFiles(
    sourceDir: string,
    outputPath: string,
): Promise<string[]> {
    const absoluteSource = resolve(sourceDir);
    const absoluteOutput = resolve(outputPath);
    const files: string[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan(absoluteSource)) {
        const absolutePath = resolve(absoluteSource, path);
        if (absolutePath !== absoluteOutput && isRuntimeModule(path)) {
            files.push(absolutePath);
        }
    }
    files.sort();
    if (files.length === 0) {
        throw new StaticRegistryError(
            "empty-source",
            `No runtime TypeScript modules found in ${absoluteSource}`,
        );
    }
    return files;
}

/** Returns a portable relative import specifier from output to source module. */
export function registryModuleImportPath(
    outputPath: string,
    modulePath: string,
): string {
    let path = relative(dirname(outputPath), modulePath).split(sep).join("/");
    if (!path.startsWith(".")) path = `./${path}`;
    return path;
}
