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

/** Route handler result or value accepted by the backend executor. */
export type RouteHandler<TInput, TOutput, TError> = (
    context: RouteContext<TInput>,
) => ApiResult<TOutput, TError> | Promise<ApiResult<TOutput, TError>>;

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
            return jsonResult({ ok: true, data });
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
            400,
        );
    } catch (error) {
        return mapBackendError(error, logger);
    }
}

/** Options for API key authentication. */
export interface ApiKeyAuthOptions {
    readonly apiKey: string;
    readonly header?: string;
}

/** Checks an API key without exposing the configured value. */
export function authenticateApiKey(
    request: Request,
    options: ApiKeyAuthOptions,
): ApiFailure | undefined {
    const supplied = request.headers.get(options.header ?? "x-api-key");
    if (supplied === options.apiKey) return undefined;
    return {
        ok: false,
        error: {
            code: "unauthorized",
            message: "Unauthorized",
        },
    };
}

/** Returns a standard health response. */
export function healthResponse(
    service: string,
    now: () => Date = () => new Date(),
): Response {
    return Response.json({
        ok: true,
        data: {
            service,
            status: "ok",
            timestamp: now().toISOString(),
        },
    });
}

/** Message accepted by the in-memory SSE event broker. */
export interface BrokerEvent {
    readonly id: string;
    readonly type?: string;
    readonly data: unknown;
    readonly retry?: number;
}

function encodeSse(event: BrokerEvent): Uint8Array {
    const lines = [
        `id: ${event.id}`,
        ...(event.type ? [`event: ${event.type}`] : []),
        ...(event.retry === undefined ? [] : [`retry: ${event.retry}`]),
        ...JSON.stringify(event.data)
            .split("\n")
            .map((line) => `data: ${line}`),
        "",
        "",
    ];
    return new TextEncoder().encode(lines.join("\n"));
}

/** In-memory fan-out broker suitable for one backend process. */
export class SseEventBroker {
    private readonly subscribers = new Set<
        ReadableStreamDefaultController<Uint8Array>
    >();

    /** Publishes an event to all active subscribers. */
    publish(event: BrokerEvent): void {
        const encoded = encodeSse(event);
        for (const subscriber of this.subscribers) {
            try {
                subscriber.enqueue(encoded);
            } catch {
                this.subscribers.delete(subscriber);
            }
        }
    }

    /** Opens an SSE response and removes it when the request is aborted. */
    response(signal?: AbortSignal): Response {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
            start: (value) => {
                controller = value;
                this.subscribers.add(value);
            },
            cancel: () => {
                if (controller) this.subscribers.delete(controller);
            },
        });
        const close = () => {
            if (!controller) return;
            this.subscribers.delete(controller);
            try {
                controller.close();
            } catch {
                // The consumer may already have cancelled the stream.
            }
        };
        signal?.addEventListener("abort", close, { once: true });
        return new Response(stream, {
            headers: {
                "cache-control": "no-cache",
                connection: "keep-alive",
                "content-type": "text/event-stream; charset=utf-8",
            },
        });
    }
}

/** Generic persistence port for guild-scoped adapters. */
export interface GuildRepository<TGuild> {
    findById(guildId: string): Promise<TGuild | null>;
    save(guildId: string, guild: TGuild): Promise<void>;
}

/** Generic authorization port for guild-scoped operations. */
export interface GuildAuthorization {
    canAccess(userId: string, guildId: string): Promise<boolean>;
}
