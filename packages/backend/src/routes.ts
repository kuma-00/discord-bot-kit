import {
    type ApiFailure,
    type ApiResult,
    type HttpContract,
    parseSchema,
    type RequestInputFailureCode,
    type SchemaOutput,
    type StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";

class RequestInputError extends Error {
    constructor(
        readonly code: RequestInputFailureCode,
        readonly status: 400 | 413,
    ) {
        super(code);
        this.name = "RequestInputError";
    }
}

class RequestConfigurationError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "RequestConfigurationError";
    }
}

/** Logger surface used by framework-neutral backend helpers. */
export interface BackendLogger {
    readonly info?: (
        message: string,
        context?: Readonly<Record<string, unknown>>,
    ) => void;
    readonly error?: (
        message: string,
        context?: Readonly<Record<string, unknown>>,
    ) => void;
}

/** Context passed to a framework-neutral route handler. */
export interface RouteContext<TInput> {
    readonly request: Request;
    readonly input: TInput;
    readonly params: Readonly<Record<string, string>>;
}

/** A route result with an optional HTTP status override. */
export type RouteResult<TOutput, TError> =
    | {
          readonly ok: true;
          readonly data: TOutput;
          readonly status?: number;
      }
    | {
          readonly ok: false;
          readonly error: {
              readonly code: string;
              readonly message: string;
              readonly details: TError;
          };
          readonly status?: number;
      };

/** Route handler result or value accepted by the backend executor. */
export type RouteHandler<TInput, TOutput, TError> = (
    context: RouteContext<TInput>,
) => RouteResult<TOutput, TError> | Promise<RouteResult<TOutput, TError>>;

/** A contract paired with its framework-neutral handler. */
export interface RouteDefinition<
    TInputSchema extends StandardSchemaV1,
    TOutputSchema extends StandardSchemaV1,
    TErrorSchema extends StandardSchemaV1,
> {
    readonly contract: HttpContract<TInputSchema, TOutputSchema, TErrorSchema>;
    readonly handler: RouteHandler<
        SchemaOutput<TInputSchema>,
        SchemaOutput<TOutputSchema>,
        SchemaOutput<TErrorSchema>
    >;
}

/** Pairs a route contract with a type-safe handler. */
export function defineRoute<
    TInputSchema extends StandardSchemaV1,
    TOutputSchema extends StandardSchemaV1,
    TErrorSchema extends StandardSchemaV1,
>(
    definition: RouteDefinition<TInputSchema, TOutputSchema, TErrorSchema>,
): RouteDefinition<TInputSchema, TOutputSchema, TErrorSchema> {
    return definition;
}

/** Serializes an API result as a JSON response. */
export function jsonResult<T, TError>(
    result: ApiResult<T, TError>,
    status = result.ok ? 200 : 400,
): Response {
    return Response.json(result, { status });
}

/** Maps an unexpected error to a safe public failure response. */
export function mapBackendError(
    error: unknown,
    logger?: BackendLogger,
): Response {
    if (error instanceof RequestInputError) {
        return jsonResult(
            {
                ok: false,
                error: {
                    code: error.code,
                    message:
                        error.code === "payload-too-large"
                            ? "Request payload is too large"
                            : "Request input is invalid",
                    kind: "request-input",
                },
            },
            error.status,
        );
    }
    logger?.error?.("Unhandled backend error", { error });
    const failure: ApiFailure = {
        ok: false,
        error: {
            code: "internal-error",
            message: "Internal server error",
        },
    };
    return jsonResult(failure, 500);
}

function multipartBody(form: FormData): Readonly<Record<string, unknown>> {
    const body: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
    for (const [name, value] of form) {
        const current = body[name];
        if (current === undefined) body[name] = value;
        else if (Array.isArray(current)) current.push(value);
        else body[name] = [current, value];
    }
    return body;
}

async function readRouteInput(
    definition: RouteDefinition<
        StandardSchemaV1,
        StandardSchemaV1,
        StandardSchemaV1
    >,
    request: Request,
    rawInput: unknown,
): Promise<unknown> {
    const requestBody = definition.contract.requestBody;
    if (
        requestBody?.maxBytes !== undefined &&
        (requestBody.encoding !== "multipart/form-data" ||
            !Number.isSafeInteger(requestBody.maxBytes) ||
            requestBody.maxBytes < 0)
    ) {
        throw new RequestConfigurationError(
            "Invalid request body maxBytes configuration",
        );
    }
    if (requestBody?.encoding !== "multipart/form-data") {
        return rawInput;
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new RequestInputError("invalid-multipart", 400);
    }
    const maxBytes = requestBody.maxBytes;
    const contentLength = Number(request.headers.get("content-length"));
    if (maxBytes !== undefined && contentLength > maxBytes) {
        throw new RequestInputError("payload-too-large", 413);
    }
    try {
        let multipartRequest = request;
        if (maxBytes !== undefined && request.body) {
            const reader = request.body.getReader();
            let rejectAbort: ((reason: unknown) => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
                rejectAbort = reject;
            });
            const cancelReader = () => {
                try {
                    void reader.cancel().catch(() => {
                        // Preserve the request error if cancellation fails.
                    });
                } catch {
                    // Preserve the request error if cancellation fails.
                }
            };
            const onAbort = () => {
                rejectAbort?.(request.signal.reason);
                cancelReader();
            };
            request.signal.addEventListener("abort", onAbort, { once: true });
            try {
                if (request.signal.aborted) onAbort();
                const readPromise = (async () => {
                    const chunks: Uint8Array[] = [];
                    let total = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        total += value.byteLength;
                        if (total > maxBytes) {
                            cancelReader();
                            throw new RequestInputError(
                                "payload-too-large",
                                413,
                            );
                        }
                        chunks.push(value);
                    }
                    const body = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of chunks) {
                        body.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    return body;
                })();
                const body = await Promise.race([readPromise, abortPromise]);
                multipartRequest = new Request(request, { body });
            } finally {
                request.signal.removeEventListener("abort", onAbort);
                reader.releaseLock();
            }
        }
        const form = await multipartRequest.formData();
        if (request.signal.aborted) throw request.signal.reason;
        const body = multipartBody(form);
        const base =
            typeof rawInput === "object" && rawInput !== null ? rawInput : {};
        return { ...base, body };
    } catch (error) {
        if (error instanceof RequestInputError) throw error;
        if (request.signal.aborted) throw error;
        throw new RequestInputError("invalid-multipart", 400);
    }
}

/** Executes and validates a framework-neutral route definition. */
export async function executeRoute<
    TInputSchema extends StandardSchemaV1,
    TOutputSchema extends StandardSchemaV1,
    TErrorSchema extends StandardSchemaV1,
>(
    definition: RouteDefinition<TInputSchema, TOutputSchema, TErrorSchema>,
    request: Request,
    rawInput?: unknown,
    params: Readonly<Record<string, string>> = {},
    logger?: BackendLogger,
): Promise<Response> {
    try {
        let input: SchemaOutput<TInputSchema>;
        try {
            input = (await parseSchema(
                definition.contract.input,
                await readRouteInput(definition, request, rawInput),
                `${definition.contract.id}.input`,
            )) as SchemaOutput<TInputSchema>;
        } catch (error) {
            if (
                error instanceof RequestInputError ||
                error instanceof RequestConfigurationError
            )
                throw error;
            throw new RequestInputError("invalid-input", 400);
        }
        const result = await definition.handler({ request, input, params });
        if (result.ok) {
            const data = await parseSchema(
                definition.contract.output,
                result.data,
                `${definition.contract.id}.output`,
            );
            return jsonResult({ ok: true, data }, result.status ?? 200);
        }
        const details = await parseSchema(
            definition.contract.error,
            result.error.details,
            `${definition.contract.id}.error`,
        );
        return jsonResult(
            {
                ok: false,
                error: { ...result.error, details },
            },
            result.status ?? 400,
        );
    } catch (error) {
        return mapBackendError(error, logger);
    }
}
