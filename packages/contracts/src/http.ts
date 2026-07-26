import type { StandardSchemaV1 } from "./schema.ts";

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
