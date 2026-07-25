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

/** A successful API result. */
export interface ApiSuccess<T> {
    readonly ok: true;
    readonly data: T;
}

/** A serializable API failure. */
export interface ApiFailure<TDetails = unknown> {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: TDetails;
    };
}

/** Framework-neutral API result. */
export type ApiResult<T, TDetails = unknown> =
    | ApiSuccess<T>
    | ApiFailure<TDetails>;

/** HTTP methods supported by a bot-kit route contract. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Runtime schemas and metadata for one HTTP operation. */
export interface HttpContract<
    TInput extends StandardSchemaV1 = StandardSchemaV1,
    TOutput extends StandardSchemaV1 = StandardSchemaV1,
    TError extends StandardSchemaV1 = StandardSchemaV1,
> {
    readonly id: string;
    readonly method: HttpMethod;
    readonly path: string;
    readonly input: TInput;
    readonly output: TOutput;
    readonly error: TError;
}

/** Creates an HTTP contract while preserving its inferred schema types. */
export function defineHttpContract<
    TInput extends StandardSchemaV1,
    TOutput extends StandardSchemaV1,
    TError extends StandardSchemaV1,
>(
    contract: HttpContract<TInput, TOutput, TError>,
): HttpContract<TInput, TOutput, TError> {
    return contract;
}

/** Versioned event metadata shared by SSE producers and consumers. */
export interface EventEnvelope<TType extends string, TPayload> {
    readonly id: string;
    readonly type: TType;
    readonly version: number;
    readonly occurredAt: string;
    readonly guildId?: string;
    readonly payload: TPayload;
}

/** Runtime definition of a versioned event. */
export interface EventContract<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
> {
    readonly type: TType;
    readonly version: TVersion;
    readonly payload: TPayloadSchema;
}

/** Creates an event contract while preserving literal type and version values. */
export function defineEventContract<
    const TType extends string,
    const TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
>(
    contract: EventContract<TType, TVersion, TPayloadSchema>,
): EventContract<TType, TVersion, TPayloadSchema> {
    return contract;
}

/** Validates a versioned event envelope and its payload. */
export async function parseEventEnvelope<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
>(
    contract: EventContract<TType, TVersion, TPayloadSchema>,
    value: unknown,
): Promise<EventEnvelope<TType, SchemaOutput<TPayloadSchema>>> {
    if (typeof value !== "object" || value === null) {
        throw new ContractValidationError(
            [{ message: "Expected an event envelope object" }],
            "event",
        );
    }
    const candidate = value as Record<string, unknown>;
    if (
        candidate.type !== contract.type ||
        candidate.version !== contract.version
    ) {
        throw new ContractValidationError(
            [{ message: "Unexpected event type or version" }],
            "event",
        );
    }
    for (const key of ["id", "occurredAt"] as const) {
        if (typeof candidate[key] !== "string") {
            throw new ContractValidationError(
                [{ message: `Expected ${key} to be a string`, path: [key] }],
                "event",
            );
        }
    }
    if (
        candidate.guildId !== undefined &&
        typeof candidate.guildId !== "string"
    ) {
        throw new ContractValidationError(
            [{ message: "Expected guildId to be a string", path: ["guildId"] }],
            "event",
        );
    }
    const payload = (await parseSchema(
        contract.payload,
        candidate.payload,
        `${contract.type}.payload`,
    )) as SchemaOutput<TPayloadSchema>;
    return {
        id: candidate.id as string,
        type: contract.type,
        version: contract.version,
        occurredAt: candidate.occurredAt as string,
        ...(candidate.guildId === undefined
            ? {}
            : { guildId: candidate.guildId as string }),
        payload,
    };
}
