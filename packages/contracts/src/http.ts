import type { StandardSchemaV1 } from "./schema.ts";

/** A successful API result. */
export interface ApiSuccess<T> {
    readonly ok: true;
    readonly data: T;
}

/** Stable codes emitted when the framework rejects an HTTP request input. */
export type RequestInputFailureCode =
    | "invalid-input"
    | "invalid-multipart"
    | "payload-too-large";

/** A serializable API failure. */
export interface ApiFailure<TDetails = unknown> {
    readonly ok: false;
    readonly error:
        | {
              readonly code: string;
              readonly message: string;
              readonly kind?: never;
              readonly details?: TDetails;
          }
        | {
              readonly code: RequestInputFailureCode;
              readonly message: string;
              /** Discriminator reserved for framework-generated request failures. */
              readonly kind: "request-input";
              readonly details?: never;
          };
}

/** Framework-neutral API result. */
export type ApiResult<T, TDetails = unknown> =
    | ApiSuccess<T>
    | ApiFailure<TDetails>;

/** HTTP methods supported by a bot-kit route contract. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Serialization used for an HTTP contract request body. */
export type HttpBodyEncoding = "json" | "multipart/form-data";

/** Request-body metadata. Omission preserves the default JSON behavior. */
export interface HttpRequestBody {
    readonly encoding: HttpBodyEncoding;
    /** Maximum accepted multipart payload size in bytes. */
    readonly maxBytes?: number;
}

/** A scalar value accepted in a multipart form field. */
export type MultipartFormValue = string | Blob;

/** Structured multipart body accepted by the default HTTP serializer. */
export type MultipartFormBody = Readonly<
    Record<
        string,
        MultipartFormValue | ReadonlyArray<MultipartFormValue> | undefined
    >
>;

/** Runtime schemas and metadata for one HTTP operation. */
export interface HttpContract<
    TInput extends StandardSchemaV1 = StandardSchemaV1,
    TOutput extends StandardSchemaV1 = StandardSchemaV1,
    TError extends StandardSchemaV1 = StandardSchemaV1,
> {
    readonly id: string;
    readonly method: HttpMethod;
    readonly path: string;
    /** Request serialization. Defaults to `{ encoding: "json" }`. */
    readonly requestBody?: HttpRequestBody;
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
    const requestBody = contract.requestBody;
    if (requestBody?.maxBytes !== undefined) {
        if (requestBody.encoding !== "multipart/form-data") {
            throw new TypeError(
                "maxBytes is only valid for multipart/form-data",
            );
        }
        if (
            !Number.isSafeInteger(requestBody.maxBytes) ||
            requestBody.maxBytes < 0
        ) {
            throw new TypeError("maxBytes must be a non-negative safe integer");
        }
    }
    return contract;
}
