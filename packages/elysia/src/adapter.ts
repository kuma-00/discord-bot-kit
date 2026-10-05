import {
    type ApiKeyAuthOptions,
    accessFailureResponse,
    authenticateApiKey,
    type BackendLogger,
    executeRoute,
    healthResponse,
    mapBackendError,
    type RouteDefinition,
    type SseEventBroker,
} from "@kuma-00/bot-kit-backend";
import type {
    AccessFailure,
    StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";
import { Elysia } from "elysia";

type AnyRouteDefinition = RouteDefinition<
    StandardSchemaV1,
    StandardSchemaV1,
    StandardSchemaV1
>;

/** Consumer-owned SSE response factory; authenticate and authorize before subscribing. */
export type SseResponseFactory = (context: {
    readonly request: Request;
    readonly params: Readonly<Record<string, string>>;
}) => Response | AccessFailure | Promise<Response | AccessFailure>;

/** Consumer access check limited to standard 401/403 failures; it does not inject route context. */
export type AccessCheck = (context: {
    readonly request: Request;
    readonly params: Readonly<Record<string, string>>;
}) => AccessFailure | undefined | Promise<AccessFailure | undefined>;

/** Options for creating an Elysia adapter application. */
export interface CreateElysiaAppOptions {
    readonly service: string;
    readonly routes?: ReadonlyArray<AnyRouteDefinition>;
    readonly apiKey?: ApiKeyAuthOptions;
    readonly healthPath?: string;
    /** Runs after API-key authentication, before HTTP execution or SSE subscription. */
    readonly authorize?: AccessCheck;
    readonly sse?: { readonly path: string } & (
        | { readonly broker: SseEventBroker; readonly responseFactory?: never }
        | {
              readonly responseFactory: SseResponseFactory;
              readonly broker?: never;
          }
    );
    readonly logger?: BackendLogger;
}

/** Creates an Elysia application backed by framework-neutral route definitions. */
export function createElysiaApp(options: CreateElysiaAppOptions): Elysia {
    const app = new Elysia();
    app.get(options.healthPath ?? "/healthz", () =>
        healthResponse(options.service),
    );

    for (const definition of options.routes ?? []) {
        app.route(
            definition.contract.method,
            definition.contract.path,
            async ({ request, body, query, params }) => {
                if (options.apiKey) {
                    const failure = authenticateApiKey(request, options.apiKey);
                    if (failure) return accessFailureResponse(failure);
                }
                try {
                    const denied = await options.authorize?.({
                        request,
                        params,
                    });
                    if (denied) return accessFailureResponse(denied);
                } catch (error) {
                    return mapBackendError(error, options.logger);
                }
                return executeRoute(
                    definition,
                    request,
                    definition.contract.requestBody?.encoding ===
                        "multipart/form-data"
                        ? { params, query }
                        : { params, query, body },
                    params,
                    options.logger,
                );
            },
            definition.contract.requestBody?.encoding === "multipart/form-data"
                ? { parse: "none" }
                : undefined,
        );
    }

    if (options.sse) {
        const sse = options.sse;
        app.get(sse.path, async ({ request, params }) => {
            if (options.apiKey) {
                const failure = authenticateApiKey(request, options.apiKey);
                if (failure) return accessFailureResponse(failure);
            }
            try {
                const denied = await options.authorize?.({ request, params });
                if (denied) return accessFailureResponse(denied);
                if (sse.responseFactory) {
                    const result = await sse.responseFactory({
                        request,
                        params,
                    });
                    return result instanceof Response
                        ? result
                        : accessFailureResponse(result);
                }
                return sse.broker.response(request.signal);
            } catch (error) {
                return mapBackendError(error, options.logger);
            }
        });
    }
    return app;
}
