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
