import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface StaticRegistryValidationContext {
    readonly file: string;
    readonly exportName: string;
}

export type StaticRegistryValidator = (
    value: unknown,
    context: StaticRegistryValidationContext,
) => boolean | undefined | Promise<boolean | undefined>;

export interface StaticRegistryGeneratorConfig {
    readonly sourceDir: string;
    readonly outputPath: string;
    readonly exportName: string;
    readonly moduleExport?: "default" | string;
    readonly validate?: StaticRegistryValidator;
}

export interface StaticRegistryBuildResult {
    readonly content: string;
    readonly entryCount: number;
    readonly outputPath: string;
}

export interface StaticRegistryGenerateResult {
    readonly changed: boolean;
    readonly entryCount: number;
    readonly outputPath: string;
}

export interface StaticRegistryFragment {
    readonly imports: readonly string[];
    readonly identifiers: readonly string[];
    readonly entryCount: number;
}

export class StaticRegistryError extends Error {
    constructor(
        readonly code:
            | "empty-source"
            | "invalid-export-name"
            | "missing-export"
            | "invalid-entry"
            | "stale",
        message: string,
    ) {
        super(message);
        this.name = "StaticRegistryError";
    }
}

export function defineStaticRegistryConfig<
    const T extends StaticRegistryGeneratorConfig,
>(config: T): T {
    return config;
}

function assertIdentifier(value: string, label: string): void {
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

async function discoverFiles(
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

function moduleImportPath(outputPath: string, modulePath: string): string {
    let path = relative(dirname(outputPath), modulePath).split(sep).join("/");
    if (!path.startsWith(".")) path = `./${path}`;
    return path;
}

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
    const files = await discoverFiles(config.sourceDir, outputPath);
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
        const specifier = JSON.stringify(moduleImportPath(outputPath, file));
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

export async function buildStaticRegistryModule(
    config: StaticRegistryGeneratorConfig,
): Promise<StaticRegistryBuildResult> {
    const outputPath = resolve(config.outputPath);
    const fragment = await buildStaticRegistryFragment(config);
    const content = `// Generated by @kuma-00/bot-kit-registry. Do not edit.
${fragment.imports.join("\n")}

export const ${config.exportName} = [${fragment.identifiers.join(", ")}] as const;
`;
    return {
        content,
        entryCount: fragment.entryCount,
        outputPath,
    };
}

export async function generateStaticRegistry(
    config: StaticRegistryGeneratorConfig,
): Promise<StaticRegistryGenerateResult> {
    const generated = await buildStaticRegistryModule(config);
    const current = (await Bun.file(generated.outputPath).exists())
        ? await Bun.file(generated.outputPath).text()
        : undefined;
    const changed = current !== generated.content;
    if (changed) await Bun.write(generated.outputPath, generated.content);
    return {
        changed,
        entryCount: generated.entryCount,
        outputPath: generated.outputPath,
    };
}

export async function checkStaticRegistry(
    config: StaticRegistryGeneratorConfig,
): Promise<StaticRegistryGenerateResult> {
    const generated = await buildStaticRegistryModule(config);
    const current = (await Bun.file(generated.outputPath).exists())
        ? await Bun.file(generated.outputPath).text()
        : undefined;
    if (current !== generated.content) {
        throw new StaticRegistryError(
            "stale",
            `Generated static registry is stale: ${generated.outputPath}`,
        );
    }
    return {
        changed: false,
        entryCount: generated.entryCount,
        outputPath: generated.outputPath,
    };
}
