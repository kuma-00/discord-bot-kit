/** File and export metadata supplied to a generation-time validator. */
export interface StaticRegistryValidationContext {
    readonly file: string;
    readonly exportName: string;
}

/** Async-compatible validator for one imported registry export. */
export type StaticRegistryValidator = (
    value: unknown,
    context: StaticRegistryValidationContext,
) => boolean | undefined | Promise<boolean | undefined>;

/** Discovery, export selection, validation, and output configuration. */
export interface StaticRegistryGeneratorConfig {
    readonly sourceDir: string;
    readonly outputPath: string;
    readonly exportName: string;
    readonly moduleExport?: "default" | string;
    readonly validate?: StaticRegistryValidator;
}

/** Deterministic source and entry metadata produced without a write. */
export interface StaticRegistryBuildResult {
    readonly content: string;
    readonly entryCount: number;
    readonly outputPath: string;
}

/** Write/staleness result returned by static registry operations. */
export interface StaticRegistryGenerateResult {
    readonly changed: boolean;
    readonly entryCount: number;
    readonly outputPath: string;
}

/** Import statements and identifiers embedded by higher-level generators. */
export interface StaticRegistryFragment {
    readonly imports: readonly string[];
    readonly identifiers: readonly string[];
    readonly entryCount: number;
}
