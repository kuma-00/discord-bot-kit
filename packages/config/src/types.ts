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

/** Output type carried by a Standard Schema-compatible config schema. */
export type SchemaOutput<TSchema extends ConfigSchema<unknown>> =
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
