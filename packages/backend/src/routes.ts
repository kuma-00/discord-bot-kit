import {
    type ApiFailure,
    type ApiResult,
    type HttpContract,
    parseSchema,
    type SchemaOutput,
    type StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";

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

/** Executes and validates a framework-neutral route definition. */
export async function executeRoute<
    TInputSchema extends StandardSchemaV1,
    TOutputSchema extends StandardSchemaV1,
    TErrorSchema extends StandardSchemaV1,
>(
    definition: RouteDefinition<TInputSchema, TOutputSchema, TErrorSchema>,
    request: Request,
    rawInput: unknown,
    params: Readonly<Record<string, string>> = {},
    logger?: BackendLogger,
): Promise<Response> {
    try {
        const input = (await parseSchema(
            definition.contract.input,
            rawInput,
            `${definition.contract.id}.input`,
        )) as SchemaOutput<TInputSchema>;
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
