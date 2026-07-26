import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    assertIdentifier,
    discoverRegistryFiles,
    registryModuleImportPath,
} from "./discovery.ts";
import { StaticRegistryError } from "./errors.ts";
import type {
    StaticRegistryFragment,
    StaticRegistryGeneratorConfig,
} from "./types.ts";

export async function buildStaticRegistryFragment(
    config: StaticRegistryGeneratorConfig,
    identifierPrefix = "registryItem",
): Promise<StaticRegistryFragment> {
    assertIdentifier(config.exportName, "exportName");
    assertIdentifier(identifierPrefix, "identifierPrefix");
    const moduleExport = config.moduleExport ?? "default";
    if (moduleExport !== "default") {
        assertIdentifier(moduleExport, "moduleExport");
    }
    const outputPath = resolve(config.outputPath);
    const files = await discoverRegistryFiles(config.sourceDir, outputPath);
    const imports: string[] = [];
    const identifiers: string[] = [];

    for (const [index, file] of files.entries()) {
        const loaded = (await import(pathToFileURL(file).href)) as Record<
            string,
            unknown
        >;
        if (!(moduleExport in loaded)) {
            throw new StaticRegistryError(
                "missing-export",
                `${file} does not export "${moduleExport}"`,
            );
        }
        const value = loaded[moduleExport];
        const validation = await config.validate?.(value, {
            file,
            exportName: moduleExport,
        });
        if (validation === false) {
            throw new StaticRegistryError(
                "invalid-entry",
                `${file} export "${moduleExport}" failed registry validation`,
            );
        }
        const identifier = `${identifierPrefix}${index}`;
        const specifier = JSON.stringify(
            registryModuleImportPath(outputPath, file),
        );
        imports.push(
            moduleExport === "default"
                ? `import ${identifier} from ${specifier};`
                : `import { ${moduleExport} as ${identifier} } from ${specifier};`,
        );
        identifiers.push(identifier);
    }

    return {
        imports,
        identifiers,
        entryCount: files.length,
    };
}
