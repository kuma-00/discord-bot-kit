/**
 * Runtime schema interface implemented by Standard Schema compatible validators.
 * @see https://standardschema.dev/
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
        ) =>
            | StandardSchemaResult<Output>
            | Promise<StandardSchemaResult<Output>>;
        readonly types?: {
            readonly input: Input;
            readonly output: Output;
        };
    };
}

/** Result returned by a Standard Schema validator. */
export type StandardSchemaResult<T> =
    | { readonly value: T; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/** A validation issue independent of a concrete schema library. */
export interface StandardSchemaIssue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** Extracts the validated output type from a Standard Schema. */
export type SchemaOutput<TSchema> =
    TSchema extends StandardSchemaV1<infer _Input, infer Output>
        ? Output
        : never;

/** Error thrown when data does not match a runtime contract. */
export class ContractValidationError extends Error {
    constructor(
        readonly issues: ReadonlyArray<StandardSchemaIssue>,
        readonly boundary: string,
    ) {
        super(`Contract validation failed at ${boundary}`);
        this.name = "ContractValidationError";
    }
}

/** Validates unknown data and returns the schema output. */
export async function parseSchema<T>(
    schema: StandardSchemaV1<unknown, T>,
    value: unknown,
    boundary = "unknown",
): Promise<T> {
    const result = await schema["~standard"].validate(value);
    if ("issues" in result && result.issues !== undefined) {
        throw new ContractValidationError(result.issues, boundary);
    }
    return result.value;
}
